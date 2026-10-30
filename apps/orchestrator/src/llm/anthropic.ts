import Anthropic from "@anthropic-ai/sdk";
import { modelCatalog } from "./catalog.js";
import {
  LISTING_TIMEOUT_MS,
  LLMError,
  MODEL_USER_AGENT,
  asLlmError,
  assistantMetadata,
  assistantPayload,
  completionTimeoutMs,
  providerForModel,
  reasoningEffortForModel,
  type ModelEndpoint,
  type ModelEvent,
  type ModelListingServices,
  type ModelRequest,
} from "./completion.js";
import { isPlainObject } from "./payload.js";
import type { ProviderDef } from "./providers.js";

// A provider on Anthropic's Messages API. The run speaks OpenAI-style messages; a request is
// translated into a Messages API body, and the response comes back as the same events and the
// same assembled assistant payload every other provider yields.

type UserBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;
type ImageMediaType = Anthropic.Base64ImageSource["media_type"];

const PROMPT_CACHE_CONTROL = { type: "ephemeral" } as const;
const EMPTY_INPUT_SCHEMA: Anthropic.Tool.InputSchema = { type: "object", properties: {} };

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

/** A tool's parameters as the Messages API takes them: an object schema whose required names are strings. */
function isInputSchema(schema: Record<string, unknown>): schema is Anthropic.Tool.InputSchema {
  const required = schema.required;
  return (
    schema.type === "object" &&
    (required === undefined ||
      required === null ||
      (Array.isArray(required) && required.every((name) => typeof name === "string")))
  );
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

/** The text and image blocks of an OpenAI content value: a string, or a list of parts. */
function contentBlocks(content: unknown): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part: unknown): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> => {
    if (!isPlainObject(part)) {
      return [];
    }
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      return [{ type: "text", text: part.text }];
    }
    const image = isPlainObject(part.image_url) ? part.image_url : null;
    if (part.type !== "image_url" || typeof image?.url !== "string") {
      return [];
    }
    const block = imageBlock(image.url);
    return block ? [block] : [];
  });
}

function toolUseInput(args: unknown): Record<string, unknown> {
  if (typeof args !== "string" || !args.trim()) {
    return {};
  }
  try {
    const input: unknown = JSON.parse(args);
    return isPlainObject(input) ? input : {};
  } catch {
    return {};
  }
}

function assistantBlocks(message: Record<string, unknown>): Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> {
  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = contentBlocks(message.content).filter(
    (block): block is Anthropic.TextBlockParam => block.type === "text",
  );
  const calls: unknown[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
    if (!isPlainObject(call) || typeof call.id !== "string" || typeof fn?.name !== "string") {
      continue;
    }
    blocks.push({ type: "tool_use", id: call.id, name: fn.name, input: toolUseInput(fn.arguments) });
  }
  return blocks;
}

function toolResultBlock(message: Record<string, unknown>): Anthropic.ToolResultBlockParam {
  const content = contentBlocks(message.content);
  return {
    type: "tool_result",
    tool_use_id: String(message.tool_call_id ?? ""),
    ...(content.length ? { content } : {}),
  };
}

/**
 * OpenAI-style history as a Messages API conversation. The leading system messages become
 * `system`; a later one is a user turn. Tool results are user turns, and consecutive turns of one
 * role are merged, so each assistant turn's tool results reach the model together.
 */
export function messagesFromHistory(history: Array<Record<string, unknown>>): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
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
    const role = message.role;
    if (role === "system" && leading) {
      system.push(...contentBlocks(message.content).filter((block): block is Anthropic.TextBlockParam => block.type === "text"));
      continue;
    }
    leading = false;
    if (role === "assistant") {
      append("assistant", assistantBlocks(message));
    } else if (role === "tool") {
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
function messagesTool(raw: unknown): Anthropic.Tool | null {
  const fn = isPlainObject(raw) && isPlainObject(raw.function) ? raw.function : null;
  if (typeof fn?.name !== "string") {
    return null;
  }
  const parameters = isPlainObject(fn.parameters) ? fn.parameters : EMPTY_INPUT_SCHEMA;
  if (!isInputSchema(parameters)) {
    throw new LLMError(`tool ${fn.name} has parameters that are not an object schema`);
  }
  return {
    name: fn.name,
    ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}),
    input_schema: parameters,
  };
}

/** An OpenAI `tool_choice` as a Messages API one; null when it names nothing the API knows. */
function messagesToolChoice(choice: unknown): Anthropic.ToolChoice | null {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  const fn = isPlainObject(choice) && isPlainObject(choice.function) ? choice.function : null;
  return typeof fn?.name === "string" ? { type: "tool", name: fn.name } : null;
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
  const { upstream } = providerForModel(request.model);
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
  const tools = (request.tools ?? []).map(messagesTool).filter((tool): tool is Anthropic.Tool => tool !== null);
  if (tools.length) {
    body.tools = tools;
  }
  const choice = request.tool_choice === undefined || request.tool_choice === null ? null : messagesToolChoice(request.tool_choice);
  if (choice) {
    body.tool_choice = choice;
  }
  return body;
}

const FINISH_REASONS: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
};

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
  const cacheRead = message.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
  yield [
    "done",
    {
      payload,
      metadata: assistantMetadata(
        {
          id: message.id,
          model: message.model,
          usage: {
            prompt_tokens: message.usage.input_tokens + cacheRead + cacheWrite,
            completion_tokens: message.usage.output_tokens,
            cache_read_input_tokens: cacheRead,
          },
          finish_reason: FINISH_REASONS[message.stop_reason ?? ""] ?? "stop",
          provider_request_id: requestId,
          reasoning,
        },
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
    if (error instanceof Anthropic.APIError && typeof error.status === "number") {
      throw new LLMError(`${provider.label} did not accept the key (${error.status})`);
    }
    throw asLlmError(error, endpoint.apiKey);
  }
  return ids;
}
