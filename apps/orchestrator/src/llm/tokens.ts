import { getEncoding, type Tiktoken } from "js-tiktoken";
import type OpenAI from "openai";

/** Every model is counted with one encoding. */
export const TOKEN_ENCODING = "o200k_base";

export type ModelMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type ModelToolDefinition = OpenAI.Chat.ChatCompletionTool;

export const INPUT_TOKEN_LIMIT_MESSAGE = "Input token limit reached. Start a new run to continue.";

export class GenerationLimitError extends Error {
  operation = "generation.max_input_tokens";

  constructor(message = INPUT_TOKEN_LIMIT_MESSAGE) {
    super(message);
    this.name = "GenerationLimitError";
  }
}

type TokenEncodingLoader = () => Tiktoken;

let cachedEncoding: Tiktoken | undefined;
let loadTokenEncoding: TokenEncodingLoader = () => getEncoding(TOKEN_ENCODING);

/** Replace the loader and drop the cached encoding. */
export function installTokenEncodingLoader(loader: TokenEncodingLoader): void {
  loadTokenEncoding = loader;
  cachedEncoding = undefined;
}

function sharedEncoding(): Tiktoken {
  cachedEncoding ??= loadTokenEncoding();
  return cachedEncoding;
}

function blob(
  messages: readonly ModelMessage[],
  tools?: readonly ModelToolDefinition[] | null,
): string {
  let text = JSON.stringify(messages);
  if (tools && tools.length) {
    text += JSON.stringify(tools);
  }
  return text;
}

export function estimateInputTokens(
  messages: readonly ModelMessage[],
  tools?: readonly ModelToolDefinition[] | null,
): number {
  return Math.max(1, Math.floor(blob(messages, tools).length / 4));
}

export function countInputTokens(
  _model: string,
  messages: readonly ModelMessage[],
  tools?: readonly ModelToolDefinition[] | null,
): number {
  return Math.max(1, sharedEncoding().encode(blob(messages, tools)).length);
}

export function enforceInputTokenLimit(tokens: number, maxInputTokens: number): void {
  if (tokens > maxInputTokens) {
    throw new GenerationLimitError();
  }
}
