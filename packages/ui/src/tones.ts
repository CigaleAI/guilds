/**
 * The five status fills and what each one means across guilds.run.
 * Primitives take a Tone; components translate their domain state into one with these maps.
 */
export type Tone = "signal" | "tide" | "dusk" | "ochre" | "plum" | "idle";

/** Run, agent and issue states, by the fill that carries them. */
export type Status = "running" | "ok" | "queued" | "warning" | "failed" | "idle";

export const statusTone: Record<Status, Tone> = {
  running: "signal",
  ok: "tide",
  queued: "dusk",
  warning: "ochre",
  failed: "plum",
  idle: "idle",
};

/** What one wake produced, as Studio's activity ledger buckets it. */
export type WakeOutcome = "posted" | "wrote" | "silent" | "failed" | "running";

export const wakeOutcomeLabel: Record<WakeOutcome, string> = {
  posted: "posted",
  wrote: "wrote records only",
  silent: "no output",
  failed: "failed · cancelled · out of budget",
  running: "running",
};
