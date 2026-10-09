export type WorkloadKind = "agent" | "studio" | "builder";

export class AdmissionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionConflictError";
  }
}

type Slot = {
  kind: WorkloadKind;
  id: string;
  orgId: string;
};

function slotKey(kind: WorkloadKind, id: string): string {
  return `${kind}:${id}`;
}

export class AdmissionCoordinator {
  private slots = new Map<string, Slot>();
  private mutex: Promise<void> = Promise.resolve();

  /** `maxTotal` caps generations across every organisation; 0 or undefined leaves only the per-plan caps. */
  constructor(private readonly maxTotal = 0) {}

  async acquire(
    kind: WorkloadKind,
    id: string,
    orgId: string,
    maxConcurrent?: number,
  ): Promise<void> {
    const previous = this.mutex;
    let release: (() => void) | undefined;
    this.mutex = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const key = slotKey(kind, id);
      if (this.slots.has(key)) {
        throw new AdmissionConflictError(
          kind === "agent"
            ? "agent is already generating"
            : `${kind} session is already generating`,
        );
      }
      if (this.maxTotal > 0 && this.slots.size >= this.maxTotal) {
        throw new AdmissionConflictError("the server is at its generation limit; try again shortly");
      }
      if (orgId && Number.isFinite(maxConcurrent)) {
        let busy = 0;
        for (const slot of this.slots.values()) {
          if (slot.orgId === orgId) {
            busy += 1;
          }
        }
        if (busy >= Number(maxConcurrent)) {
          throw new AdmissionConflictError("plan limit reached: concurrent generations");
        }
      }
      this.slots.set(key, { kind, id, orgId });
    } finally {
      release?.();
    }
  }

  release(kind: WorkloadKind, id: string): void {
    this.slots.delete(slotKey(kind, id));
  }

  isBusy(kind: WorkloadKind, id: string): boolean {
    return this.slots.has(slotKey(kind, id));
  }

  orgId(kind: WorkloadKind, id: string): string | undefined {
    return this.slots.get(slotKey(kind, id))?.orgId;
  }

  orgCount(orgId: string): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.orgId === orgId) {
        count += 1;
      }
    }
    return count;
  }
}
