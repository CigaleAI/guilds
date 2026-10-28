import type { MessageMetadata, MessagePayload, ToolMessage } from "../db/schema/index.js";
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

/** A stored message of a run or a coach conversation, as the projection reads it. */
export type ProjectedRow = {
  seq: number;
  /** A coach conversation's message carries its generation as a column; a run's in its metadata. */
  generation?: number;
  payload: MessagePayload;
  metadata: Pick<MessageMetadata, "generation" | "tool_name" | "path" | "range">;
};

export function generationOf(row: ProjectedRow): number {
  return row.generation ?? row.metadata.generation ?? 0;
}

export function toolResultBytes(row: ProjectedRow): number {
  return Buffer.byteLength(row.payload.content, "utf8");
}

/** First generation whose tool results stay live (currentGeneration − keep + 1). */
export function keepGenerationFloor(currentGeneration: number, keepGenerations: number): number {
  const keep = Number.isInteger(keepGenerations) && keepGenerations >= 1 ? keepGenerations : 1;
  return currentGeneration - keep + 1;
}

export function stubToolResultPayload(
  row: ProjectedRow & { payload: ToolMessage },
  hint: string,
  options: { includeContentHash?: boolean } = {},
): ToolMessage {
  const { metadata } = row;
  const stub = {
    stub: true,
    source_seq: row.seq,
    tool_name: metadata.tool_name ?? null,
    hint,
    ...(metadata.path ? { path: metadata.path } : {}),
    ...(metadata.range ? { range: metadata.range } : {}),
    ...(options.includeContentHash ? { content_hash: promptHash(row.payload.content) } : {}),
  };
  return { ...row.payload, content: JSON.stringify(stub) };
}

function oldGenerationStubSeqs(
  tools: ProjectedRow[],
  floor: number,
  minStubBytes: number,
): Set<number> {
  const stubSeqs = new Set<number>();
  for (const row of tools) {
    if (generationOf(row) < floor && toolResultBytes(row) >= minStubBytes) {
      stubSeqs.add(row.seq);
    }
  }
  return stubSeqs;
}

function liveLargeToolRows(
  tools: ProjectedRow[],
  floor: number,
  minStubBytes: number,
  stubSeqs: Set<number>,
): ProjectedRow[] {
  return tools.filter(
    (row) =>
      generationOf(row) >= floor &&
      toolResultBytes(row) >= minStubBytes &&
      !stubSeqs.has(row.seq),
  );
}

function replaceStubbedToolPayloads(args: {
  history: ProjectedRow[];
  stubSeqs: Set<number>;
  hint: string;
  stubbed?: number[];
  includeContentHash?: boolean;
}): MessagePayload[] {
  if (args.stubbed) {
    args.stubbed.length = 0;
  }
  return args.history.map((row) => {
    const payload = row.payload;
    if (payload.role !== "tool" || !args.stubSeqs.has(row.seq)) {
      return payload;
    }
    args.stubbed?.push(row.seq);
    return stubToolResultPayload(
      { ...row, payload },
      args.hint,
      args.includeContentHash ? { includeContentHash: true } : {},
    );
  });
}

function stubOldestLiveRowsUntilPromptFits(args: {
  budget: ProjectionBudget;
  liveLarge: ProjectedRow[];
  minKeep: number;
  stubSeqs: Set<number>;
  build: () => MessagePayload[];
}): MessagePayload[] {
  let messages = args.build();
  let tokens = args.budget.countInputTokens(args.budget.model, messages, args.budget.schemas);
  const maxStub = Math.max(0, args.liveLarge.length - args.minKeep);
  for (const row of args.liveLarge.slice(0, maxStub)) {
    if (tokens <= args.budget.maxInput) {
      break;
    }
    args.stubSeqs.add(row.seq);
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
  history: ProjectedRow[];
  currentGeneration: number;
  keepGenerations: number;
  hint: string;
  stubbed?: number[];
  minUnstubbed?: number;
  minStubBytes?: number;
  budget?: ProjectionBudget;
  includeContentHash?: boolean;
}): MessagePayload[] {
  const minKeep = args.minUnstubbed ?? MIN_UNSTUBBED_TOOL_RESULTS;
  const minStubBytes = args.minStubBytes ?? 0;
  const floor = keepGenerationFloor(args.currentGeneration, args.keepGenerations);
  const tools = args.history.filter((row) => row.payload.role === "tool");
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
