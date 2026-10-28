import { DEFAULT_MAX_WORKSPACE_MIB, maxWorkspaceMibOf } from "../agents/validation.js";
import { setAgentWorkspaceMib, type AgentRow } from "../db/agents.js";
import { setMachineWorkspaceMib } from "../db/machines.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { DEFAULT_MACHINE_MAX_WORKSPACE_MIB } from "../db/schema/index.js";
import { agentHome } from "../lib/agent-file.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";
import { agentSandbox, seatEnvironment, type SandboxHandle } from "../sandbox/index.js";
import { measureMachine, measureWorkspace } from "../toolbox/code.js";
import { createToolContext, type ToolContext } from "../toolbox/index.js";
import type { RunEvents, RunGeneration } from "./events.js";
import { agentSeat } from "./machines.js";

export const DEFAULT_WORKSPACE_MAX_MIB = DEFAULT_MAX_WORKSPACE_MIB;

/** Host-wide workspace cap; an agent's `max_workspace_mib` cannot take effect above this. */
export function workspaceMaxMib(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.WORKSPACE_MAX_MIB ?? DEFAULT_WORKSPACE_MAX_MIB);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_WORKSPACE_MAX_MIB;
}

/** The workspace cap this agent is held to: its own max, and never above the host cap. */
export function agentWorkspaceMaxMib(
  config: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.min(maxWorkspaceMibOf(config), workspaceMaxMib(env));
}

/** A tool context for platform work in the sandbox: not cancellable, not tracked, no secrets. */
export function maintenanceContext(runId: string, agent: AgentRow, sandbox: SandboxHandle): ToolContext {
  const seat = agentSeat(agent);
  return createToolContext({
    run_id: runId,
    agent_id: agent.id,
    guild_id: agent.guild_id,
    sandbox: agentSandbox(sandbox, agentHome(seat.agentId), seatEnvironment(seat)),
    secrets: {},
  });
}

/** The db/ functions the workspace sizes are kept through, on `db`. */
export function workspaceLimitsDatabase(db: Queryable) {
  return {
    setAgentWorkspaceMib: bindQuery(db, setAgentWorkspaceMib),
    setMachineWorkspaceMib: bindQuery(db, setMachineWorkspaceMib),
  };
}

export type WorkspaceLimitsDatabase = ReturnType<typeof workspaceLimitsDatabase>;

/** A size the workspace check holds to its limit: the agent's home, or its machine's directory. */
type WorkspaceCheck = {
  limit: number;
  stored: number | null;
  measure: () => Promise<number>;
  store: (mib: number) => Promise<void>;
  what: string;
};

/**
 * The disk limits of a generation: the agent's home under its `max_workspace_mib` (and the host
 * `WORKSPACE_MAX_MIB`), and its machine's directory under the machine's `max_workspace_mib`.
 */
export class WorkspaceLimits {
  constructor(
    private readonly db: WorkspaceLimitsDatabase,
    private readonly events: RunEvents,
  ) {}

  /**
   * Whether the generation may start. The sizes stored after the last generation decide; one
   * that is over is measured again, so space the operator freed from the CLI tab counts. A
   * generation that may not start records why.
   */
  async hasRoom(turn: RunGeneration, agent: AgentRow, sandbox: SandboxHandle): Promise<boolean> {
    for (const check of this.checks(maintenanceContext(turn.runId, agent, sandbox), agent)) {
      if (check.stored === null || check.stored <= check.limit) {
        continue;
      }
      let mib: number;
      try {
        mib = await check.measure();
        await check.store(mib);
      } catch (error) {
        await this.events.recordError(turn, "workspace.measure", error);
        return false;
      }
      if (mib > check.limit) {
        const message = `${check.what} holds ${mib} MiB, above the ${check.limit} MiB limit; free space from the CLI tab`;
        await this.events.recordError(turn, "workspace.full", new Error(message));
        return false;
      }
    }
    return true;
  }

  /** Measures the agent's home and its machine's directory and stores both sizes; a failure is logged. */
  async recordSize(runId: string, agent: AgentRow, sandbox: SandboxHandle): Promise<void> {
    const ctx = maintenanceContext(runId, agent, sandbox);
    try {
      await this.db.setAgentWorkspaceMib(agent.id, await measureWorkspace(ctx));
      await this.db.setMachineWorkspaceMib(agent.machine_id, await measureMachine(ctx));
    } catch (error) {
      writeLog(
        "warn",
        errorMessage(error),
        { run_id: runId, agent_id: agent.id, operation: "workspace.measure", error_type: errorName(error) },
      );
    }
  }

  private checks(ctx: ToolContext, agent: AgentRow): WorkspaceCheck[] {
    return [
      {
        limit: agentWorkspaceMaxMib(agent.config),
        stored: agent.workspace_mib,
        measure: () => measureWorkspace(ctx),
        store: (mib) => this.db.setAgentWorkspaceMib(agent.id, mib),
        what: "the agent's home",
      },
      {
        limit: agent.machine_max_workspace_mib ?? DEFAULT_MACHINE_MAX_WORKSPACE_MIB,
        stored: agent.machine_workspace_mib,
        measure: () => measureMachine(ctx),
        store: (mib) => this.db.setMachineWorkspaceMib(agent.machine_id, mib),
        what: `machine ${agent.machine_name ?? agent.machine_id}`,
      },
    ];
  }
}
