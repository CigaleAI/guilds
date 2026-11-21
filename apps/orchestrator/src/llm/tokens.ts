import type { MessagePayload } from "../db/schema/index.js";
import type { FunctionTool } from "../lib/tool-schema.js";
import { TokenCounter, type TokenCounterLimits } from "./token-counter.js";

/** Every model is counted with one encoding. */
export const TOKEN_ENCODING = "o200k_base";

export const INPUT_TOKEN_LIMIT_MESSAGE = "Input token limit reached. Start a new run to continue.";

export class GenerationLimitError extends Error {
  operation = "generation.max_input_tokens";

  constructor(message = INPUT_TOKEN_LIMIT_MESSAGE) {
    super(message);
    this.name = "GenerationLimitError";
  }
}

export const TOKEN_COUNTER_LIMITS: TokenCounterLimits = { maxPending: 32, deadlineMs: 60_000 };

let sharedCounter = new TokenCounter(TOKEN_ENCODING, TOKEN_COUNTER_LIMITS);

/** Replace the counter input counts go to; returns the one it replaces. */
export function installTokenCounter(counter: TokenCounter): TokenCounter {
  const replaced = sharedCounter;
  sharedCounter = counter;
  return replaced;
}

/** Stops the counter's worker; a later count starts a new one. */
export function closeTokenCounter(): Promise<void> {
  return sharedCounter.close();
}

function blob(
  messages: readonly MessagePayload[],
  tools?: readonly FunctionTool[] | null,
): string {
  let text = JSON.stringify(messages);
  if (tools && tools.length) {
    text += JSON.stringify(tools);
  }
  return text;
}

export function estimateInputTokens(
  messages: readonly MessagePayload[],
  tools?: readonly FunctionTool[] | null,
): number {
  return Math.max(1, Math.floor(blob(messages, tools).length / 4));
}

/** Encodes on the counter's worker thread; a signal aborted while the count waits for the worker cancels it. */
export async function countInputTokens(
  _model: string,
  messages: readonly MessagePayload[],
  tools?: readonly FunctionTool[] | null,
  signal?: AbortSignal,
): Promise<number> {
  return Math.max(1, await sharedCounter.count(blob(messages, tools), signal));
}

export function enforceInputTokenLimit(tokens: number, maxInputTokens: number): void {
  if (tokens > maxInputTokens) {
    throw new GenerationLimitError();
  }
}
