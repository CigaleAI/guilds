/** What one running tool call has reported so far: its latest lines, and the session it runs in. */
export type CallProgress = { lines: string[]; session_id: string | null };

/** The progress of each running tool call of a run, by tool call id. */
export type ToolProgress = Readonly<Record<string, CallProgress>>;

/** How many of a call's latest lines are kept. */
export const progressLinesKept = 200;

/** A `tool.progress` event as read from the stream: the call it names, its lines, and its session. */
type ProgressEvent = { callId: string; lines: string[]; sessionId: string | null };

const noProgress: CallProgress = { lines: [], session_id: null };

/** A string with something in it; null for an empty string or anything else. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The strings of a list, in order; empty when it is not a list. */
function stringLines(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((line): line is string => typeof line === "string")
    : [];
}

/** Reads a `tool.progress` event's data; null when it names no tool call. */
function readProgressEvent(data: unknown): ProgressEvent | null {
  if (!data || typeof data !== "object" || !("tool_call_id" in data)) return null;
  const callId = nonEmptyString(data.tool_call_id);
  if (!callId) return null;
  return {
    callId,
    lines: stringLines("lines" in data ? data.lines : null),
    sessionId: nonEmptyString("session_id" in data ? data.session_id : null),
  };
}

/** Whether an event changes nothing for a call already known: no lines, and no new session. */
function addsNothing(known: CallProgress | undefined, event: ProgressEvent): boolean {
  if (!known || event.lines.length > 0) return false;
  return event.sessionId === null || event.sessionId === known.session_id;
}

/** A call's progress with an event's lines appended, and the event's session when it names one. */
function advanceCallProgress(known: CallProgress, event: ProgressEvent): CallProgress {
  return {
    lines: [...known.lines, ...event.lines].slice(-progressLinesKept),
    session_id: event.sessionId ?? known.session_id,
  };
}

/** Appends a `tool.progress` event's lines to its call's, keeping the latest `progressLinesKept`. */
export function applyToolProgress(progress: ToolProgress, data: unknown): ToolProgress {
  const event = readProgressEvent(data);
  if (!event) return progress;
  const known = progress[event.callId];
  if (addsNothing(known, event)) return progress;
  return { ...progress, [event.callId]: advanceCallProgress(known ?? noProgress, event) };
}

/** Forgets a call's progress once its result is committed. */
export function dropToolProgress(progress: ToolProgress, callId: unknown): ToolProgress {
  if (typeof callId !== "string" || !Object.hasOwn(progress, callId)) return progress;
  const rest: Record<string, CallProgress> = { ...progress };
  delete rest[callId];
  return rest;
}

/** Every progress line held, over all calls. */
export function progressLineCount(progress: ToolProgress): number {
  return Object.values(progress).reduce((total, call) => total + call.lines.length, 0);
}
