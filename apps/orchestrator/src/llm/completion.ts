import { Type, type Static } from "@sinclair/typebox";
import type {
  AssistantMessage,
  CompletionMetadata,
  MessagePayload,
  ReasoningDetail,
  TokenUsage,
  ToolCall,
} from "../db/schema/index.js";
import { catalogCostUsd } from "./cost.js";
import { parseModelId, type ProviderModel } from "./providers.js";

// What a model call is on every provider's wire: the provider and the reasoning effort a model id
// names, the user agent the call sends, its timeout, its error, and the completion it returns.

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}

/** What a provider call threw, as the `LLMError` it is reported as: its message, with the key redacted. */
export function asLlmError(cause: unknown, apiKey?: string | null): LLMError {
  if (cause instanceof LLMError) {
    cause.message = redactApiKey(cause.message, apiKey);
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new LLMError(redactApiKey(message, apiKey));
}

export type Completion = {
  payload: AssistantMessage;
  metadata: CompletionMetadata;
};

export type ModelEvent = ["delta", string] | ["reasoning", string] | ["done", Completion];

/** The prompt cache mark a provider reads on a request or on one of its parts. */
export const PROMPT_CACHE_CONTROL = { type: "ephemeral" } as const;

/** A text part of a message's content; the prompt cache mark ends the prefix OpenRouter caches. */
export type TextPart = { type: "text"; text: string; cache_control?: typeof PROMPT_CACHE_CONTROL };

/** An image part of a message's content: an http(s) URL, or a `data:` URL of the image's bytes. */
export type ImagePart = { type: "image_url"; image_url: { url: string } };

/** A part of a message's content, as Chat Completions takes it. */
export type ContentPart = TextPart | ImagePart;

/** A stored message whose content is given as parts: its text and the images attached to it. */
export type PartsMessage<M extends MessagePayload = MessagePayload> = M extends MessagePayload
  ? Omit<M, "content"> & { content: ContentPart[] }
  : never;

/** A message a model call sends, in the Chat Completions shape: a stored message, or one with its content as parts. */
export type ModelMessage = MessagePayload | PartsMessage;

/**
 * A completion asked of a model: the stored model id, the OpenAI-style messages and tools, the
 * sampling settings, and the thinking level.
 */
export type ModelRequest = {
  model: string;
  messages: ModelMessage[];
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

/**
 * The token counts and the price a provider reports for one completion: OpenAI's counts, the cache
 * read OpenAI counts among the prompt's details, and the cache read and cost OpenRouter adds.
 */
export const ProviderUsage = Type.Object({
  prompt_tokens: Type.Optional(Type.Number()),
  completion_tokens: Type.Optional(Type.Number()),
  cache_read_input_tokens: Type.Optional(Type.Number()),
  prompt_tokens_details: Type.Optional(Type.Object({ cached_tokens: Type.Optional(Type.Number()) })),
  cost: Type.Optional(Type.Number()),
});
export type ProviderUsage = Static<typeof ProviderUsage>;

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
export function providerForModel(model: string): ProviderModel {
  const parsed = parseModelId(model);
  if (!parsed) {
    throw new LLMError("model must be {provider}/{model}");
  }
  return parsed;
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

/**
 * The token counts a provider's usage reports, a count it leaves out being zero. The cache read is
 * the provider's own field, else OpenAI's cached prompt tokens.
 */
function tokenUsageOf(usage: ProviderUsage): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Number(usage.prompt_tokens || 0),
    output_tokens: Number(usage.completion_tokens || 0),
    cache_read_tokens: Number(cacheRead || 0),
  };
}

/** What a completion records: its usage, its cost on the stored model id `model`, and how long it took. */
export function assistantMetadata(assembled: AssembledCompletion, model: string, latencyMs: number): CompletionMetadata {
  const usage = assembled.usage ?? {};
  const tokenUsage = tokenUsageOf(usage);
  const providerCost = assembled.provider_cost ?? usage.cost;
  const cost =
    providerCost === undefined
      ? catalogCostUsd(model, tokenUsage)
      : { cost_usd: providerCost, cost_source: "provider" as const };
  return {
    usage: tokenUsage,
    latency_ms: latencyMs,
    finish_reason: assembled.finish_reason || "stop",
    model: assembled.model || "",
    response_id: assembled.id || null,
    provider_request_id: assembled.provider_request_id || null,
    ...cost,
    ...(assembled.reasoning ? { reasoning: assembled.reasoning } : {}),
    ...(assembled.reasoning_details?.length ? { reasoning_details: assembled.reasoning_details } : {}),
  };
}

export function completionTimeoutMs(maxTokens: number): number {
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1;
  return Math.min(600_000, Math.max(120_000, Math.ceil(tokens * 25)));
}
