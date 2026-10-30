import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { validateAgentConfig } from "../agents/config.js";
import { AgentValidationError } from "../agents/validation.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { setMachineHarnesses } from "../db/machines.js";
import { bindQuery, type BoundQuery, type Queryable } from "../db/pg.js";
import type { AgentConfig } from "../db/schema/index.js";
import { agentDirectory, machineDirectory, machineFromRow, type AgentNeeds } from "../machines/index.js";
import { moveAgent } from "../machines/placement.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";
import {
  machineSpec,
  prepareBrowserWorkspace,
  prepareWorkspace,
  type AgentSeat,
  type MachineSpec,
} from "../sandbox/index.js";
import { SandboxError, type SandboxHandle } from "../sandbox/sdk.js";
import type { ActiveGenerations } from "./active-generations.js";
import { AgentGoneError, logOperationFailure, RunRequestError, type OperationFailure } from "./errors.js";
import { IdleTimers } from "./idle.js";

/**
 * The machines agents run on: one container per machine, every agent's commands in its own home
 * there, and each agent's browser and terminal on the ports of its slot.
 */
export type GenerationSandboxes = {
  /** The machine's running container, created when there is none or replaced when its size changed. */
  ensure(machine: MachineSpec): Promise<SandboxHandle>;
  connectRunning(machineId: string): Promise<SandboxHandle | null>;
  /** The harness CLIs the machine's container carries, read when the provider created it. */
  harnessesOf?(machineId: string): string[] | null;
  destroy(machineId: string): Promise<void>;
  listRunningMachineIds(): Promise<Iterable<string>>;
  /**
   * Starts the agent's display, Chrome, noVNC, and DevTools relay when they are not up, and waits
   * until they answer.
   */
  startBrowser(sandbox: SandboxHandle, seat: AgentSeat): Promise<void>;
  stopBrowser(sandbox: SandboxHandle, seat: AgentSeat): Promise<void>;
  /** Stops the agent's browser and terminal and removes its runtime files. */
  purgeAgent(sandbox: SandboxHandle, seat: AgentSeat): Promise<void>;
  novncTarget(sandbox: SandboxHandle, seat: AgentSeat): Promise<[string, Record<string, string>]>;
  /** The upstream base and headers of the agent's DevTools relay, which forwards to its Chrome. */
  cdpTarget(sandbox: SandboxHandle, seat: AgentSeat): Promise<[string, Record<string, string>]>;
  startCli(sandbox: SandboxHandle, seat: AgentSeat): Promise<string>;
  cliTarget(sandbox: SandboxHandle, seat: AgentSeat, token: string): Promise<[string, Record<string, string>]>;
  /** The host a machine runs on, and its workspace root there; core runs every machine on one. */
  machineHost?(machineId: string): Promise<{
    hostId: string;
    workspaceRoot: string;
    proxyUrl: string;
  } | null>;
};

/** The machine an agent row sits on, as its container runs it. */
export function agentMachine(agent: AgentRow): MachineSpec {
  return machineSpec({
    id: agent.machine_id,
    org_id: agent.org_id,
    box: machineFromRow({ box: agent.machine_box }).box,
    // A numeric column reads as text.
    cpu: agent.machine_cpu === null ? null : Number(agent.machine_cpu),
    memory_mib: agent.machine_memory_mib,
  });
}

/** An agent row's seat on its machine. */
export function agentSeat(agent: AgentRow): AgentSeat {
  return {
    agentId: agent.id,
    machineId: agent.machine_id,
    slot: agent.machine_slot,
    browserLanguage: agent.config.browser_language,
  };
}

/** The db/ functions the machines read agents and keep their state through. */
export type AgentMachinesDatabase = {
  getAgent: BoundQuery<typeof getAgent>;
  setMachineHarnesses: BoundQuery<typeof setMachineHarnesses>;
  moveAgent: BoundQuery<typeof moveAgent>;
};

/** The db/ functions the machines read agents and keep their state through, on `db`. */
export function agentMachinesDatabase(db: Queryable): AgentMachinesDatabase {
  return {
    getAgent: bindQuery(db, getAgent),
    setMachineHarnesses: bindQuery(db, setMachineHarnesses),
    moveAgent: bindQuery(db, moveAgent),
  };
}

/**
 * What a move of an agent is held to: its organisation's cap on agents per machine, and what the
 * agent needs of the machine it moves to.
 */
export type AgentMoveLimits = { maxAgentsPerMachine?: number | null; needs?: AgentNeeds };

/** What the machines are run with, built once by the loop. */
export type AgentMachinesServices = {
  db: AgentMachinesDatabase;
  sandboxes: GenerationSandboxes;
  /** Where machine directories are kept when the provider names no host for a machine. */
  workspaceRoot: string;
  generations: ActiveGenerations;
};

/**
 * The machines the agents of one loop run on: each machine's container, woken for work and
 * stopped after an idle timeout, and each agent's Chrome and terminal on it.
 */
export class AgentMachines {
  readonly db: AgentMachinesDatabase;
  readonly sandboxes: GenerationSandboxes;
  readonly workspaceRoot: string;
  private readonly generations: ActiveGenerations;
  /** Each running machine's idle stop, by machine id. */
  readonly idle: IdleTimers;
  /** Each running Chrome's idle stop, by agent id. */
  readonly browserIdle: IdleTimers;
  /** The machine of each agent whose Browser or CLI view started or had input, until it moves or goes. */
  private readonly touched = new Map<string, string>();
  /** Machines whose tier or size changed while an agent on them generated. */
  readonly stale = new Set<string>();
  /** The harness list each machine's row was last given. */
  private readonly harnessReports = new Map<string, string>();

  constructor(services: AgentMachinesServices, idleTimeoutMs: number) {
    this.db = services.db;
    this.sandboxes = services.sandboxes;
    this.workspaceRoot = services.workspaceRoot;
    this.generations = services.generations;
    this.idle = new IdleTimers(idleTimeoutMs);
    this.browserIdle = new IdleTimers(idleTimeoutMs);
  }

  /** Cancels every idle stop, as the loop closes. */
  cancelTimers(): void {
    for (const machineId of this.idle.keys()) {
      this.cancelIdle(machineId);
    }
    for (const agentId of this.browserIdle.keys()) {
      this.cancelBrowserIdle(agentId);
    }
  }

  /** Arms the idle stop of every running machine no agent generates on, as the loop starts. */
  async armIdleForRunning(): Promise<void> {
    for (const machineId of await this.sandboxes.listRunningMachineIds()) {
      if (!this.generations.isMachineBusy(machineId)) {
        this.armIdle(machineId);
      }
    }
  }

  /**
   * A machine no agent generates on any more: it goes when it changed meanwhile, and otherwise
   * counts down to its idle stop.
   */
  releaseMachine(machineId: string): void {
    if (this.stale.has(machineId)) {
      void this.machineChanged(machineId);
    } else {
      this.armIdle(machineId);
    }
  }

  /**
   * The container a generation of the agent runs in: the machine's running one while another
   * agent there generates, even when the machine was resized, and otherwise one ensured at the
   * machine's current size.
   */
  async sandboxForGeneration(agent: AgentRow): Promise<SandboxHandle> {
    const machine = agentMachine(agent);
    const shared = this.generations.isMachineBusy(machine.id, agent.id)
      ? await this.sandboxes.connectRunning(machine.id)
      : null;
    let sandbox = shared;
    if (sandbox === null) {
      sandbox = await this.sandboxes.ensure(machine);
      this.stale.delete(machine.id);
    }
    this.reportHarnesses(machine.id);
    return sandbox;
  }

  /** Keeps the agent's Chrome up for a browser call: its idle stop restarts, or it starts. */
  async ensureRunBrowser(agent: AgentRow, sandbox: SandboxHandle): Promise<void> {
    if (this.browserIdle.has(agent.id)) {
      this.armBrowserIdle(agent.id);
      return;
    }
    await this.startAgentBrowser(agent, sandbox);
  }

  cancelIdle(machineId: string): void {
    this.idle.cancel(machineId);
  }

  /** Arms a machine's idle stop: its container goes after the idle timeout without work or input. */
  armIdle(machineId: string): void {
    this.idle.arm(machineId, async () =>
      this.generations.isMachineBusy(machineId) ? null : this.destroyContainer(machineId, "sandbox.idle.stop"),
    );
  }

  /**
   * Destroys the machine's container, which then no longer runs at a stale size; returns the
   * failure of a destroy that did not go through, logged as `operation`.
   */
  private async destroyContainer(machineId: string, operation: string): Promise<OperationFailure | null> {
    try {
      await this.sandboxes.destroy(machineId);
    } catch (error) {
      return { message: "sandbox destroy failed", fields: { machine_id: machineId, operation }, error };
    }
    this.stale.delete(machineId);
    return null;
  }

  cancelBrowserIdle(agentId: string): void {
    this.browserIdle.cancel(agentId);
  }

  /** Arms an agent's Chrome idle stop: it stops after the idle timeout without a browser call or input. */
  armBrowserIdle(agentId: string): void {
    this.browserIdle.arm(agentId, () => this.stopAgentBrowser(agentId));
  }

  /**
   * Stops the agent's Chrome when its machine runs. Its profile and logins stay in its home.
   * Returns the failure of a stop that did not go through.
   */
  async stopAgentBrowser(agentId: string): Promise<OperationFailure | null> {
    this.cancelBrowserIdle(agentId);
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      return null;
    }
    try {
      const sandbox = await this.sandboxes.connectRunning(agent.machine_id);
      if (sandbox !== null) {
        await this.sandboxes.stopBrowser(sandbox, agentSeat(agent));
      }
      return null;
    } catch (error) {
      return { message: "browser stop failed", fields: { agent_id: agentId, operation: "browser.stop" }, error };
    }
  }

  /**
   * A machine's tier or size changed: an idle container goes now, a busy one once the last
   * generation on it ends. The next work on the machine starts a container of the new size. A
   * container that fails to go is logged and replaced when the machine is next ensured.
   */
  async machineChanged(machineId: string): Promise<void> {
    this.stale.add(machineId);
    if (this.generations.isMachineBusy(machineId)) {
      return;
    }
    this.cancelIdle(machineId);
    logOperationFailure(await this.destroyContainer(machineId, "sandbox.refresh"));
  }

  /**
   * A deleted machine: its container goes, and its directory with it. A container that fails to
   * go is logged and retried by the machine's idle stop.
   */
  async deleteMachine(machineId: string): Promise<void> {
    this.cancelIdle(machineId);
    this.stale.delete(machineId);
    const failure = await this.destroyContainer(machineId, "machine.delete");
    if (failure !== null) {
      logOperationFailure(failure);
      this.armIdle(machineId);
    }
    const directory = machineDirectory(await this.workspaceRootFor(machineId), machineId);
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /**
   * The agent's browser settings changed: its Chrome stops, and the next browser call or Browser
   * tab starts it again with them. Other agents on the machine keep theirs.
   */
  async agentBrowserChanged(agentId: string): Promise<void> {
    logOperationFailure(await this.stopAgentBrowser(agentId));
  }

  /** The agent's Chrome for the Browser tab: its machine woken, its display and noVNC up. */
  async ensureBrowser(agentId: string): Promise<unknown> {
    const agent = await this.generations.runnableAgent(agentId);
    const config = this.validConfig(agent);
    if (!config.browser) {
      throw new RunRequestError(409, "browser is not enabled");
    }
    const sandbox = await this.wakeSandbox(agentId);
    this.touched.set(agentId, agent.machine_id);
    await this.startAgentBrowser(agent, sandbox);
    return sandbox;
  }

  /** Starts the agent's Chrome on its machine and arms its idle stop. */
  async startAgentBrowser(agent: AgentRow, sandbox: SandboxHandle): Promise<void> {
    const agentId = agent.id;
    try {
      await this.sandboxes.startBrowser(sandbox, agentSeat(agent));
    } catch (error) {
      if (error instanceof SandboxError) {
        throw new RunRequestError(503, error.message);
      }
      throw error;
    }
    this.armBrowserIdle(agentId);
  }

  async browserProxyTarget(agentId: string): Promise<[string, Record<string, string>]> {
    const agent = await this.generations.runnableAgent(agentId);
    const sandbox = await this.sandboxes.connectRunning(agent.machine_id);
    if (sandbox === null) {
      throw new RunRequestError(503, "sandbox is not running");
    }
    try {
      return await this.sandboxes.novncTarget(sandbox, agentSeat(agent));
    } catch {
      throw new RunRequestError(503, "browser view is unavailable");
    }
  }

  /** Wakes the agent's machine and starts the agent's terminal in its home. */
  async ensureCli(agentId: string): Promise<unknown> {
    const agent = await this.generations.runnableAgent(agentId);
    const sandbox = await this.wakeSandbox(agentId);
    this.touched.set(agentId, agent.machine_id);
    await this.startCliOn(sandbox, agent);
    return sandbox;
  }

  /** The agent's config, refused with 422 when it does not validate. */
  private validConfig(agent: AgentRow): AgentConfig {
    try {
      return validateAgentConfig(agent.config);
    } catch (error) {
      if (error instanceof AgentValidationError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
  }

  /**
   * The agent's machine, running: the container as is while an agent on it generates, otherwise
   * ensured, with the agent's home ready and the machine's idle timer armed.
   */
  async wakeSandbox(agentId: string): Promise<SandboxHandle> {
    const agent = await this.generations.runnableAgent(agentId);
    const config = this.validConfig(agent);
    const machine = agentMachine(agent);
    try {
      const root = await this.workspaceRootFor(machine.id);
      if (config.browser) {
        prepareBrowserWorkspace(root, machine.id, agentId);
      } else {
        prepareWorkspace(root, machine.id, agentId);
      }
    } catch (error) {
      throw new RunRequestError(503, errorMessage(error));
    }
    if (this.generations.isMachineBusy(machine.id)) {
      const sandbox = await this.sandboxes.connectRunning(machine.id);
      if (sandbox === null) {
        throw new RunRequestError(503, "sandbox is not running");
      }
      return sandbox;
    }
    let sandbox: SandboxHandle;
    try {
      sandbox = await this.sandboxes.ensure(machine);
    } catch (error) {
      if (error instanceof SandboxError) {
        throw new RunRequestError(503, error.message);
      }
      throw error;
    }
    this.stale.delete(machine.id);
    this.armIdle(machine.id);
    this.reportHarnesses(machine.id);
    return sandbox;
  }

  /**
   * Keeps on the machine's row the harness CLIs its container carries, as the provider read
   * them when it created the container.
   */
  reportHarnesses(machineId: string): void {
    const listed = this.sandboxes.harnessesOf?.(machineId) ?? null;
    if (listed === null || this.harnessReports.get(machineId) === listed.join(" ")) {
      return;
    }
    this.harnessReports.set(machineId, listed.join(" "));
    void Promise.resolve(this.db.setMachineHarnesses?.(machineId, listed)).catch((error: unknown) => {
      writeLog("warn", errorMessage(error), { operation: "machine.harnesses", error_type: errorName(error) });
    });
  }

  async cliProxyTarget(agentId: string): Promise<[string, Record<string, string>]> {
    const agent = await this.generations.runnableAgent(agentId);
    const sandbox = await this.sandboxes.connectRunning(agent.machine_id);
    if (sandbox === null) {
      throw new RunRequestError(503, "sandbox is not running");
    }
    const token = await this.startCliOn(sandbox, agent);
    try {
      return await this.sandboxes.cliTarget(sandbox, agentSeat(agent), token);
    } catch {
      throw new RunRequestError(503, "terminal is unavailable");
    }
  }

  private async startCliOn(sandbox: SandboxHandle, agent: AgentRow): Promise<string> {
    try {
      return await this.sandboxes.startCli(sandbox, agentSeat(agent));
    } catch (error) {
      if (error instanceof SandboxError) {
        throw new RunRequestError(503, error.message);
      }
      throw error;
    }
  }

  /**
   * Operator input on a proxied Browser or CLI view counts as activity: the armed idle timers of
   * the agent's machine and of its Chrome restart.
   */
  touchSandbox(agentId: string): void {
    if (this.browserIdle.has(agentId)) {
      this.armBrowserIdle(agentId);
    }
    const known = this.touched.get(agentId);
    if (known !== undefined) {
      this.touchMachine(known);
      return;
    }
    void this.db.getAgent(agentId).then(
      (agent) => {
        if (agent !== null) {
          this.touched.set(agentId, agent.machine_id);
          this.touchMachine(agent.machine_id);
        }
      },
      () => undefined,
    );
  }

  /** Input on a running machine's views arms its idle stop again. */
  private touchMachine(machineId: string): void {
    if (!this.generations.isMachineBusy(machineId) && this.idle.has(machineId)) {
      this.armIdle(machineId);
    }
  }

  /**
   * Stops the agent's processes on its machine when it runs, and removes its runtime files and
   * its home. The machine's container stays up for the other agents on it. Returns the failure
   * of a stop that did not go through; the home goes either way.
   */
  async removeAgent(agent: AgentRow): Promise<OperationFailure | null> {
    const agentId = agent.id;
    const machineId = agent.machine_id;
    this.cancelBrowserIdle(agentId);
    this.touched.delete(agentId);
    const failure = await this.purgeAgentProcesses(agent);
    const workspace = agentDirectory(await this.workspaceRootFor(machineId), machineId, agentId);
    if (existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true });
    }
    return failure;
  }

  /**
   * Stops the agent's processes and removes its runtime files on its machine when it runs;
   * returns the failure of a stop that did not go through.
   */
  private async purgeAgentProcesses(agent: AgentRow): Promise<OperationFailure | null> {
    const sandbox = await this.sandboxes.connectRunning(agent.machine_id);
    if (sandbox === null) {
      return null;
    }
    try {
      await this.sandboxes.purgeAgent(sandbox, agentSeat(agent));
      return null;
    } catch (error) {
      return {
        message: "agent stop failed",
        fields: { agent_id: agent.id, machine_id: agent.machine_id, operation: "agent.stop" },
        error,
      };
    }
  }

  /**
   * Moves an agent to another machine of its organisation: its processes stop on the one it
   * leaves, its home moves with it, and it takes the lowest free slot on the other. Both machines
   * must keep their directories under one workspace root. A home that moved is moved back when
   * the database refuses the move.
   */
  async moveAgent(
    agentId: string,
    machineId: string,
    limits: AgentMoveLimits = {},
  ): Promise<void> {
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      throw new RunRequestError(404, "agent not found");
    }
    const from = agent.machine_id;
    if (from === machineId) {
      return;
    }
    const { source, target } = await this.assertMovable(agentId, from, machineId);
    this.generations.holdAgent(agentId);
    this.touched.delete(agentId);
    try {
      this.cancelBrowserIdle(agentId);
      const sandbox = await this.sandboxes.connectRunning(from);
      if (sandbox !== null) {
        await this.sandboxes.purgeAgent(sandbox, agentSeat(agent));
      }
      const homeMoved = existsSync(source);
      if (homeMoved) {
        mkdirSync(path.dirname(target), { recursive: true });
        renameSync(source, target);
      }
      try {
        if ((await this.db.moveAgent(agentId, machineId, limits)) === null) {
          throw new RunRequestError(404, "agent not found");
        }
      } catch (error) {
        if (homeMoved) {
          renameSync(target, source);
        }
        throw error;
      }
    } finally {
      this.generations.releaseAgent(agentId);
    }
  }

  /** Refuses a move of a busy agent, across hosts, or onto a home already there. */
  private async assertMovable(
    agentId: string,
    from: string,
    to: string,
  ): Promise<{ source: string; target: string }> {
    if (this.generations.isAgentBusy(agentId)) {
      throw new RunRequestError(409, "agent is already generating");
    }
    const sourceRoot = await this.workspaceRootFor(from);
    const targetRoot = await this.workspaceRootFor(to);
    if (path.resolve(sourceRoot) !== path.resolve(targetRoot)) {
      throw new RunRequestError(409, "the machines keep their homes on different hosts");
    }
    const target = agentDirectory(targetRoot, to, agentId);
    if (existsSync(target)) {
      throw new RunRequestError(409, "the target machine already holds a home for this agent");
    }
    return { source: agentDirectory(sourceRoot, from, agentId), target };
  }

  /** The agent's home on the host: its folder in its machine's directory; refused for an agent that is gone. */
  async agentWorkspace(agent: AgentRow | null): Promise<string> {
    if (agent === null) {
      throw new AgentGoneError();
    }
    const machineId = agent.machine_id;
    return agentDirectory(await this.workspaceRootFor(machineId), machineId, agent.id);
  }

  /** Where the machine's directory is kept: its host's workspace root, or core's one root. */
  async workspaceRootFor(machineId: string): Promise<string> {
    if (!this.sandboxes.machineHost) {
      return this.workspaceRoot;
    }
    const host = await this.sandboxes.machineHost(machineId);
    if (!host) {
      return this.workspaceRoot;
    }
    return host.workspaceRoot;
  }
}
