import OpenAI from "openai";
import type { Stream } from "openai/streaming";
import type { ReasoningDetail } from "../db/schema/index.js";
import { listMessagesModels, streamMessages } from "./anthropic.js";
import { modelCatalog } from "./catalog.js";
import {
  LLMError,
  MODEL_USER_AGENT,
  asLlmError,
  assistantMetadata,
  assistantPayload,
  completionTimeoutMs,
  providerForModel,
  reasoningEffortForModel,
  type ModelEvent,
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
 * The models the key lists: the probe a save runs, and the local endpoint's catalog. A rejected
 * key fails; the listed ids come back.
 */
export async function listProviderModels(
  provider: ProviderDef,
  options: { apiKey: string; baseURL?: string | null; fetch?: typeof fetch; timeoutMs?: number },
): Promise<string[]> {
  const key = options.apiKey.trim();
  if (!key && provider.id !== "local") {
    throw new LLMError("api_key is required");
  }
  const base = (options.baseURL ?? provider.baseURL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new LLMError(`${provider.label} needs a base URL`);
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (provider.api === "messages") {
    return listMessagesModels(provider, {
      apiKey: key,
      baseURL: base,
      timeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  const fetchFn = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${base}/models`, {
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "User-Agent": MODEL_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
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
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
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

/** The Chat Completions body a provider takes: the fields in its row, and `temperature` only when the catalog says the model takes one. */
export function completionRequestBody(options: {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  thinking_level?: string;
}): ChatCompletionsBody {
  const { provider, upstream } = providerForModel(options.model);
  const openrouter = provider.id === "openrouter";
  const body: ChatCompletionsBody = {
    model: upstream,
    messages: openrouter ? applyPromptCacheControl(options.messages) : options.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (modelCatalog.entry(options.model)?.temperature !== false) {
    body.temperature = options.temperature;
  }
  if (provider.id === "openai") {
    body.max_completion_tokens = options.max_tokens;
  } else {
    body.max_tokens = options.max_tokens;
  }
  if (openrouter) {
    body.cache_control = PROMPT_CACHE_CONTROL;
  }
  const effort = reasoningEffortForModel(options.model, options.thinking_level ?? "none");
  if (effort) {
    if (openrouter) {
      body.reasoning = { effort };
    } else {
      body.reasoning_effort = effort;
    }
  }
  if (options.tools && options.tools.length) {
    body.tools = options.tools;
  }
  if (options.tool_choice !== undefined && options.tool_choice !== null) {
    body.tool_choice = options.tool_choice;
  }
  return body;
}

export async function* streamCompletion(options: {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  signal?: AbortSignal;
  baseURL?: string;
  apiKey?: string;
  thinking_level?: string;
}): AsyncGenerator<ModelEvent> {
  const { provider } = providerForModel(options.model);
  const baseURL = options.baseURL ?? provider.baseURL;
  if (!baseURL) {
    throw new LLMError(`${provider.label} needs a base URL`);
  }
  if (options.apiKey === undefined) {
    throw new LLMError(`${provider.label} is not connected`);
  }
  if (provider.api === "messages") {
    yield* streamMessages({ ...options, baseURL, apiKey: options.apiKey });
    return;
  }
  const apiKey = options.apiKey.trim() || "local";
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: completionTimeoutMs(options.max_tokens),
    maxRetries: 0,
    defaultHeaders: { "User-Agent": MODEL_USER_AGENT },
  });
  const started = performance.now();
  const body = completionRequestBody(options);
  let stream: Stream<unknown>;
  try {
    // The body carries fields the SDK's request type does not name, so it goes through `post`, which
    // `chat.completions.create` calls too. `stream: true` makes the SDK answer with a Stream; each
    // chunk is parsed below.
    stream = await client.post<Stream<unknown>>("/chat/completions", {
      body,
      stream: true,
      signal: options.signal,
    });
  } catch (error) {
    throw asLlmError(error, apiKey);
  }
  let received = false;
  let content = "";
  let reasoning = "";
  const reasoningDetails: ReasoningDetail[] = [];
  const toolCalls: ToolCallAcc[] = [];
  let finishReason: string | null = null;
  let responseId: string | null = null;
  let servedModel: string | null = null;
  let usage: ProviderUsage = {};
  try {
    for await (const raw of stream) {
      received = true;
      const chunk = parseCompletionChunk(raw);
      responseId = chunk.id ?? responseId;
      servedModel = chunk.model ?? servedModel;
      applyReasoningDetailDelta(reasoningDetails, chunk.reasoningDetails);
      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        yield ["reasoning", chunk.reasoning];
      }
      if (chunk.text) {
        content += chunk.text;
        yield ["delta", chunk.text];
      }
      applyToolCallDelta(toolCalls, chunk.toolCalls);
      finishReason = chunk.finishReason ?? finishReason;
      usage = chunk.usage ?? usage;
    }
  } catch (error) {
    throw asLlmError(error, apiKey);
  }
  if (!received) {
    throw new LLMError("provider returned no chunks");
  }
  const payload = assistantPayload(
    content,
    toolCalls.map((call) => ({
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
          id: responseId,
          model: servedModel,
          usage,
          finish_reason: finishReason,
          reasoning,
          reasoning_details: reasoningDetails.filter((detail) => detail !== undefined),
        },
        { latencyMs, model: options.model },
      ),
    },
  ];
}
