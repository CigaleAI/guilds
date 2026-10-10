import OpenAI from "openai";
import { modelCatalog } from "./catalog.js";
import { catalogCostUsd } from "./cost.js";
import { parseModelId, type ProviderDef } from "./providers.js";

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

function asLlmError(error: unknown, apiKey?: string | null): LLMError {
  if (error instanceof LLMError) {
    error.message = redactApiKey(error.message, apiKey);
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LLMError(redactApiKey(message, apiKey));
}

export type Completion = {
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type ModelEvent = ["delta", string] | ["reasoning", string] | ["done", Completion];

export type ReasoningDetail = Record<string, unknown> & { index?: number };

export const MODEL_USER_AGENT = "guilds.run";

export function redactApiKey(text: string, apiKey?: string | null): string {
  const key = (apiKey ?? "").trim();
  if (!key) {
    return text;
  }
  return text.split(key).join("[REDACTED:API_KEY]");
}

/** The provider a stored model id names, and the id the provider knows the model by. */
export function providerForModel(model: string): { provider: ProviderDef; upstream: string } {
  const parsed = parseModelId(model);
  if (!parsed) {
    throw new LLMError("model must be {provider}/{model}");
  }
  return { provider: parsed.provider, upstream: parsed.model };
}

/** Kimi Code documents `low` / `high` / `max`; the picker is `none` / `low` / `medium` / `high`. */
export function reasoningEffortForModel(model: string, level: string): string | null {
  if (!level || level === "none" || level === "off") {
    return null;
  }
  if (model.startsWith("kimi/")) {
    if (level === "low") {
      return "low";
    }
    if (level === "medium") {
      return "high";
    }
    if (level === "high") {
      return "max";
    }
    return null;
  }
  return level;
}

/**
 * `GET {baseURL}/models` with the key: the probe a save runs, and the local endpoint's catalog.
 * A rejected key fails; the listed ids come back.
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
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
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
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : [];
  return rows.flatMap((row) => {
    const id = row && typeof row === "object" ? (row as { id?: unknown }).id : row;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function assistantPayload(message: Record<string, unknown>): Record<string, unknown> {
  const dump: Record<string, unknown> = {};
  if (message.role !== null && message.role !== undefined) {
    dump.role = message.role;
  }
  if (message.content !== null && message.content !== undefined) {
    dump.content = message.content;
  }
  if (message.tool_calls !== null && message.tool_calls !== undefined) {
    dump.tool_calls = message.tool_calls;
  }
  if (!dump || typeof dump !== "object" || Array.isArray(dump)) {
    throw new LLMError("assistant payload must be an object");
  }
  return dump;
}

export function assistantMetadata(
  assembled: {
    id?: unknown;
    model?: unknown;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cache_read_input_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      cost?: number;
    };
    finish_reason?: unknown;
    provider_request_id?: unknown;
    provider_cost?: unknown;
    reasoning?: string;
    reasoning_details?: ReasoningDetail[];
  },
  options: { latencyMs: number; model: string },
): Record<string, unknown> {
  const usage = assembled.usage ?? {};
  const details = usage.prompt_tokens_details;
  let cacheRead = usage.cache_read_input_tokens;
  if (cacheRead === undefined || cacheRead === null) {
    cacheRead = details?.cached_tokens || 0;
  }
  const tokenUsage = {
    input_tokens: Number(usage.prompt_tokens || 0),
    output_tokens: Number(usage.completion_tokens || 0),
    cache_read_tokens: Number(cacheRead || 0),
  };
  let cost: number | null = null;
  let costSource: string | undefined;
  if (typeof assembled.provider_cost === "number") {
    cost = assembled.provider_cost;
    costSource = "provider";
  } else if (typeof usage.cost === "number") {
    cost = usage.cost;
    costSource = "provider";
  }
  const metadata: Record<string, unknown> = {
    usage: tokenUsage,
    latency_ms: options.latencyMs,
    finish_reason: assembled.finish_reason || "stop",
    model: optionalString(assembled.model) || "",
    response_id: optionalString(assembled.id),
    provider_request_id: optionalString(assembled.provider_request_id),
  };
  if (cost === null) {
    const fallback = catalogCostUsd(options.model, tokenUsage);
    metadata.cost_usd = fallback.cost_usd;
    metadata.cost_source = fallback.cost_source;
    metadata.pricing_version = fallback.pricing_version;
  } else {
    metadata.cost_usd = cost;
    metadata.cost_source = costSource;
  }
  if (assembled.reasoning) {
    metadata.reasoning = assembled.reasoning;
  }
  if (assembled.reasoning_details?.length) {
    metadata.reasoning_details = assembled.reasoning_details;
  }
  return metadata;
}

const REASONING_TEXT_KEYS = ["text", "summary", "data"] as const;

function reasoningTextOf(detail: ReasoningDetail): string {
  const text = detail.text ?? detail.summary;
  return typeof text === "string" ? text : "";
}

export function applyReasoningDetailDelta(acc: ReasoningDetail[], delta: ReasoningDetail[]): void {
  for (const part of delta) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const index = typeof part.index === "number" ? part.index : acc.length;
    const current = acc[index];
    if (current === undefined) {
      acc[index] = { ...part };
      continue;
    }
    for (const [key, value] of Object.entries(part)) {
      if ((REASONING_TEXT_KEYS as readonly string[]).includes(key) && typeof value === "string") {
        const previous = current[key];
        current[key] = (typeof previous === "string" ? previous : "") + value;
      } else {
        current[key] = value;
      }
    }
  }
}

type ToolCallAcc = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

function applyToolCallDelta(
  acc: ToolCallAcc[],
  delta: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>,
): void {
  for (const part of delta) {
    const index = part.index ?? 0;
    const current = acc[index] ?? {};
    if (part.id) {
      current.id = part.id;
    }
    if (part.type) {
      current.type = part.type;
    }
    if (part.function) {
      current.function = current.function ?? { name: "", arguments: "" };
      if (part.function.name) {
        current.function.name = (current.function.name ?? "") + part.function.name;
      }
      if (part.function.arguments) {
        current.function.arguments = (current.function.arguments ?? "") + part.function.arguments;
      }
    }
    acc[index] = current;
  }
}

export function completionTimeoutMs(maxTokens: number): number {
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1;
  return Math.min(600_000, Math.max(120_000, Math.ceil(tokens * 25)));
}

const PROMPT_CACHE_CONTROL = { type: "ephemeral" } as const;

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
    if (Array.isArray(content)) {
      for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = content[partIndex];
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          continue;
        }
        const row = part as Record<string, unknown>;
        if (row.type !== "text" || typeof row.text !== "string" || !row.text) {
          continue;
        }
        const parts = content.slice() as Array<Record<string, unknown>>;
        parts[partIndex] = { ...row, cache_control: PROMPT_CACHE_CONTROL };
        const next = messages.slice();
        next[i] = { ...messages[i], content: parts };
        return next;
      }
    }
  }
  return messages;
}

/** The request body a provider takes: the fields in its row, and `temperature` only when the catalog says the model takes one. */
export function completionRequestBody(options: {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  thinking_level?: string;
}): Record<string, unknown> {
  const { provider, upstream } = providerForModel(options.model);
  const openrouter = provider.id === "openrouter";
  const body: Record<string, unknown> = {
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
  type StreamUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_input_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cost?: number;
  };
  let stream: AsyncIterable<{
    id?: string;
    model?: string;
    choices?: Array<{
      delta?: {
        content?: string | null;
        tool_calls?: unknown[];
        reasoning?: string | null;
        reasoning_content?: string | null;
        reasoning_details?: ReasoningDetail[] | null;
      };
      finish_reason?: string | null;
    }>;
    usage?: StreamUsage;
  }>;
  try {
    stream = (await client.chat.completions.create(body as never, {
      signal: options.signal,
    })) as unknown as typeof stream;
  } catch (error) {
    throw asLlmError(error, apiKey);
  }
  const chunks: Array<Record<string, unknown>> = [];
  let content = "";
  let reasoning = "";
  const reasoningDetails: ReasoningDetail[] = [];
  const toolCalls: ToolCallAcc[] = [];
  let finishReason: string | null = null;
  let responseId: string | undefined;
  let servedModel: string | undefined;
  let usage: StreamUsage = {};
  let providerRequestId: string | null = null;
  try {
    for await (const chunk of stream) {
      const raw = chunk as unknown as Record<string, unknown>;
      chunks.push(raw);
      if (typeof chunk.id === "string" && chunk.id) {
        responseId = chunk.id;
      }
      if (typeof chunk.model === "string" && chunk.model) {
        servedModel = chunk.model;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const detailDelta = delta?.reasoning_details;
      if (Array.isArray(detailDelta) && detailDelta.length) {
        applyReasoningDetailDelta(reasoningDetails, detailDelta);
      }
      const thought =
        delta?.reasoning ??
        delta?.reasoning_content ??
        (Array.isArray(detailDelta) ? detailDelta.map(reasoningTextOf).join("") : "");
      if (typeof thought === "string" && thought) {
        reasoning += thought;
        yield ["reasoning", thought];
      }
      const text = delta?.content;
      if (typeof text === "string" && text) {
        content += text;
        yield ["delta", text];
      }
      const toolDelta = delta?.tool_calls;
      if (Array.isArray(toolDelta) && toolDelta.length) {
        applyToolCallDelta(toolCalls, toolDelta as never);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        usage = chunk.usage as typeof usage;
      }
    }
  } catch (error) {
    throw asLlmError(error, apiKey);
  }
  try {
    const response = (stream as { response?: Response }).response
      ?? (stream as { controller?: { response?: Response } }).controller?.response;
    const headerId = response?.headers?.get("x-request-id")
      ?? response?.headers?.get("llm_provider-request-id");
    if (headerId) {
      providerRequestId = headerId;
    }
  } catch {
    providerRequestId = null;
  }
  if (!chunks.length) {
    throw new LLMError("provider returned no chunks");
  }
  const message: Record<string, unknown> = { role: "assistant" };
  if (content) {
    message.content = content;
  } else {
    message.content = content;
  }
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: call.type ?? "function",
      function: {
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "",
      },
    }));
  }
  let payload: Record<string, unknown>;
  try {
    payload = assistantPayload(message);
  } catch (error) {
    throw error instanceof LLMError ? error : new LLMError("provider response could not be assembled");
  }
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
          provider_request_id: providerRequestId,
          provider_cost: typeof usage.cost === "number" ? usage.cost : undefined,
          reasoning,
          reasoning_details: reasoningDetails.filter((detail) => detail !== undefined),
        },
        { latencyMs, model: options.model },
      ),
    },
  ];
}
