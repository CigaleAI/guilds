import { Type, type Static, type TObject } from "typebox";
import { Value } from "typebox/value";
import OpenAI from "openai";
import type { Stream } from "openai/streaming";
import { ReasoningDetailFields, type ReasoningDetail } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isObjectNode, type JsonObject, type JsonValue } from "../lib/json.js";
import { listMessagesModels, streamMessages } from "./anthropic.js";
import { modelCatalog } from "./catalog.js";
import {
  LISTING_TIMEOUT_MS,
  LLMError,
  MODEL_USER_AGENT,
  PROMPT_CACHE_CONTROL,
  ProviderUsage,
  asLlmError,
  assistantMetadata,
  assistantPayload,
  completionTimeoutMs,
  providerForModel,
  reasoningEffortForModel,
  type ContentPart,
  type ModelEndpoint,
  type ModelEvent,
  type ModelListingServices,
  type ModelMessage,
  type ModelRequest,
} from "./completion.js";
import type { ProviderDef } from "./providers.js";

/** A JSON value as an object; an empty one when it is not an object. */
function objectOf(value: JsonValue | undefined): JsonObject {
  return value !== undefined && isObjectNode(value) ? value : {};
}

/** The fields of a JSON object that `schema` describes, each one of another type left out; empty when `value` is not an object. */
function fieldsOf<T extends TObject>(schema: T, value: JsonValue | undefined): Partial<Static<T>> {
  return keepMatching(schema, objectOf(value)) ?? {};
}

/** The elements of a JSON list; none when `value` is not a list. */
function listOf(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** A row of a `/models` listing that names a model: OpenAI's model object, by its `id`. */
const ListedModel = Type.Object({ id: Type.String() });

/** Whether a row of a `/models` listing is a model's id: a string with something in it. */
function isListedId(row: JsonValue | undefined): row is string {
  return typeof row === "string" && row.trim() !== "";
}

/** The ids a `/models` listing names: a list, or OpenAI's `{ data: [...] }`, of ids or of rows with an `id`. */
function modelIdsOf(body: JsonValue): string[] {
  const rows = Array.isArray(body) ? body : isObjectNode(body) ? listOf(body.data) : [];
  return rows.flatMap((row) => {
    const id = Value.Check(ListedModel, row) ? row.id : row;
    return isListedId(id) ? [id.trim()] : [];
  });
}

/**
 * The models the key at `endpoint` lists: the probe a save runs, and the local endpoint's catalog.
 * A rejected key fails; the listed ids come back.
 */
export async function listProviderModels(
  provider: ProviderDef,
  endpoint: ModelEndpoint,
  services: ModelListingServices = {},
): Promise<string[]> {
  const key = endpoint.apiKey.trim();
  if (!key && provider.id !== "local") {
    throw new LLMError("api_key is required");
  }
  const base = (endpoint.baseURL ?? provider.baseURL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new LLMError(`${provider.label} needs a base URL`);
  }
  if (provider.api === "messages") {
    return listMessagesModels(provider, { apiKey: key, baseURL: base }, services);
  }
  return listChatCompletionsModels(provider, `${base}/models`, key, services);
}

/**
 * The model ids an OpenAI-style `/models` at `url` lists for `key`, sent as a bearer token when
 * there is one. A rejected key fails.
 */
async function listChatCompletionsModels(
  provider: ProviderDef,
  url: string,
  key: string,
  services: ModelListingServices,
): Promise<string[]> {
  const fetchFn = services.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "User-Agent": MODEL_USER_AGENT,
      },
      signal: AbortSignal.timeout(services.timeoutMs ?? LISTING_TIMEOUT_MS),
    });
  } catch (error) {
    throw asLlmError(error, key);
  }
  if (!response.ok) {
    throw new LLMError(
      response.status === 401 || response.status === 403
        ? `${provider.label} rejected the key`
        : `${provider.label} did not accept the key (${response.status})`,
    );
  }
  // A listing that is not JSON names no models.
  return (await listedModelIds(response)) ?? [];
}

/** The ids a `/models` response lists; null when its body is not JSON. */
async function listedModelIds(response: Response): Promise<string[] | null> {
  let body: JsonValue;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return null;
  }
  return modelIdsOf(body);
}

/** The fields of a reasoning block that each piece appends to; any other field a piece carries replaces the last one. */
const REASONING_TEXT_KEYS = ["text", "summary", "data"] as const;

function reasoningTextOf(detail: ReasoningDetail): string {
  return detail.text ?? detail.summary ?? "";
}

/** Folds streamed reasoning pieces into the blocks they extend: by their index, else as a block of their own. */
export function applyReasoningDetailDelta(acc: ReasoningDetail[], delta: ReasoningDetail[]): void {
  for (const part of delta) {
    const index = part.index ?? acc.length;
    const current = acc[index];
    if (current === undefined) {
      acc[index] = { ...part };
      continue;
    }
    const merged: ReasoningDetail = { ...current, ...part };
    for (const key of REASONING_TEXT_KEYS) {
      const added = part[key];
      if (added !== undefined) {
        merged[key] = (current[key] ?? "") + added;
      }
    }
    acc[index] = merged;
  }
}

/** A piece of one tool call, as a stream chunk carries it: the strings are appended to the call at `index`. */
export type ToolCallDelta = { index: number; id: string; type: string; name: string; arguments: string };

/** One Chat Completions stream chunk, read into the fields a completion assembles. */
export type CompletionChunk = {
  id: string | null;
  model: string | null;
  text: string;
  reasoning: string;
  reasoningDetails: ReasoningDetail[];
  toolCalls: ToolCallDelta[];
  finishReason: string | null;
  usage: ProviderUsage | null;
};

type ToolCallAcc = Omit<ToolCallDelta, "index">;

/** What a Chat Completions stream has assembled from the chunks read so far. */
type StreamedCompletion = {
  content: string;
  reasoning: string;
  reasoningDetails: ReasoningDetail[];
  toolCalls: ToolCallAcc[];
  finishReason: string | null;
  responseId: string | null;
  servedModel: string | null;
  usage: ProviderUsage;
};

function applyToolCallDelta(acc: ToolCallAcc[], delta: ToolCallDelta[]): void {
  for (const part of delta) {
    const current = acc[part.index] ?? { id: "", type: "", name: "", arguments: "" };
    current.id = part.id || current.id;
    current.type = part.type || current.type;
    current.name += part.name;
    current.arguments += part.arguments;
    acc[part.index] = current;
  }
}

/** What a Chat Completions chunk names of itself: the completion it is part of, and the model that served it. */
const ChunkHeader = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
});

/** What a chunk's choice carries beside its delta: why the completion finished, on the chunk that ends it. */
const ChunkChoice = Type.Object({ finish_reason: Type.Optional(Type.String({ minLength: 1 })) });

/**
 * The text a choice's delta streams: the answer, and the reasoning under the name its server gives
 * it, `reasoning` (OpenRouter) or `reasoning_content` (DeepSeek and vLLM-style servers).
 */
const DeltaText = Type.Object({
  content: Type.Optional(Type.String()),
  reasoning: Type.Optional(Type.String()),
  reasoning_content: Type.Optional(Type.String()),
});

/** A piece of one tool call: the call it extends, and the id and type the call's first piece names. */
const ToolCallPiece = Type.Object({
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  id: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
});

/** The text a tool call piece appends to the call's function: its name, and its arguments. */
const ToolCallFunctionPiece = Type.Object({
  name: Type.Optional(Type.String()),
  arguments: Type.Optional(Type.String()),
});

/** Whether a streamed reasoning piece is a block whose index, text, summary and data have the types a stream reads. */
function isReasoningDetail(value: JsonValue): value is ReasoningDetail {
  return isObjectNode(value) && Value.Check(ReasoningDetailFields, value);
}

/** A tool call piece of a delta; none when it is not an object. */
function toolCallDeltaOf(part: JsonValue): ToolCallDelta[] {
  if (!isObjectNode(part)) {
    return [];
  }
  const piece = fieldsOf(ToolCallPiece, part);
  const fn = fieldsOf(ToolCallFunctionPiece, part.function);
  return [
    {
      // A server that streams a single tool call may leave out its index.
      index: piece.index ?? 0,
      id: piece.id ?? "",
      type: piece.type ?? "",
      name: fn.name ?? "",
      arguments: fn.arguments ?? "",
    },
  ];
}

/**
 * A Chat Completions stream chunk, as the stream reads it, into named fields: a field the chunk
 * lacks or holds in another shape is empty. The reasoning is `reasoning`, else `reasoning_content`,
 * else the text of the delta's reasoning details.
 */
export function parseCompletionChunk(chunk: JsonValue): CompletionChunk {
  const root = objectOf(chunk);
  const header = fieldsOf(ChunkHeader, root);
  const choice = objectOf(listOf(root.choices)[0]);
  const delta = objectOf(choice.delta);
  const text = fieldsOf(DeltaText, delta);
  const reasoningDetails = listOf(delta.reasoning_details).filter(isReasoningDetail);
  return {
    id: header.id ?? null,
    model: header.model ?? null,
    text: text.content ?? "",
    reasoning: text.reasoning ?? text.reasoning_content ?? reasoningDetails.map(reasoningTextOf).join(""),
    reasoningDetails,
    toolCalls: listOf(delta.tool_calls).flatMap(toolCallDeltaOf),
    finishReason: fieldsOf(ChunkChoice, choice).finish_reason ?? null,
    usage: root.usage !== undefined && isObjectNode(root.usage) ? fieldsOf(ProviderUsage, root.usage) : null,
  };
}

/** Folds a chunk into what the stream has assembled: its text is appended, and a field it carries replaces the last one. */
function applyChunk(streamed: StreamedCompletion, chunk: CompletionChunk): void {
  streamed.responseId = chunk.id ?? streamed.responseId;
  streamed.servedModel = chunk.model ?? streamed.servedModel;
  applyReasoningDetailDelta(streamed.reasoningDetails, chunk.reasoningDetails);
  streamed.reasoning += chunk.reasoning;
  streamed.content += chunk.text;
  applyToolCallDelta(streamed.toolCalls, chunk.toolCalls);
  streamed.finishReason = chunk.finishReason ?? streamed.finishReason;
  streamed.usage = chunk.usage ?? streamed.usage;
}

/** The parts with their last non-empty text part marked for the prompt cache; null when none is text. */
function cacheLastTextPart(parts: ContentPart[]): ContentPart[] | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "text" && part.text) {
      const next = parts.slice();
      next[index] = { ...part, cache_control: PROMPT_CACHE_CONTROL };
      return next;
    }
  }
  return null;
}

/** A message's content as parts with its last text marked for the prompt cache; null when it has no text. */
function cachedContent(content: ModelMessage["content"]): ContentPart[] | null {
  if (Array.isArray(content)) {
    return cacheLastTextPart(content);
  }
  return content ? [{ type: "text", text: content, cache_control: PROMPT_CACHE_CONTROL }] : null;
}

/** The messages with the last one that has text marked for the prompt cache, up to its last text; the same list when none has. */
export function applyPromptCacheControl(messages: ModelMessage[]): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const content = message ? cachedContent(message.content) : null;
    if (message && content) {
      const next = messages.slice();
      next[i] = { ...message, content };
      return next;
    }
  }
  return messages;
}

/** The Chat Completions body a call sends: OpenAI's streaming fields, and the ones OpenRouter adds. */
export type ChatCompletionsBody = {
  model: string;
  messages: ModelMessage[];
  stream: true;
  stream_options: { include_usage: true };
  temperature?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
  cache_control?: typeof PROMPT_CACHE_CONTROL;
  reasoning?: { effort: string };
  reasoning_effort?: string;
  tools?: unknown[];
  tool_choice?: unknown;
};

/**
 * The fields of a body that each provider names its own way: the token limit (OpenAI's
 * `max_completion_tokens`), OpenRouter's prompt cache, and the reasoning effort.
 */
function providerFields(provider: ProviderDef, request: ModelRequest): Partial<ChatCompletionsBody> {
  const openrouter = provider.id === "openrouter";
  const fields: Partial<ChatCompletionsBody> =
    provider.id === "openai" ? { max_completion_tokens: request.max_tokens } : { max_tokens: request.max_tokens };
  if (openrouter) {
    fields.cache_control = PROMPT_CACHE_CONTROL;
  }
  const effort = reasoningEffortForModel(request.model, request.thinking_level ?? "none");
  if (effort && openrouter) {
    fields.reasoning = { effort };
  } else if (effort) {
    fields.reasoning_effort = effort;
  }
  return fields;
}

/** The Chat Completions body a provider takes: the fields in its row, and `temperature` only when the catalog says the model takes one. */
export function completionRequestBody(request: ModelRequest): ChatCompletionsBody {
  const { provider, model: upstream } = providerForModel(request.model);
  const body: ChatCompletionsBody = {
    model: upstream,
    messages: provider.id === "openrouter" ? applyPromptCacheControl(request.messages) : request.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (modelCatalog.entry(request.model)?.temperature !== false) {
    body.temperature = request.temperature;
  }
  Object.assign(body, providerFields(provider, request));
  if (request.tools && request.tools.length) {
    body.tools = request.tools;
  }
  if (request.tool_choice !== undefined && request.tool_choice !== null) {
    body.tool_choice = request.tool_choice;
  }
  return body;
}

/**
 * A completion from the provider the model id names, called with the key at `endpoint`, streamed as
 * text and reasoning deltas and one assembled assistant payload. `signal` aborts the call.
 */
export async function* streamCompletion(
  request: ModelRequest,
  endpoint: ModelEndpoint,
  signal?: AbortSignal,
): AsyncGenerator<ModelEvent> {
  const { provider } = providerForModel(request.model);
  const baseURL = endpoint.baseURL || provider.baseURL;
  if (!baseURL) {
    throw new LLMError(`${provider.label} needs a base URL`);
  }
  if (provider.api === "messages") {
    yield* streamMessages(request, { apiKey: endpoint.apiKey, baseURL }, signal);
    return;
  }
  const apiKey = endpoint.apiKey.trim() || "local";
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: completionTimeoutMs(request.max_tokens),
    maxRetries: 0,
    defaultHeaders: { "User-Agent": MODEL_USER_AGENT },
  });
  const started = performance.now();
  const body = completionRequestBody(request);
  let stream: Stream<JsonValue>;
  try {
    // The body carries fields the SDK's request type does not name, so it goes through `post`, which
    // `chat.completions.create` calls too. `stream: true` makes the SDK answer with a Stream of each
    // event's data as JSON; each chunk is parsed below.
    stream = await client.post<Stream<JsonValue>>("/chat/completions", {
      body,
      stream: true,
      signal,
    });
  } catch (error) {
    throw asLlmError(error, apiKey);
  }
  let received = false;
  const streamed: StreamedCompletion = {
    content: "",
    reasoning: "",
    reasoningDetails: [],
    toolCalls: [],
    finishReason: null,
    responseId: null,
    servedModel: null,
    usage: {},
  };
  try {
    for await (const raw of stream) {
      received = true;
      const chunk = parseCompletionChunk(raw);
      applyChunk(streamed, chunk);
      if (chunk.reasoning) {
        yield ["reasoning", chunk.reasoning];
      }
      if (chunk.text) {
        yield ["delta", chunk.text];
      }
    }
  } catch (error) {
    throw asLlmError(error, apiKey);
  }
  if (!received) {
    throw new LLMError("provider returned no chunks");
  }
  const payload = assistantPayload(
    streamed.content,
    streamed.toolCalls.map((call) => ({
      id: call.id,
      type: call.type || "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  );
  const latencyMs = Math.trunc(performance.now() - started);
  yield [
    "done",
    {
      payload,
      metadata: assistantMetadata(
        {
          id: streamed.responseId,
          model: streamed.servedModel,
          usage: streamed.usage,
          finish_reason: streamed.finishReason,
          reasoning: streamed.reasoning,
          reasoning_details: streamed.reasoningDetails.filter((detail) => detail !== undefined),
        },
        request.model,
        latencyMs,
      ),
    },
  ];
}
