import { getEncoding } from "js-tiktoken";

export const ENCODING_BY_MODEL: Record<string, "o200k_base" | "cl100k_base"> = {
  "openrouter/openai/gpt-5.6-luna": "o200k_base",
  "openai/gpt-5.6-luna": "o200k_base",
  "openrouter/openai/gpt-6-luna": "o200k_base",
  "openai/gpt-6-luna": "o200k_base",
  "openrouter/openai/gpt-6.1-sol": "o200k_base",
  "openai/gpt-6.1-sol": "o200k_base",
  "openrouter/openai/gpt-6-luna-pro": "o200k_base",
  "openai/gpt-6-luna-pro": "o200k_base",
  "openrouter/anthropic/claude-opus-5": "cl100k_base",
  "anthropic/claude-opus-5": "cl100k_base",
  "openrouter/google/gemini-3.8-flash": "o200k_base",
  "google/gemini-3.8-flash": "o200k_base",
  "openrouter/qwen/qwen3.8-flash": "o200k_base",
  "qwen/qwen3.8-flash": "o200k_base",
  "deepinfra/Qwen/Qwen3.8-2.4T-A95B": "o200k_base",
  "deepinfra/zai-org/GLM-5.3": "o200k_base",
  "deepinfra/zai-org/GLM-5.3-Flash": "o200k_base",
  "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash": "o200k_base",
  "kimi/k3": "o200k_base",
  "k3": "o200k_base",
  "kimi/k3-256k": "o200k_base",
  "k3-256k": "o200k_base",
  "kimi/kimi-for-coding": "o200k_base",
  "kimi-for-coding": "o200k_base",
  "kimi/kimi-for-coding-highspeed": "o200k_base",
  "kimi-for-coding-highspeed": "o200k_base",
};

export const INPUT_TOKEN_LIMIT_MESSAGE =
  "Input token limit reached. Start a new run to continue.";

export class GenerationLimitError extends Error {
  operation = "generation.max_input_tokens";

  constructor(message = INPUT_TOKEN_LIMIT_MESSAGE) {
    super(message);
    this.name = "GenerationLimitError";
  }
}

function blob(messages: unknown[], tools?: unknown[] | null): string {
  let text = JSON.stringify(messages);
  if (tools && tools.length) {
    text += JSON.stringify(tools);
  }
  return text;
}

export function estimateInputTokens(messages: unknown[], tools?: unknown[] | null): number {
  return Math.max(1, Math.floor(blob(messages, tools).length / 4));
}

export function countInputTokens(
  model: string,
  messages: unknown[],
  tools?: unknown[] | null,
): number {
  const encodingName = ENCODING_BY_MODEL[model];
  const serialized = blob(messages, tools);
  if (!encodingName) {
    return Math.max(1, Math.floor(serialized.length / 4));
  }
  const encoding = getEncoding(encodingName);
  return Math.max(1, encoding.encode(serialized).length);
}

export function enforceInputTokenLimit(tokens: number, maxInputTokens: number): void {
  if (tokens > maxInputTokens) {
    throw new GenerationLimitError();
  }
}
