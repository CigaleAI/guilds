import type { ToolProgressEvent } from "./types/runs";

/** What one running tool call has reported so far: its latest lines, and the session it runs in. */
export type CallProgress = { lines: string[]; session_id: string | null };

/** The progress of each running tool call of a run, by tool call id. */
export type ToolProgress = ReadonlyMap<string, CallProgress>;

/** How many of a call's latest lines are kept. */
export const progressLinesKept = 200;

const noProgress: CallProgress = { lines: [], session_id: null };

/** The session an event names; null when it names none, an empty one included. */
function eventSession(event: ToolProgressEvent): string | null {
  return event.session_id || null;
}

/** Whether an event changes nothing for a call already known: no lines, and no new session. */
function addsNothing(known: CallProgress | undefined, event: ToolProgressEvent): boolean {
  if (!known || event.lines.length > 0) return false;
  const session = eventSession(event);
  return session === null || session === known.session_id;
}

/** A call's progress with an event's lines appended, and the event's session when it names one. */
function advanceCallProgress(known: CallProgress, event: ToolProgressEvent): CallProgress {
  return {
    lines: [...known.lines, ...event.lines].slice(-progressLinesKept),
    session_id: eventSession(event) ?? known.session_id,
  };
}

/**
 * Appends a `tool.progress` event's lines to its call's, keeping the latest `progressLinesKept`.
 * An event that names no call changes nothing.
 */
export function applyToolProgress(progress: ToolProgress, event: ToolProgressEvent): ToolProgress {
  const callId = event.tool_call_id;
  if (!callId) return progress;
  const known = progress.get(callId);
  if (addsNothing(known, event)) return progress;
  return new Map(progress).set(callId, advanceCallProgress(known ?? noProgress, event));
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
