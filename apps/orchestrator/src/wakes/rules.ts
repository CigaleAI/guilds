/** How many wake-ups a run has left: its cap less the wake-ups fired across its chain, never below none. */
export function wakeUpsLeft(maxWakeUps: number, firedInChain: number): number {
  return Math.max(0, maxWakeUps - firedInChain);
}

/** A run that ended on a cap a resume cannot lift had its pending wake-up cancelled. */
export class WakeCancelled extends Error {
  readonly wakeId: string;
  readonly cap: string;

  constructor(wakeId: string, cap: string) {
    super(`wake-up ${wakeId} cancelled: the run ended on ${cap}`);
    this.name = "WakeCancelled";
    this.wakeId = wakeId;
    this.cap = cap;
  }
}
