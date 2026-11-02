import Anthropic from "@anthropic-ai/sdk";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, isObjectNode, type JsonObject, type JsonValue } from "../lib/json.js";
import { modelCatalog } from "./catalog.js";
import {
  LISTING_TIMEOUT_MS,
  LLMError,
  MODEL_USER_AGENT,
  PROMPT_CACHE_CONTROL,
  asLlmError,
  assistantMetadata,
  assistantPayload,
  completionTimeoutMs,
  providerForModel,
  reasoningEffortForModel,
  type AssembledCompletion,
  type ContentPart,
  type ModelEndpoint,
  type ModelEvent,
  type ModelListingServices,
  type ModelMessage,
  type ModelRequest,
} from "./completion.js";
import type { ProviderDef } from "./providers.js";

// A provider on Anthropic's Messages API. The run speaks OpenAI-style messages; a request is
// translated into a Messages API body, and the response comes back as the same events and the
// same assembled assistant payload every other provider yields.

type UserBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;
type ImageMediaType = Anthropic.Base64ImageSource["media_type"];

/** An assistant turn of the history, its content as text or as parts. */
type AssistantTurn = Extract<ModelMessage, { role: "assistant" }>;

/** A tool's result in the history. */
type ToolTurn = Extract<ModelMessage, { role: "tool" }>;

/** The history as a Messages API conversation: the leading system text, and the turns. */
type MessagesConversation = { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] };

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } satisfies JsonObject;

/** A tool's parameters as the Messages API takes them: an object schema, whose required names are strings when it lists them. */
const InputSchema = Type.Object({
  type: Type.Literal("object"),
  required: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});

/** The function an OpenAI tool schema defines, as far as the Messages API reads it: its name, and its description when it gives one. */
const FunctionTool = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String({ minLength: 1 })),
});

/** An OpenAI `tool_choice` the Messages API has a counterpart for: a mode, or the function it names. */
const ToolChoice = Type.Union([
  Type.Literal("auto"),
  Type.Literal("none"),
  Type.Literal("required"),
  Type.Object({ function: Type.Object({ name: Type.String() }) }),
]);
type ToolChoice = Static<typeof ToolChoice>;

// Keyed by every value the SDK names, so a value the SDK adds fails the typecheck until it is listed.
const IMAGE_MEDIA_TYPES: Record<ImageMediaType, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true,
};
const EFFORTS: Record<Effort, true> = { low: true, medium: true, high: true, xhigh: true, max: true };

function isImageMediaType(value: string): value is ImageMediaType {
  return Object.hasOwn(IMAGE_MEDIA_TYPES, value);
}

function isEffort(value: string): value is Effort {
  return Object.hasOwn(EFFORTS, value);
}

/** A Messages API client for a key: no retries, no credentials read from the environment. */
function messagesClient(endpoint: ModelEndpoint, timeoutMs: number, fetchFn?: typeof fetch): Anthropic {
  return new Anthropic({
    apiKey: endpoint.apiKey,
    authToken: null,
    baseURL: endpoint.baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
    defaultHeaders: { "User-Agent": MODEL_USER_AGENT },
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
}

/**
 * An OpenAI `image_url`: a data URL becomes a base64 source, an http(s) URL a URL source. A data URL
 * of a media type the API does not take fails the call.
 */
function imageBlock(url: string): Anthropic.ImageBlockParam | null {
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (inline) {
    const mediaType = inline[1] ?? "";
    if (!isImageMediaType(mediaType)) {
      throw new LLMError(`the Messages API does not take ${mediaType} images`);
    }
    return { type: "image", source: { type: "base64", media_type: mediaType, data: inline[2] ?? "" } };
  }
  return /^https?:\/\//.test(url) ? { type: "image", source: { type: "url", url } } : null;
}

/** The block of a content part: the text of a part that has some, the image of one the API can address. */
function partBlocks(part: ContentPart): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  if (part.type === "text") {
    return part.text ? [{ type: "text", text: part.text }] : [];
  }
  const block = imageBlock(part.image_url.url);
  return block ? [block] : [];
}

/** The text and image blocks of a message's content: its text, or its parts. */
function contentBlocks(content: ModelMessage["content"]): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  if (Array.isArray(content)) {
    return content.flatMap(partBlocks);
  }
  return content ? [{ type: "text", text: content }] : [];
}

/** The input a tool call's arguments give: their JSON object; none when they are empty or not an object. */
function toolUseInput(args: string): JsonObject {
  if (!args.trim()) {
    return {};
  }
  try {
    const input: JsonValue = JSON.parse(args);
    return isObjectNode(input) ? input : {};
  } catch {
    return {};
  }
}

function assistantBlocks(message: AssistantTurn): Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> {
  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = contentBlocks(message.content).filter(
    (block): block is Anthropic.TextBlockParam => block.type === "text",
  );
  for (const call of message.tool_calls ?? []) {
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: toolUseInput(call.function.arguments) });
  }
  return blocks;
}

function toolResultBlock(message: ToolTurn): Anthropic.ToolResultBlockParam {
  const content = contentBlocks(message.content);
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    ...(content.length ? { content } : {}),
  };
}

/**
 * OpenAI-style history as a Messages API conversation. The leading system messages become
 * `system`; a later one is a user turn. Tool results are user turns, and consecutive turns of one
 * role are merged, so each assistant turn's tool results reach the model together.
 */
export function messagesFromHistory(history: ModelMessage[]): MessagesConversation {
  const system: Anthropic.TextBlockParam[] = [];
  const messages: Anthropic.MessageParam[] = [];
  let leading = true;
  const append = (role: "user" | "assistant", blocks: Array<UserBlock | Anthropic.ToolUseBlockParam>) => {
    if (!blocks.length) {
      return;
    }
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: [...blocks] });
  };
  for (const message of history) {
    if (message.role === "system" && leading) {
      system.push(...contentBlocks(message.content).filter((block): block is Anthropic.TextBlockParam => block.type === "text"));
      continue;
    }
    leading = false;
    if (message.role === "assistant") {
      append("assistant", assistantBlocks(message));
    } else if (message.role === "tool") {
      append("user", [toolResultBlock(message)]);
    } else {
      append("user", contentBlocks(message.content));
    }
  }
  return { system, messages };
}

/**
 * An OpenAI tool schema as a Messages API tool; null when it names no function. Parameters that are
 * not an object take none; an object that is not an object schema fails the call.
 */
function messagesTool(tool: JsonObject): Anthropic.Tool | null {
  const definition = tool.function !== undefined && isObjectNode(tool.function) ? tool.function : null;
  const fn = definition && keepMatching(FunctionTool, definition);
  if (!definition || !fn) {
    return null;
  }
  const parameters = definition.parameters !== undefined && isObjectNode(definition.parameters) ? definition.parameters : EMPTY_INPUT_SCHEMA;
  if (!Value.Check(InputSchema, parameters)) {
    throw new LLMError(`tool ${fn.name} has parameters that are not an object schema`);
  }
  return {
    name: fn.name,
    ...(fn.description === undefined ? {} : { description: fn.description }),
    input_schema: parameters,
  };
}

/** An OpenAI `tool_choice` as the Messages API's. */
function messagesToolChoice(choice: ToolChoice): Anthropic.ToolChoice {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.function.name };
}

/** The Messages API effort a thinking level asks for; null for none. An effort the API does not take fails the call. */
function messagesEffort(model: string, level: string): Effort | null {
  const effort = reasoningEffortForModel(model, level);
  if (!effort) {
    return null;
  }
  if (!isEffort(effort)) {
    throw new LLMError(`the Messages API does not take the ${effort} effort`);
  }
  return effort;
}

/**
 * The Messages API body of a completion. A thinking level asks for adaptive thinking at that
 * effort, with its summary streamed; `temperature` is sent only without thinking, and only when
 * the catalog says the model takes one. The prompt is cached up to its last block.
 */
export function messagesRequestBody(request: ModelRequest): Anthropic.MessageStreamParams {
  const { model: upstream } = providerForModel(request.model);
  const { system, messages } = messagesFromHistory(request.messages);
  const body: Anthropic.MessageStreamParams = {
    model: upstream,
    max_tokens: request.max_tokens,
    messages,
    cache_control: PROMPT_CACHE_CONTROL,
  };
  if (system.length) {
    body.system = system;
  }
  const effort = messagesEffort(request.model, request.thinking_level ?? "none");
  if (effort) {
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort };
  } else if (modelCatalog.entry(request.model)?.temperature !== false) {
    body.temperature = request.temperature;
  }
  // The tools arrive as the run's offered schemas; one that is not a JSON object names no function.
  const tools = (request.tools ?? [])
    .filter(isJsonObject)
    .map(messagesTool)
    .filter((tool): tool is Anthropic.Tool => tool !== null);
  if (tools.length) {
    body.tools = tools;
  }
  if (Value.Check(ToolChoice, request.tool_choice)) {
    body.tool_choice = messagesToolChoice(request.tool_choice);
  }
  return body;
}

/** The Chat Completions name of each reason a Messages API message stops for. */
const FINISH_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
} satisfies Record<Anthropic.StopReason, NonNullable<ChatCompletionChunk.Choice["finish_reason"]>>;

/**
 * A finished Messages API message as the completion it assembles, before it is priced: the cache
 * reads and writes count as input, and the stop reason is named as OpenAI names it.
 */
function assembledMessage(message: Anthropic.Message, reasoning: string, requestId: string | null): AssembledCompletion {
  const cacheRead = message.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
  return {
    id: message.id,
    model: message.model,
    usage: {
      prompt_tokens: message.usage.input_tokens + cacheRead + cacheWrite,
      completion_tokens: message.usage.output_tokens,
      cache_read_input_tokens: cacheRead,
    },
    finish_reason: message.stop_reason === null ? "stop" : FINISH_REASONS[message.stop_reason],
    provider_request_id: requestId,
    reasoning,
  };
}

/**
 * A Messages API completion at `endpoint`, streamed as text and reasoning deltas and one assembled
 * assistant payload.
 */
export async function* streamMessages(
  request: ModelRequest,
  endpoint: ModelEndpoint,
  signal?: AbortSignal,
): AsyncGenerator<ModelEvent> {
  const apiKey = endpoint.apiKey.trim();
  const client = messagesClient({ ...endpoint, apiKey }, completionTimeoutMs(request.max_tokens));
  const started = performance.now();
  const body = messagesRequestBody(request);
  let reasoning = "";
  let message: Anthropic.Message;
  let requestId: string | null;
  try {
    const stream = client.messages.stream(body, { signal });
    for await (const event of stream) {
      if (event.type !== "content_block_delta") {
        continue;
      }
      if (event.delta.type === "text_delta" && event.delta.text) {
        yield ["delta", event.delta.text];
      } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
        reasoning += event.delta.thinking;
        yield ["reasoning", event.delta.thinking];
      }
    }
    message = await stream.finalMessage();
    requestId = stream.request_id ?? null;
  } catch (error) {
    throw asLlmError(error, apiKey);
  }
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const toolCalls = message.content.flatMap((block) =>
    block.type === "tool_use"
      ? [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
      : [],
  );
  const payload = assistantPayload(text, toolCalls);
  yield [
    "done",
    {
      payload,
      metadata: assistantMetadata(
        assembledMessage(message, reasoning, requestId),
        request.model,
        Math.trunc(performance.now() - started),
      ),
    },
  ];
}

/** The model ids a Messages API key lists at `endpoint`: the probe a save runs. A rejected key fails. */
export async function listMessagesModels(
  provider: ProviderDef,
  endpoint: ModelEndpoint,
  services: ModelListingServices = {},
): Promise<string[]> {
  const client = messagesClient(endpoint, services.timeoutMs ?? LISTING_TIMEOUT_MS, services.fetch);
  const ids: string[] = [];
  try {
    for await (const model of client.models.list({ limit: 1000 })) {
      ids.push(model.id);
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      throw new LLMError(`${provider.label} rejected the key`);
    }
    if (error instanceof Anthropic.APIError && error.status !== undefined) {
      throw new LLMError(`${provider.label} did not accept the key (${error.status})`);
    }
    throw asLlmError(error, endpoint.apiKey);
  }
  return ids;
}
