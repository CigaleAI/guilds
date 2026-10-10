/** What the model is writing right now, before its turn is committed. */
export type LiveTurn = { reasoning: string; text: string };

/** Text from a live delta: coach frames send `content` (and `text`); run frames send `text`. */
export function liveDeltaText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const body = data as { content?: unknown; text?: unknown };
  if (typeof body.content === "string" && body.content) return body.content;
  return typeof body.text === "string" ? body.text : "";
}

/** Appends an `assistant.delta` or `assistant.reasoning.delta` to the turn being written. */
export function applyLiveDelta(live: LiveTurn | null, name: string, data: unknown): LiveTurn {
  const text = liveDeltaText(data);
  const next = live ?? { reasoning: "", text: "" };
  return name === "assistant.delta"
    ? { ...next, text: next.text + text }
    : { ...next, reasoning: next.reasoning + text };
}

/** True when the model has written reasoning or text that the transcript can show. */
export function liveTurnActive(live: LiveTurn | null | undefined): live is LiveTurn {
  return Boolean(live && (live.reasoning || live.text));
}
