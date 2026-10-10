import { getEncoding } from "js-tiktoken";

/** Every model is counted with one encoding. */
export const TOKEN_ENCODING = "o200k_base";

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
  _model: string,
  messages: unknown[],
  tools?: unknown[] | null,
): number {
  const encoding = getEncoding(TOKEN_ENCODING);
  return Math.max(1, encoding.encode(blob(messages, tools)).length);
}

export function enforceInputTokenLimit(tokens: number, maxInputTokens: number): void {
  if (tokens > maxInputTokens) {
    throw new GenerationLimitError();
  }
}
