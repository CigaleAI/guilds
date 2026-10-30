import type { AssistantMessage, CompletionMetadata, ReasoningDetail, ToolCall } from "../db/schema/index.js";
import { catalogCostUsd } from "./cost.js";
import { optionalString } from "./payload.js";
import { parseModelId, type ProviderDef } from "./providers.js";

// What a model call is on every provider's wire: the provider and the reasoning effort a model id
// names, the user agent the call sends, its timeout, its error, and the completion it returns.

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

export function asLlmError(error: unknown, apiKey?: string | null): LLMError {
  if (error instanceof LLMError) {
    error.message = redactApiKey(error.message, apiKey);
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LLMError(redactApiKey(message, apiKey));
}

export type Completion = {
  payload: AssistantMessage;
  metadata: CompletionMetadata;
};

export type ModelEvent = ["delta", string] | ["reasoning", string] | ["done", Completion];

/**
 * A completion asked of a model: the stored model id, the OpenAI-style messages and tools, the
 * sampling settings, and the thinking level.
 */
export type ModelRequest = {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  thinking_level?: string;
};

/** The key a provider is called with, and the base URL it is called at: the provider's own when absent. */
export type ModelEndpoint = {
  apiKey: string;
  baseURL?: string | null;
};

/** What a provider's model listing is fetched through, and how long it may take; a ten-second timeout when absent. */
export type ModelListingServices = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export const LISTING_TIMEOUT_MS = 10_000;

/** The token counts and the price a provider reports for one completion. */
export type ProviderUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
};

/** A completion as a provider's response assembled it, before it is priced. */
export type AssembledCompletion = {
  id?: string | null;
  model?: string | null;
  usage?: ProviderUsage;
  finish_reason?: string | null;
  provider_request_id?: string | null;
  provider_cost?: number;
  reasoning?: string;
  reasoning_details?: ReasoningDetail[];
};

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

/** The assistant message a completion returns: its text, and its tool calls when it made any. */
export function assistantPayload(content: string, toolCalls: ToolCall[]): AssistantMessage {
  return { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

/** What a completion records: its usage, its cost on the stored model id `model`, and how long it took. */
export function assistantMetadata(assembled: AssembledCompletion, model: string, latencyMs: number): CompletionMetadata {
  const usage = assembled.usage ?? {};
  const cacheRead = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const tokenUsage = {
    input_tokens: Number(usage.prompt_tokens || 0),
    output_tokens: Number(usage.completion_tokens || 0),
    cache_read_tokens: Number(cacheRead || 0),
  };
  const providerCost = assembled.provider_cost ?? usage.cost;
  const cost =
    typeof providerCost === "number"
      ? { cost_usd: providerCost, cost_source: "provider" as const }
      : catalogCostUsd(model, tokenUsage);
  return {
    usage: tokenUsage,
    latency_ms: latencyMs,
    finish_reason: optionalString(assembled.finish_reason) ?? "stop",
    model: optionalString(assembled.model) ?? "",
    response_id: optionalString(assembled.id),
    provider_request_id: optionalString(assembled.provider_request_id),
    ...cost,
    ...(assembled.reasoning ? { reasoning: assembled.reasoning } : {}),
    ...(assembled.reasoning_details?.length ? { reasoning_details: assembled.reasoning_details } : {}),
  };
}

export function completionTimeoutMs(maxTokens: number): number {
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1;
  return Math.min(600_000, Math.max(120_000, Math.ceil(tokens * 25)));
}
