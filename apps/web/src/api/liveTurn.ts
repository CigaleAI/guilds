import type { LiveDelta } from "./types/runs";

/** What the model is writing right now, before its turn is committed. */
export type LiveTurn = { reasoning: string; text: string };

/** Text from a live delta: a coach's reply frames carry it as `content`, every frame as `text`. */
export function liveDeltaText(delta: LiveDelta): string {
  return delta.content || delta.text;
}

/** Appends an `assistant.delta` or `assistant.reasoning.delta` to the turn being written. */
export function applyLiveDelta(live: LiveTurn | null, name: string, delta: LiveDelta): LiveTurn {
  const text = liveDeltaText(delta);
  const next = live ?? { reasoning: "", text: "" };
  return name === "assistant.delta"
    ? { ...next, text: next.text + text }
    : { ...next, reasoning: next.reasoning + text };
}

/** True when the model has written reasoning or text that the transcript can show. */
export function liveTurnActive(live: LiveTurn | null | undefined): live is LiveTurn {
  return Boolean(live && (live.reasoning || live.text));
}
