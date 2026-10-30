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

/** A stored tool result, as the projection reads it. */
export type ProjectedToolRow = ProjectedRow & { payload: ToolMessage };

/** How a stubbed tool result reads: the hint it gives the model, and whether it carries the hash of the body it replaces. */
export type ToolResultStubFormat = {
  hint: string;
  includeContentHash?: boolean;
};

/**
 * A stored history as the provider request projects it: the rows, the generation they are seen
 * from, how many generations keep their tool results live, and the budget the prompt must fit.
 * `stubbed` collects the seqs the projection stubs.
 */
export type ToolResultProjection = ToolResultStubFormat & {
  history: ProjectedRow[];
  currentGeneration: number;
  keepGenerations: number;
  stubbed?: number[];
  minUnstubbed?: number;
  minStubBytes?: number;
  budget?: ProjectionBudget;
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

export function stubToolResultPayload(row: ProjectedToolRow, format: ToolResultStubFormat): ToolMessage {
  const { metadata } = row;
  const stub = {
    stub: true,
    source_seq: row.seq,
    tool_name: metadata.tool_name ?? null,
    hint: format.hint,
    ...(metadata.path ? { path: metadata.path } : {}),
    ...(metadata.range ? { range: metadata.range } : {}),
    ...(format.includeContentHash ? { content_hash: promptHash(row.payload.content) } : {}),
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

function replaceStubbedToolPayloads(projection: ToolResultProjection, stubSeqs: Set<number>): MessagePayload[] {
  if (projection.stubbed) {
    projection.stubbed.length = 0;
  }
  return projection.history.map((row) => {
    const payload = row.payload;
    if (payload.role !== "tool" || !stubSeqs.has(row.seq)) {
      return payload;
    }
    projection.stubbed?.push(row.seq);
    return stubToolResultPayload({ ...row, payload }, projection);
  });
}

function stubOldestLiveRowsUntilPromptFits(
  projection: ToolResultProjection,
  budget: ProjectionBudget,
  stubSeqs: Set<number>,
  liveLarge: ProjectedRow[],
): MessagePayload[] {
  let messages = replaceStubbedToolPayloads(projection, stubSeqs);
  let tokens = budget.countInputTokens(budget.model, messages, budget.schemas);
  const maxStub = Math.max(0, liveLarge.length - (projection.minUnstubbed ?? MIN_UNSTUBBED_TOOL_RESULTS));
  for (const row of liveLarge.slice(0, maxStub)) {
    if (tokens <= budget.maxInput) {
      break;
    }
    stubSeqs.add(row.seq);
    messages = replaceStubbedToolPayloads(projection, stubSeqs);
    tokens = budget.countInputTokens(budget.model, messages, budget.schemas);
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
export function projectToolResults(projection: ToolResultProjection): MessagePayload[] {
  const minStubBytes = projection.minStubBytes ?? 0;
  const floor = keepGenerationFloor(projection.currentGeneration, projection.keepGenerations);
  const tools = projection.history.filter((row) => row.payload.role === "tool");
  const stubSeqs = oldGenerationStubSeqs(tools, floor, minStubBytes);
  if (!projection.budget) {
    return replaceStubbedToolPayloads(projection, stubSeqs);
  }
  const liveLarge = liveLargeToolRows(tools, floor, minStubBytes, stubSeqs);
  return stubOldestLiveRowsUntilPromptFits(projection, projection.budget, stubSeqs, liveLarge);
}
