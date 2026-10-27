import { getAgent, type AgentRow } from "../db/agents.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { AsyncEvent } from "../lib/event.js";
import type { OrgPolicy } from "../policy/index.js";
import type { SandboxHandle } from "../sandbox/index.js";
import { CancelEvent } from "../toolbox/index.js";
import { ConflictError, RunRequestError } from "./errors.js";

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
      if (orgId && Number.isFinite(maxConcurrent) && this.orgCount(orgId) >= Number(maxConcurrent)) {
        throw new AdmissionConflictError("plan limit reached: concurrent generations");
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

/** The db/ functions the generations in progress read their agents through, on `db`. */
export function activeGenerationsDatabase(db: Queryable) {
  return { getAgent: bindQuery(db, getAgent) };
}

export type ActiveGenerationsDatabase = ReturnType<typeof activeGenerationsDatabase>;

/** A run that generates: its agent, how it is cancelled, and the work in flight for it. */
type ActiveRun = {
  agentId: string;
  cancel: CancelEvent;
  task: Promise<void> | null;
  settling: Promise<void> | null;
  command: [SandboxHandle, string] | null;
};

/**
 * The generations in progress on one loop. An agent generates one run at a time, admitted by
 * the coordinator against its organisation's plan; an agent that is being deleted or moved is
 * held busy the same way. Each release bumps `lockGeneration` and wakes whoever waits for one.
 */
export class ActiveGenerations {
  lockGeneration = 0;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly busyAgents = new Set<string>();
  /** The machine of each agent that generates. */
  private readonly agentMachines = new Map<string, string>();
  private readonly deletingGuilds = new Set<string>();
  private readonly released = new AsyncEvent();
  private mutex: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: ActiveGenerationsDatabase,
    private readonly admission: AdmissionCoordinator,
    private readonly policy: OrgPolicy,
  ) {}

  isGenerating(runId: string): boolean {
    return this.runs.has(runId);
  }

  isAgentBusy(agentId: string): boolean {
    return this.busyAgents.has(agentId);
  }

  isDeletingGuild(guildId: string): boolean {
    return this.deletingGuilds.has(guildId);
  }

  /** Whether an agent on this machine generates, `except` aside. */
  isMachineBusy(machineId: string, except?: string): boolean {
    for (const [agentId, machine] of this.agentMachines) {
      if (machine === machineId && agentId !== except && this.busyAgents.has(agentId)) {
        return true;
      }
    }
    return false;
  }

  /** The agent, refused while it is missing or its guild is being deleted. */
  async runnableAgent(agentId: string): Promise<AgentRow> {
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      throw new RunRequestError(404, "agent not found");
    }
    if (this.deletingGuilds.has(agent.guild_id)) {
      throw new RunRequestError(409, "guild is being deleted");
    }
    return agent;
  }

  runIds(): string[] {
    return [...this.runs.keys()];
  }

  runIdsOf(agentId: string): string[] {
    return [...this.runs].filter(([, run]) => run.agentId === agentId).map(([runId]) => runId);
  }

  agentOf(runId: string): string | null {
    return this.runs.get(runId)?.agentId ?? null;
  }

  /** The organisation the run's agent was admitted under. */
  orgOf(runId: string): string | null {
    const agentId = this.agentOf(runId);
    return agentId === null ? null : (this.admission.orgId("agent", agentId) ?? null);
  }

  cancelEvent(runId: string): CancelEvent | null {
    return this.runs.get(runId)?.cancel ?? null;
  }

  isCancelled(runId: string): boolean {
    return this.runs.get(runId)?.cancel.aborted ?? false;
  }

  /** The command the run waits on in its sandbox, which a cancel interrupts. */
  command(runId: string): [SandboxHandle, string] | null {
    return this.runs.get(runId)?.command ?? null;
  }

  trackCommand(runId: string, sandbox: SandboxHandle, executionId: string | null): void {
    const run = this.runs.get(runId);
    if (run) {
      run.command = executionId ? [sandbox, executionId] : null;
    }
  }

  task(runId: string): Promise<void> | null {
    return this.runs.get(runId)?.task ?? null;
  }

  setTask(runId: string, task: Promise<void>): void {
    const run = this.runs.get(runId);
    if (run) {
      run.task = task;
    }
  }

  /** The run's cancel settlement, started by `settle` the first time it is asked for. */
  settlement(runId: string, settle: () => Promise<void>): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return settle();
    }
    run.settling ??= settle();
    return run.settling;
  }

  /**
   * Admits a generation of the run on its agent, under the organisation's concurrent-run limit.
   * Returns the machine the agent generates on, or null when its row names none.
   */
  async begin(runId: string, agentId: string): Promise<string | null> {
    const previous = this.mutex;
    let release: (() => void) | undefined;
    this.mutex = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.runs.has(runId)) {
        throw new ConflictError("generation already in progress");
      }
      if (this.busyAgents.has(agentId)) {
        throw new ConflictError("agent is already generating");
      }
      const agent = await this.db.getAgent(agentId);
      await this.admit(agentId, agent?.org_id ?? "");
      const machineId = agent?.machine_id ?? null;
      if (machineId !== null) {
        this.agentMachines.set(agentId, machineId);
      }
      this.busyAgents.add(agentId);
      this.runs.set(runId, { agentId, cancel: new CancelEvent(), task: null, settling: null, command: null });
      return machineId;
    } finally {
      release?.();
    }
  }

  /** Takes the agent's admission slot, under its organisation's limit on concurrent runs. */
  private async admit(agentId: string, orgId: string): Promise<void> {
    const max = orgId
      ? ((await this.policy.standing(orgId)).limits.maxConcurrentRuns ?? undefined)
      : undefined;
    try {
      await this.admission.acquire("agent", agentId, orgId, max);
    } catch (error) {
      if (error instanceof AdmissionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  }

  /** Ends the run's generation and frees its agent. Returns the machine the agent generated on. */
  end(runId: string): string | null {
    const run = this.runs.get(runId);
    this.runs.delete(runId);
    let machineId: string | null = null;
    if (run) {
      this.busyAgents.delete(run.agentId);
      this.admission.release("agent", run.agentId);
      machineId = this.agentMachines.get(run.agentId) ?? null;
      this.agentMachines.delete(run.agentId);
    }
    this.notifyRelease();
    return machineId;
  }

  /** Moves the agent's generation from a run to its continuation without freeing the agent. */
  handOver(fromRunId: string, toRunId: string): void {
    const from = this.runs.get(fromRunId);
    this.runs.delete(fromRunId);
    if (from) {
      this.runs.set(toRunId, { agentId: from.agentId, cancel: new CancelEvent(), task: null, settling: null, command: null });
    }
  }

  /** Holds an idle agent busy while it is deleted or moved. */
  holdAgent(agentId: string): void {
    if (this.busyAgents.has(agentId)) {
      throw new RunRequestError(409, "agent is already generating");
    }
    this.busyAgents.add(agentId);
  }

  releaseAgent(agentId: string): void {
    this.busyAgents.delete(agentId);
    this.notifyRelease();
  }

  /** Holds a guild and its idle agents while the guild is deleted. */
  holdGuild(guildId: string, agentIds: string[]): void {
    if (this.deletingGuilds.has(guildId)) {
      throw new RunRequestError(409, "guild is already being deleted");
    }
    if (agentIds.some((agentId) => this.busyAgents.has(agentId))) {
      throw new RunRequestError(409, "a member agent is already generating");
    }
    this.deletingGuilds.add(guildId);
    for (const agentId of agentIds) {
      this.busyAgents.add(agentId);
    }
  }

  releaseGuild(guildId: string, agentIds: string[]): void {
    for (const agentId of agentIds) {
      this.busyAgents.delete(agentId);
    }
    this.deletingGuilds.delete(guildId);
    this.notifyRelease();
  }

  /** Resolves once a release happens after the one numbered `seen`. */
  async waitForLockRelease(seen: number): Promise<void> {
    while (this.lockGeneration <= seen) {
      this.released.clear();
      if (this.lockGeneration > seen) {
        return;
      }
      await this.released.wait();
    }
  }

  private notifyRelease(): void {
    this.lockGeneration += 1;
    this.released.set();
  }
}
