import type { ToolProgressEvent } from "./types/runs";

/** What one running tool call has reported so far: its latest lines. */
export type CallProgress = { lines: string[] };

/** The progress of each running tool call of a run, by tool call id. */
export type ToolProgress = ReadonlyMap<string, CallProgress>;

/** How many of a call's latest lines are kept. */
export const progressLinesKept = 200;

/**
 * Appends a `tool.progress` event's lines to its call's, keeping the latest `progressLinesKept`.
 * An event that names no call, or brings no line, changes nothing.
 */
export function applyToolProgress(progress: ToolProgress, event: ToolProgressEvent): ToolProgress {
  const callId = event.tool_call_id;
  if (!callId || !event.lines.length) return progress;
  const lines = [...(progress.get(callId)?.lines ?? []), ...event.lines].slice(-progressLinesKept);
  return new Map(progress).set(callId, { lines });
}

/** Forgets a call's progress once its result is committed. */
export function dropToolProgress(progress: ToolProgress, callId: string): ToolProgress {
  if (!progress.has(callId)) return progress;
  const rest = new Map(progress);
  rest.delete(callId);
  return rest;
}

/** Every progress line held, over all calls. */
export function progressLineCount(progress: ToolProgress): number {
  return [...progress.values()].reduce((total, call) => total + call.lines.length, 0);
}
