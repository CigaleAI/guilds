import OpenAI from "openai";
import { MODEL_PROVIDER_INTEGRATIONS, integrationVariable } from "../instance/integrations.js";
import {
  PROVIDER_BASE_URLS,
  isProvider,
  missingOrgKeyMessage,
  PROVIDER_LABELS,
  providerNameForModel,
  providerRequiresOrgKey,
} from "./catalog.js";
import { catalogCostUsd } from "./cost.js";

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

export function apiKeyForModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  orgKey?: string | null,
): string {
  const connected = (orgKey ?? "").trim();
  if (connected) {
    return connected;
  }
  const provider = providerNameForModel(model);
  if (!provider) {
    throw new LLMError("model must start with a catalog provider prefix");
  }
  if (providerRequiresOrgKey(provider)) {
    throw new LLMError(missingOrgKeyMessage(provider));
  }
  const integration = MODEL_PROVIDER_INTEGRATIONS[provider];
  if (!integration) {
    throw new LLMError(missingOrgKeyMessage(provider));
  }
  const variable = integration.variables[0].name;
  const key = integrationVariable(integration, variable, env);
  if (!key) {
    throw new LLMError(`${variable} is not set`);
  }
  return key;
}

export function providerForModel(model: string): { baseURL: string; upstream: string } {
  const provider = providerNameForModel(model);
  if (!provider) {
    throw new LLMError("model must start with a catalog provider prefix");
  }
  return { baseURL: PROVIDER_BASE_URLS[provider], upstream: model.slice(`${provider}/`.length) };
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

export async function probeProviderKey(
  provider: string,
  apiKey: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  if (!isProvider(provider) || !providerRequiresOrgKey(provider)) {
    return;
  }
  const key = apiKey.trim();
  if (!key) {
    throw new LLMError("api_key is required");
  }
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = `${PROVIDER_BASE_URLS[provider]}/models`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": MODEL_USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw asLlmError(error, key);
  }
  if (!response.ok) {
    const label = PROVIDER_LABELS[provider];
    throw new LLMError(
      response.status === 401 || response.status === 403
        ? `${label} rejected the key`
        : `${label} did not accept the key (${response.status})`,
    );
  }
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

export async function* streamCompletion(options: {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  baseURL?: string;
  apiKey?: string;
  thinking_level?: string;
}): AsyncGenerator<ModelEvent> {
  const env = options.env ?? process.env;
  const { baseURL, upstream } = providerForModel(options.model);
  const apiKey = options.apiKey ?? apiKeyForModel(options.model, env);
  const client = new OpenAI({
    apiKey,
    baseURL: options.baseURL ?? baseURL,
    timeout: completionTimeoutMs(options.max_tokens),
    maxRetries: 0,
    defaultHeaders: { "User-Agent": MODEL_USER_AGENT },
  });
  const started = performance.now();
  const openrouter = options.model.startsWith("openrouter/");
  const body: Record<string, unknown> = {
    model: upstream,
    messages: openrouter ? applyPromptCacheControl(options.messages) : options.messages,
    temperature: options.temperature,
    max_tokens: options.max_tokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (openrouter) {
    body.cache_control = PROMPT_CACHE_CONTROL;
  }
  const effort = reasoningEffortForModel(options.model, options.thinking_level ?? "none");
  if (effort) {
    body.reasoning = { effort };
    body.reasoning_effort = effort;
  }
  if (options.tools && options.tools.length) {
    body.tools = options.tools;
  }
  if (options.tool_choice !== undefined && options.tool_choice !== null) {
    body.tool_choice = options.tool_choice;
  }
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
