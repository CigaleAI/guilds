import { promptHash } from "../prompts/index.js";

/**
 * Agent-run tool-result projection. The store stays exact; only the provider request
 * replaces large old tool bodies. Replay the same rules on the stored rows.
 */
export const RUN_PROJECTION_POLICY_VERSION = 1;
export const MIN_UNSTUBBED_TOOL_RESULTS = 4;
/** Skip stubbing a result whose stored body is smaller than this (and the stub). */
export const TOOL_RESULT_STUB_MIN_BYTES = 2048;

export const AGENT_TOOL_RESULT_STUB_HINT =
  "Tool result omitted to save context. Call the same tool again. The working tree may have changed.";

export type ProjectionBudget = {
  model: string;
  schemas: unknown[];
  maxInput: number;
  countInputTokens: (model: string, messages: unknown[], tools?: unknown[] | null) => number;
};

function plainObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function generationOf(row: Record<string, unknown>): number {
  if (typeof row.generation === "number" && Number.isInteger(row.generation)) {
    return row.generation;
  }
  const value = Number(plainObject(row.metadata)?.generation);
  return Number.isInteger(value) ? value : 0;
}

export function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  return plainObject(row.payload) ?? {};
}

export function toolResultBytes(row: Record<string, unknown>): number {
  const content = payloadOf(row).content;
  if (typeof content === "string") {
    return Buffer.byteLength(content, "utf8");
  }
  if (content == null) {
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(content), "utf8");
}

/** First generation whose tool results stay live (currentGeneration − keep + 1). */
export function keepGenerationFloor(currentGeneration: number, keepGenerations: number): number {
  const keep = Number.isInteger(keepGenerations) && keepGenerations >= 1 ? keepGenerations : 1;
  return currentGeneration - keep + 1;
}

function pathAndRangeFromMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (typeof metadata.path === "string" && metadata.path) {
    extra.path = metadata.path;
  }
  if (Array.isArray(metadata.range)) {
    extra.range = metadata.range;
  }
  return extra;
}

export function stubToolResultPayload(
  row: Record<string, unknown>,
  hint: string,
  options: { includeContentHash?: boolean } = {},
): Record<string, unknown> {
  const payload = { ...payloadOf(row) };
  const metadata = plainObject(row.metadata) ?? {};
  const stub: Record<string, unknown> = {
    stub: true,
    source_seq: row.seq,
    tool_name: metadata.tool_name ?? null,
    hint,
    ...pathAndRangeFromMetadata(metadata),
  };
  if (options.includeContentHash) {
    stub.content_hash = promptHash(String(payloadOf(row).content ?? ""));
  }
  payload.content = JSON.stringify(stub);
  return payload;
}

function oldGenerationStubSeqs(
  tools: Array<Record<string, unknown>>,
  floor: number,
  minStubBytes: number,
): Set<number> {
  const stubSeqs = new Set<number>();
  for (const row of tools) {
    if (generationOf(row) < floor && toolResultBytes(row) >= minStubBytes) {
      stubSeqs.add(Number(row.seq));
    }
  }
  return stubSeqs;
}

function liveLargeToolRows(
  tools: Array<Record<string, unknown>>,
  floor: number,
  minStubBytes: number,
  stubSeqs: Set<number>,
): Array<Record<string, unknown>> {
  return tools.filter(
    (row) =>
      generationOf(row) >= floor &&
      toolResultBytes(row) >= minStubBytes &&
      !stubSeqs.has(Number(row.seq)),
  );
}

function replaceStubbedToolPayloads(args: {
  history: Array<Record<string, unknown>>;
  stubSeqs: Set<number>;
  hint: string;
  stubbed?: number[];
  includeContentHash?: boolean;
}): Array<Record<string, unknown>> {
  if (args.stubbed) {
    args.stubbed.length = 0;
  }
  return args.history.map((row) => {
    const payload = payloadOf(row);
    if (payload.role !== "tool" || !args.stubSeqs.has(Number(row.seq))) {
      return payload;
    }
    args.stubbed?.push(Number(row.seq));
    return stubToolResultPayload(
      row,
      args.hint,
      args.includeContentHash ? { includeContentHash: true } : {},
    );
  });
}

function stubOldestLiveRowsUntilPromptFits(args: {
  budget: ProjectionBudget;
  liveLarge: Array<Record<string, unknown>>;
  minKeep: number;
  stubSeqs: Set<number>;
  build: () => Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  let messages = args.build();
  let tokens = args.budget.countInputTokens(args.budget.model, messages, args.budget.schemas);
  let stubCurrent = 0;
  const maxStub = Math.max(0, args.liveLarge.length - args.minKeep);
  while (tokens > args.budget.maxInput && stubCurrent < maxStub) {
    args.stubSeqs.add(Number(args.liveLarge[stubCurrent]?.seq));
    stubCurrent += 1;
    messages = args.build();
    tokens = args.budget.countInputTokens(args.budget.model, messages, args.budget.schemas);
  }
  return messages;
}

/**
 * Replace large old tool-result bodies in the messages sent to the model.
 * `keepGenerations` is how many user turns stay live, including the current one
 * (1 = stub every previous generation). Results under `minStubBytes` stay as stored.
 * When `budget` is set and the projected prompt is still over `maxInput`, the oldest
 * live large results are stubbed until `minUnstubbed` remain or the count fits.
 */
export function projectToolResults(args: {
  history: Array<Record<string, unknown>>;
  currentGeneration: number;
  keepGenerations: number;
  hint: string;
  stubbed?: number[];
  minUnstubbed?: number;
  minStubBytes?: number;
  budget?: ProjectionBudget;
  includeContentHash?: boolean;
}): Array<Record<string, unknown>> {
  const minKeep = args.minUnstubbed ?? MIN_UNSTUBBED_TOOL_RESULTS;
  const minStubBytes = args.minStubBytes ?? 0;
  const floor = keepGenerationFloor(args.currentGeneration, args.keepGenerations);
  const tools = args.history.filter((row) => payloadOf(row).role === "tool");
  const stubSeqs = oldGenerationStubSeqs(tools, floor, minStubBytes);
  const liveLarge = liveLargeToolRows(tools, floor, minStubBytes, stubSeqs);
  const build = () =>
    replaceStubbedToolPayloads({
      history: args.history,
      stubSeqs,
      hint: args.hint,
      ...(args.stubbed !== undefined ? { stubbed: args.stubbed } : {}),
      ...(args.includeContentHash ? { includeContentHash: true } : {}),
    });
  if (!args.budget) {
    return build();
  }
  return stubOldestLiveRowsUntilPromptFits({
    budget: args.budget,
    liveLarge,
    minKeep,
    stubSeqs,
    build,
  });
}
