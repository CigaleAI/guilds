/** What one running tool call has reported so far: its latest lines, and the session it runs in. */
export type CallProgress = { lines: string[]; session_id: string | null };

/** The progress of each running tool call of a run, by tool call id. */
export type ToolProgress = Readonly<Record<string, CallProgress>>;

/** How many of a call's latest lines are kept. */
export const progressLinesKept = 200;

/** Appends a `tool.progress` event's lines to its call's, keeping the latest `progressLinesKept`. */
export function applyToolProgress(progress: ToolProgress, data: unknown): ToolProgress {
  if (!data || typeof data !== "object") return progress;
  const event = data as { tool_call_id?: unknown; lines?: unknown; session_id?: unknown };
  if (typeof event.tool_call_id !== "string" || !event.tool_call_id) return progress;
  const lines = Array.isArray(event.lines)
    ? event.lines.filter((line): line is string => typeof line === "string")
    : [];
  const known = progress[event.tool_call_id];
  const sessionId =
    typeof event.session_id === "string" && event.session_id
      ? event.session_id
      : (known?.session_id ?? null);
  if (known && !lines.length && sessionId === known.session_id) return progress;
  return {
    ...progress,
    [event.tool_call_id]: {
      lines: [...(known?.lines ?? []), ...lines].slice(-progressLinesKept),
      session_id: sessionId,
    },
  };
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
