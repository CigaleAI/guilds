import OpenAI from "openai";
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
} from "./completion.js";
import type { ProviderDef } from "./providers.js";

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

/** The Chat Completions body a provider takes: the fields in its row, and `temperature` only when the catalog says the model takes one. */
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
  const payload = assistantPayload(
    content,
    toolCalls.map((call) => ({
      id: call.id ?? "",
      type: call.type ?? "function",
      function: { name: call.function?.name ?? "", arguments: call.function?.arguments ?? "" },
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
