import OpenAI from "openai";
import type { Stream } from "openai/streaming";
import type { ReasoningDetail } from "../db/schema/index.js";
import { listMessagesModels, streamMessages } from "./anthropic.js";
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
  type ProviderUsage,
} from "./completion.js";
import { isPlainObject, optionalString } from "./payload.js";
import type { ProviderDef } from "./providers.js";

/** The ids a `/models` listing names: a list, or OpenAI's `{ data: [...] }`, of ids or of rows with an `id`. */
function modelIdsOf(body: unknown): string[] {
  const rows: unknown[] = Array.isArray(body) ? body : isPlainObject(body) && Array.isArray(body.data) ? body.data : [];
  return rows.flatMap((row) => {
    const id = isPlainObject(row) ? row.id : row;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
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
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return modelIdsOf(body);
}

const REASONING_TEXT_KEYS: ReadonlySet<string> = new Set(["text", "summary", "data"]);

function reasoningTextOf(detail: ReasoningDetail): string {
  const text = detail.text ?? detail.summary;
  return typeof text === "string" ? text : "";
}

export function applyReasoningDetailDelta(acc: ReasoningDetail[], delta: ReasoningDetail[]): void {
  for (const part of delta) {
    const index = part.index ?? acc.length;
    const current = acc[index];
    if (current === undefined) {
      acc[index] = { ...part };
      continue;
    }
    for (const [key, value] of Object.entries(part)) {
      if (REASONING_TEXT_KEYS.has(key) && typeof value === "string") {
        const previous = current[key];
        current[key] = (typeof previous === "string" ? previous : "") + value;
      } else {
        current[key] = value;
      }
    }
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

function isReasoningDetail(value: unknown): value is ReasoningDetail {
  return isPlainObject(value) && (value.index === undefined || typeof value.index === "number");
}

function toolCallDeltaOf(part: unknown): ToolCallDelta[] {
  if (!isPlainObject(part)) {
    return [];
  }
  const fn = isPlainObject(part.function) ? part.function : {};
  return [
    {
      // A server that streams a single tool call may leave out its index.
      index: typeof part.index === "number" ? part.index : 0,
      id: typeof part.id === "string" ? part.id : "",
      type: typeof part.type === "string" ? part.type : "",
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    },
  ];
}

/** The usage fields a chunk reports: OpenAI's, and the cache read and cost that OpenRouter adds. */
function providerUsageOf(usage: Record<string, unknown>): ProviderUsage {
  const parsed: ProviderUsage = {};
  if (typeof usage.prompt_tokens === "number") {
    parsed.prompt_tokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    parsed.completion_tokens = usage.completion_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    parsed.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  const details = usage.prompt_tokens_details;
  if (isPlainObject(details) && typeof details.cached_tokens === "number") {
    parsed.prompt_tokens_details = { cached_tokens: details.cached_tokens };
  }
  if (typeof usage.cost === "number") {
    parsed.cost = usage.cost;
  }
  return parsed;
}

/**
 * The reasoning a delta carries: `reasoning` (OpenRouter), else `reasoning_content` (DeepSeek and
 * vLLM-style servers), else the text of its reasoning details.
 */
function reasoningOfDelta(delta: Record<string, unknown>, details: ReasoningDetail[]): string {
  const thought = delta.reasoning ?? delta.reasoning_content ?? details.map(reasoningTextOf).join("");
  return typeof thought === "string" ? thought : "";
}

/** A stream chunk read into named fields; a field the chunk lacks or holds in another shape is empty. */
export function parseCompletionChunk(chunk: unknown): CompletionChunk {
  const root = isPlainObject(chunk) ? chunk : {};
  const choices: unknown[] = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0];
  const choice = isPlainObject(first) ? first : {};
  const delta = isPlainObject(choice.delta) ? choice.delta : {};
  const details: unknown[] = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
  const reasoningDetails = details.filter(isReasoningDetail);
  const toolCalls: unknown[] = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  return {
    id: optionalString(root.id),
    model: optionalString(root.model),
    text: typeof delta.content === "string" ? delta.content : "",
    reasoning: reasoningOfDelta(delta, reasoningDetails),
    reasoningDetails,
    toolCalls: toolCalls.flatMap(toolCallDeltaOf),
    finishReason: optionalString(choice.finish_reason),
    usage: isPlainObject(root.usage) ? providerUsageOf(root.usage) : null,
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

const PROMPT_CACHE_CONTROL = { type: "ephemeral" } as const;

/** The parts with their last non-empty text part marked for the prompt cache; null when none is text. */
function cacheLastTextPart(parts: unknown[]): unknown[] | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (isPlainObject(part) && part.type === "text" && typeof part.text === "string" && part.text) {
      const next = parts.slice();
      next[index] = { ...part, cache_control: PROMPT_CACHE_CONTROL };
      return next;
    }
  }
  return null;
}

export function applyPromptCacheControl(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === "string" && content) {
      const next = messages.slice();
      next[i] = {
        ...messages[i],
        content: [{ type: "text", text: content, cache_control: PROMPT_CACHE_CONTROL }],
      };
      return next;
    }
    const parts = Array.isArray(content) ? cacheLastTextPart(content) : null;
    if (parts) {
      const next = messages.slice();
      next[i] = { ...messages[i], content: parts };
      return next;
    }
  }
  return messages;
}

/** The Chat Completions body a call sends: OpenAI's streaming fields, and the ones OpenRouter adds. */
export type ChatCompletionsBody = {
  model: string;
  messages: Array<Record<string, unknown>>;
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
  const { provider, upstream } = providerForModel(request.model);
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
  let stream: Stream<unknown>;
  try {
    // The body carries fields the SDK's request type does not name, so it goes through `post`, which
    // `chat.completions.create` calls too. `stream: true` makes the SDK answer with a Stream; each
    // chunk is parsed below.
    stream = await client.post<Stream<unknown>>("/chat/completions", {
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
