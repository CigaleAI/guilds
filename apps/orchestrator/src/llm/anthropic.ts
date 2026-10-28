import Anthropic from "@anthropic-ai/sdk";
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
} from "./client.js";
import type { ProviderDef } from "./providers.js";

// A provider on Anthropic's Messages API. The run speaks OpenAI-style messages; a request is
// translated into a Messages API body, and the response comes back as the same events and the
// same assembled assistant payload every other provider yields.

type Row = Record<string, unknown>;
type UserBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

const PROMPT_CACHE_CONTROL = { type: "ephemeral" } as const;

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

/** A Messages API client for a key: no retries, no credentials read from the environment. */
function messagesClient(options: { apiKey: string; baseURL: string; timeoutMs: number; fetch?: typeof fetch }): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: options.baseURL,
    timeout: options.timeoutMs,
    maxRetries: 0,
    defaultHeaders: { "User-Agent": MODEL_USER_AGENT },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/** An OpenAI `image_url`: a data URL becomes a base64 source, an http(s) URL a URL source. */
function imageBlock(url: string): Anthropic.ImageBlockParam | null {
  const inline = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (inline) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: inline[1] as Anthropic.Base64ImageSource["media_type"],
        data: inline[2] ?? "",
      },
    };
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
  return content.flatMap((raw): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> => {
    const part = asRow(raw);
    if (part?.type === "text" && typeof part.text === "string" && part.text) {
      return [{ type: "text", text: part.text }];
    }
    const url = asRow(part?.image_url)?.url;
    if (part?.type === "image_url" && typeof url === "string") {
      const image = imageBlock(url);
      return image ? [image] : [];
    }
    return [];
  });
}

function toolUseInput(args: unknown): Record<string, unknown> {
  if (typeof args !== "string" || !args.trim()) {
    return {};
  }
  try {
    return asRow(JSON.parse(args)) ?? {};
  } catch {
    return {};
  }
}

function assistantBlocks(message: Row): Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> {
  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = contentBlocks(message.content).filter(
    (block): block is Anthropic.TextBlockParam => block.type === "text",
  );
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    const call = asRow(raw);
    const fn = asRow(call?.function);
    if (typeof call?.id !== "string" || typeof fn?.name !== "string") {
      continue;
    }
    blocks.push({ type: "tool_use", id: call.id, name: fn.name, input: toolUseInput(fn.arguments) });
  }
  return blocks;
}

function toolResultBlock(message: Row): Anthropic.ToolResultBlockParam {
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
      last.content.push(...(blocks as Anthropic.ContentBlockParam[]));
      return;
    }
    messages.push({ role, content: [...blocks] as Anthropic.ContentBlockParam[] });
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

/** An OpenAI tool schema as a Messages API tool. */
function messagesTool(raw: unknown): Anthropic.Tool | null {
  const fn = asRow(asRow(raw)?.function);
  if (typeof fn?.name !== "string") {
    return null;
  }
  const parameters = asRow(fn.parameters) ?? { type: "object", properties: {} };
  return {
    name: fn.name,
    ...(typeof fn.description === "string" && fn.description ? { description: fn.description } : {}),
    input_schema: parameters as Anthropic.Tool.InputSchema,
  };
}

/** An OpenAI `tool_choice` as a Messages API one; null when it names nothing the API knows. */
function messagesToolChoice(choice: unknown): Anthropic.ToolChoice | null {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  const name = asRow(asRow(choice)?.function)?.name;
  return typeof name === "string" ? { type: "tool", name } : null;
}

/**
 * The Messages API body of a completion. A thinking level asks for adaptive thinking at that
 * effort, with its summary streamed; `temperature` is sent only without thinking, and only when
 * the catalog says the model takes one. The prompt is cached up to its last block.
 */
export function messagesRequestBody(options: {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  thinking_level?: string;
}): Anthropic.MessageStreamParams {
  const { upstream } = providerForModel(options.model);
  const { system, messages } = messagesFromHistory(options.messages);
  const body: Anthropic.MessageStreamParams = {
    model: upstream,
    max_tokens: options.max_tokens,
    messages,
    cache_control: PROMPT_CACHE_CONTROL,
  };
  if (system.length) {
    body.system = system;
  }
  const effort = reasoningEffortForModel(options.model, options.thinking_level ?? "none");
  if (effort) {
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: effort as Effort };
  } else if (modelCatalog.entry(options.model)?.temperature !== false) {
    body.temperature = options.temperature;
  }
  const tools = (options.tools ?? []).map(messagesTool).filter((tool): tool is Anthropic.Tool => tool !== null);
  if (tools.length) {
    body.tools = tools;
  }
  const choice = options.tool_choice === undefined || options.tool_choice === null ? null : messagesToolChoice(options.tool_choice);
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

/** A Messages API completion, streamed as text and reasoning deltas and one assembled assistant payload. */
export async function* streamMessages(options: {
  model: string;
  messages: Array<Record<string, unknown>>;
  temperature: number;
  max_tokens: number;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  signal?: AbortSignal;
  baseURL: string;
  apiKey: string;
  thinking_level?: string;
}): AsyncGenerator<ModelEvent> {
  const apiKey = options.apiKey.trim();
  const client = messagesClient({ apiKey, baseURL: options.baseURL, timeoutMs: completionTimeoutMs(options.max_tokens) });
  const started = performance.now();
  const body = messagesRequestBody(options);
  let reasoning = "";
  let message: Anthropic.Message;
  let requestId: string | null;
  try {
    const stream = client.messages.stream(body, { signal: options.signal });
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
        { latencyMs: Math.trunc(performance.now() - started), model: options.model },
      ),
    },
  ];
}

/** The model ids a Messages API key lists: the probe a save runs. A rejected key fails. */
export async function listMessagesModels(
  provider: ProviderDef,
  options: { apiKey: string; baseURL: string; fetch?: typeof fetch; timeoutMs: number },
): Promise<string[]> {
  const client = messagesClient(options);
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
    throw asLlmError(error, options.apiKey);
  }
  return ids;
}
