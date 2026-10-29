import type { AttachmentRef, AttachmentService } from "../attachments/index.js";
import type { ArtifactFiles } from "../artifacts/files.js";
import { deleteAgent, getAgent, listAgents } from "../db/agents.js";
import { deleteGuild, getGuild } from "../db/guilds.js";
import { getOrgModelProvider } from "../db/orgs.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import {
  appendRunError,
  completeGroupDelivery,
  completeRun,
  getRun,
  insertMessage,
  listActiveRuns,
  listRuns,
  nextGeneration,
  nextSeq,
  reopenRun,
  type RunRow,
} from "../db/runs.js";
import { runItem } from "../db/views.js";
import { guildGroupChat, type GroupChat, type GroupDelivery, type GroupRunner } from "../groupchat/index.js";
import type { GroupRouter } from "../groupchat/router.js";
import { guildIssues, type Issues } from "../issues/index.js";
import { sleep } from "../lib/event.js";
import { coreModelCredentials, type ModelCredentialsProvider } from "../llm/credentials.js";
import type { NotesStore } from "../notes/store.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";
import { OPEN_POLICY, type OrgPolicy } from "../policy/index.js";
import { agentSchedules, type Schedules } from "../schedules/service.js";
import { agentScripts, type Scripts } from "../scripts/catalog.js";
import { defaultGroupRouter } from "../typesafe/index.js";
import { AdmissionCoordinator } from "../admission/coordinator.js";
import { ActiveGenerations, activeGenerationsDatabase } from "./active-generations.js";
import { continuedBy, RunChains, runChainsDatabase } from "./chain.js";
import { CodingRuns, codingRunsDatabase } from "./coding.js";
import { generationLive, ModelCompletion, modelCompletionDatabase } from "./completion.js";
import { ConflictError, RunRequestError } from "./errors.js";
import { RunEvents, runEventsDatabase } from "./events.js";
import { RunGenerator, runGeneratorDatabase, runWasResumed } from "./generate.js";
import { AgentMachines, agentMachinesDatabase, type GenerationSandboxes } from "./machines.js";
import { RunPreparation, runPreparationDatabase, type ConnectorPool } from "./prepare.js";
import { RunSecrets, runSecretsDatabase } from "./run-secrets.js";
import { Runs, runsDatabase } from "./runs.js";
import { ToolCalls, toolCallsDatabase } from "./tool-calls.js";
import { WorkspaceLimits, workspaceLimitsDatabase } from "./workspace.js";
import type { GenerationArtifacts } from "./prepare.js";

export { RunRequestError } from "./errors.js";

/** How long a loop's machines wait idle before they stop, and how often its scheduler wakes the due schedules. */
export type GenerationLoopTimings = { idleTimeoutMs: number; schedulerTickMs: number };

export const LOOP_TIMINGS: GenerationLoopTimings = { idleTimeoutMs: 5 * 60 * 1000, schedulerTickMs: 30_000 };

const TERMINAL_CAP_OPERATIONS = new Set([
  "generation.max_tool_calls",
  "generation.max_input_tokens",
  "generation.max_chain",
]);

/** Whether the run ended on its tool-call, input-token, or chain cap, which a resume cannot lift. */
function runHitTerminalCap(run: RunRow): boolean {
  return run.errors.some((entry) => TERMINAL_CAP_OPERATIONS.has(entry.operation));
}

/** The db/ functions the loop's own run and delete operations read and write through, on `db`. */
function loopDatabase(db: Queryable) {
  return {
    getRun: bindQuery(db, getRun),
    getAgent: bindQuery(db, getAgent),
    getGuild: bindQuery(db, getGuild),
    listAgents: bindQuery(db, listAgents),
    listRuns: bindQuery(db, listRuns),
    listActiveRuns: bindQuery(db, listActiveRuns),
    nextGeneration: bindQuery(db, nextGeneration),
    nextSeq: bindQuery(db, nextSeq),
    insertMessage: bindQuery(db, insertMessage),
    appendRunError: bindQuery(db, appendRunError),
    completeRun: bindQuery(db, completeRun),
    reopenRun: bindQuery(db, reopenRun),
    completeGroupDelivery: bindQuery(db, completeGroupDelivery),
    deleteAgent: bindQuery(db, deleteAgent),
    deleteGuild: bindQuery(db, deleteGuild),
    getOrgModelProvider: bindQuery(db, getOrgModelProvider),
  };
}

/** The db/ functions a generation loop and each of its parts read and write through, on `db`. */
function generationDatabase(db: Queryable) {
  return {
    ...activeGenerationsDatabase(db),
    ...runEventsDatabase(db),
    ...agentMachinesDatabase(db),
    ...runPreparationDatabase(db),
    ...modelCompletionDatabase(db),
    ...codingRunsDatabase(db),
    ...workspaceLimitsDatabase(db),
    ...toolCallsDatabase(db),
    ...runSecretsDatabase(db),
    ...runsDatabase(db),
    ...runChainsDatabase(db),
    ...runGeneratorDatabase(db),
    ...loopDatabase(db),
  };
}

export type GenerationDatabase = ReturnType<typeof generationDatabase>;

/**
 * What a generation loop runs with beside its database, built once at composition: its notes
 * and machines, and the services its runs call. A service left out takes core's own.
 */
export type GenerationLoopServices = {
  notes: NotesStore;
  /** Where machine directories are kept when the provider names no host for a machine. */
  workspaceRoot: string;
  sandboxes: GenerationSandboxes;
  /** The pool runs list and call connection tools through. */
  mcp: ConnectorPool;
  artifacts?: GenerationArtifacts | null;
  files?: ArtifactFiles | null;
  attachments?: AttachmentService | null;
  /** The cap on generations this loop shares with Studio and Builder sessions. */
  admission?: AdmissionCoordinator;
  policy?: OrgPolicy;
  /** What a model provider is called with; core's own rows over `db` when absent. */
  credentials?: ModelCredentialsProvider;
  groupRouter?: GroupRouter;
};

/**
 * What a generation loop is built from: its services, the db/ functions it and its parts go
 * through, and the other domains its runs read and write through.
 */
export type GenerationLoopDeps = GenerationLoopServices & {
  db: GenerationDatabase;
  /** The chat the loop delivers group runs from; it asks the loop whether a guild is being deleted. */
  groupChat: GroupChat;
  groupRouter: GroupRouter;
  issues: Issues;
  schedules: Schedules;
  scripts: Scripts;
};

/**
 * The generation loop: runs are created, generated, cancelled, resumed, and reconciled after
 * a restart here, each part of a generation in the module named for it, and agents, guilds,
 * and machines are deleted or moved without a generation under way on them.
 */
export class GenerationLoop implements GroupRunner {
  db: GenerationDatabase;
  notes: NotesStore;
  mcp: ConnectorPool;
  groupChat: GroupChat;
  issues: Issues;
  schedules: Schedules;
  scripts: Scripts;
  artifacts: GenerationArtifacts | null;
  files: ArtifactFiles | null;
  attachments: AttachmentService | null;
  policy: OrgPolicy;
  credentials: ModelCredentialsProvider;
  generations: ActiveGenerations;
  events: RunEvents;
  machines: AgentMachines;
  preparation: RunPreparation;
  completion: ModelCompletion;
  coding: CodingRuns;
  workspace: WorkspaceLimits;
  toolCalls: ToolCalls;
  secrets: RunSecrets;
  chains: RunChains;
  generator: RunGenerator;
  runs: Runs;
  constructor(services: GenerationLoopDeps, timings: GenerationLoopTimings = LOOP_TIMINGS) {
    const { db, notes, workspaceRoot, sandboxes } = services;
    this.db = db;
    this.notes = notes;
    this.mcp = services.mcp;
    this.artifacts = services.artifacts ?? null;
    this.files = services.files ?? null;
    this.attachments = services.attachments ?? null;
    this.policy = services.policy ?? OPEN_POLICY;
    this.generations = new ActiveGenerations(db, services.admission ?? new AdmissionCoordinator(), this.policy);
    this.events = new RunEvents(db);
    this.credentials = services.credentials ?? coreModelCredentials(db);
    this.machines = new AgentMachines({ db, sandboxes, workspaceRoot, generations: this.generations }, timings.idleTimeoutMs);
    const { groupRouter } = services;
    this.groupChat = services.groupChat;
    this.groupChat.bind(this);
    this.issues = services.issues;
    this.schedules = services.schedules;
    this.scripts = services.scripts;
    this.preparation = new RunPreparation({
      db,
      notes,
      artifacts: this.artifacts,
      mcp: this.mcp,
      scripts: this.scripts,
      groupRouter,
      generations: this.generations,
      machines: this.machines,
    });
    this.completion = new ModelCompletion({
      db,
      generations: this.generations,
      events: this.events,
      policy: this.policy,
      credentials: this.credentials,
      attachments: this.attachments,
    });
    this.secrets = new RunSecrets(db, this.machines);
    this.coding = new CodingRuns({ db, generations: this.generations, machines: this.machines, events: this.events });
    this.workspace = new WorkspaceLimits(db, this.events);
    this.toolCalls = new ToolCalls({
      db,
      mcp: this.mcp,
      events: this.events,
      generations: this.generations,
      machines: this.machines,
      coding: this.coding,
    });
    this.runs = new Runs(
      {
        db,
        preparation: this.preparation,
        generations: this.generations,
        schedules: this.schedules,
        starter: this,
      },
      timings.schedulerTickMs,
    );
    this.chains = new RunChains({ db, events: this.events, completion: this.completion, runs: this.runs });
    this.generator = new RunGenerator({
      db,
      notes,
      artifacts: this.artifacts,
      files: this.files,
      groupChat: this.groupChat,
      issues: this.issues,
      schedules: this.schedules,
      scripts: this.scripts,
      events: this.events,
      generations: this.generations,
      machines: this.machines,
      completion: this.completion,
      coding: this.coding,
      workspace: this.workspace,
      toolCalls: this.toolCalls,
      secrets: this.secrets,
      chains: this.chains,
      starter: this,
    });
  }

  isGenerating(runId: string): boolean {
    return this.generations.isGenerating(runId);
  }

  get lockGeneration(): number {
    return this.generations.lockGeneration;
  }

  async deliverGroupRun(delivery: GroupDelivery): Promise<void> {
    await this.runs.deliverGroupRun(delivery);
  }

  async close(): Promise<void> {
    const scheduler = this.runs.stopScheduler();
    this.machines.cancelTimers();
    await scheduler;
    await this.groupChat.stopDispatchers();
    const runIds = this.generations.runIds();
    for (const runId of runIds) {
      this.generations.cancelEvent(runId)?.set();
      await this.interruptCommand(runId);
    }
    const tasks = runIds.flatMap((runId) => {
      const task = this.generations.task(runId);
      return task ? [task] : [];
    });
    if (tasks.length) {
      const abortWait = new AbortController();
      await Promise.race([
        Promise.allSettled(tasks),
        sleep(generationLive.shutdownTimeoutMs, abortWait.signal),
      ]);
      abortWait.abort();
    }
  }

  /** Interrupts the command the run waits on in its sandbox, when there is one. */
  private async interruptCommand(runId: string): Promise<void> {
    const command = this.generations.command(runId);
    if (command === null) {
      return;
    }
    try {
      await command[0].commands.interrupt?.(command[1]);
    } catch (error) {
      writeLog(
        "error",
        "command.interrupt failed",
        {
          run_id: runId,
          agent_id: this.generations.agentOf(runId),
          operation: "command.interrupt",
          error_type: errorName(error),
        },
        error,
      );
    }
  }

  isDeletingGuild(guildId: string): boolean {
    return this.generations.isDeletingGuild(guildId);
  }

  isAgentBusy(agentId: string): boolean {
    return this.generations.isAgentBusy(agentId);
  }

  async cancelAgentRuns(agentId: string): Promise<void> {
    for (const runId of this.generations.runIdsOf(agentId)) {
      try {
        await this.cancel(runId);
      } catch (error) {
        // The run ended before the cancel reached it.
        if (!(error instanceof RunRequestError)) {
          throw error;
        }
      }
    }
  }

  async waitForLockRelease(seen: number): Promise<void> {
    return this.generations.waitForLockRelease(seen);
  }

  async deleteAgent(agentId: string): Promise<void> {
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      throw new RunRequestError(404, "agent not found");
    }
    this.generations.holdAgent(agentId);
    try {
      await this.machines.removeAgent(agent);
      await this.notes.deleteAgent(agent.org_slug, agent.guild_name, agent.name);
      await this.db.deleteAgent(agentId);
    } finally {
      this.generations.releaseAgent(agentId);
    }
  }

  async deleteGuild(guildId: string): Promise<void> {
    const guild = await this.db.getGuild(guildId);
    if (guild === null) {
      throw new RunRequestError(404, "guild not found");
    }
    if (this.generations.isDeletingGuild(guildId)) {
      throw new RunRequestError(409, "guild is already being deleted");
    }
    if (this.groupChat.is_dispatching(guildId)) {
      throw new RunRequestError(409, "guild group chat is delivering");
    }
    const agentIds = (await this.db.listAgents(guildId)).map((row) => row.id);
    this.generations.holdGuild(guildId, agentIds);
    try {
      for (const agentId of agentIds) {
        const agent = await this.db.getAgent(agentId);
        if (agent !== null) {
          await this.machines.removeAgent(agent);
        }
      }
      await this.notes.deleteGuild(guild.org_slug, guild.name);
      await this.db.deleteGuild(guildId);
    } finally {
      this.generations.releaseGuild(guildId, agentIds);
    }
  }

  async resumeRun(runId: string): Promise<Record<string, unknown>> {
    const run = await this.db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    if (run.status === "active") {
      return this.runView(run);
    }
    if (run.status !== "completed") {
      throw new RunRequestError(409, "run cannot be resumed");
    }
    const next = continuedBy(run);
    if (next !== null) {
      throw new RunRequestError(409, `this run continued in run ${await this.chains.latestInChain(next)}`);
    }
    if (runHitTerminalCap(run)) {
      throw new RunRequestError(409, "this run hit its tool, token, or chain cap; start a new run");
    }
    if ((await this.db.getAgent(run.agent_id)) === null) {
      throw new RunRequestError(404, "agent not found");
    }
    await this.db.reopenRun(runId, new Date());
    return this.currentRunView(runId);
  }

  /** Adds the operator's message to the run as its next generation, and generates it. */
  async addMessage(
    runId: string,
    content: string,
    attachments: AttachmentRef[] = [],
  ): Promise<Record<string, unknown>> {
    const run = await this.runTakingMessages(runId);
    try {
      await this.beginGeneration(runId, run.agent_id);
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new RunRequestError(409, error.message);
      }
      throw error;
    }
    let generation: number;
    try {
      generation = await this.insertOperatorMessage(run, content, attachments);
    } catch (error) {
      this.endGeneration(runId);
      throw error;
    }
    this.generateInBackground(runId, generation);
    return this.currentRunView(runId);
  }

  /** The run, refused unless it takes an operator's message: active, direct or resumed, and not continued. */
  private async runTakingMessages(runId: string): Promise<RunRow> {
    const run = await this.db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    if (run.kind !== "direct" && !runWasResumed(run)) {
      throw new RunRequestError(409, `${run.kind}-triggered runs do not accept later messages`);
    }
    const next = continuedBy(run);
    if (next !== null) {
      throw new RunRequestError(409, `this run continued in run ${await this.chains.latestInChain(next)}; send the message there`);
    }
    if (run.status !== "active") {
      throw new RunRequestError(409, "this run has ended; resume it to continue");
    }
    return run;
  }

  /** Inserts the operator's message as the run's next generation, with the run's secrets synced; returns its number. */
  private async insertOperatorMessage(run: RunRow, content: string, attachments: AttachmentRef[]): Promise<number> {
    const now = new Date();
    const generation = await this.db.nextGeneration(run.id);
    const agent = await this.db.getAgent(run.agent_id);
    const seq = await this.db.nextSeq(run.id);
    if (agent !== null) {
      await this.secrets.sync(agent);
    }
    await this.db.insertMessage(
      {
        runId: run.id,
        seq,
        payload: { role: "user", content },
        metadata: { generation, source: "ui", ...(attachments.length ? { attachments } : {}) },
      },
      now,
    );
    return generation;
  }

  async cancel(runId: string): Promise<Record<string, unknown> | null> {
    const run = await this.db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    if (run.status !== "active") {
      throw new RunRequestError(409, "run is not active");
    }
    if (!this.generations.isGenerating(runId)) {
      return null;
    }
    this.generations.cancelEvent(runId)?.set();
    await this.interruptCommand(runId);
    const task = this.generations.task(runId);
    if (task) {
      const abortWait = new AbortController();
      await Promise.race([task, sleep(generationLive.cancelGraceMs, abortWait.signal)]);
      abortWait.abort();
      await task;
    }
    const row = await this.db.getRun(runId);
    return row ? this.runView(row) : null;
  }

  async reconcile(): Promise<void> {
    const now = new Date();
    for (const run of await this.db.listActiveRuns()) {
      await this.toolCalls.resolveUnresolved(run.id, null);
      if (run.kind === "direct" || runWasResumed(run)) {
        continue;
      }
      const entry = {
        at: now.toISOString(),
        generation: 1,
        operation: "generation.interrupted",
        error_type: "Interrupted",
        message: "orchestrator restarted",
      };
      await this.db.appendRunError(run.id, entry, now);
      if (run.kind === "group") {
        const through = run.group_chat_through_seq;
        await this.db.completeGroupDelivery(run.id, run.agent_id, through || 0, now);
      } else {
        await this.db.completeRun(run.id, now);
      }
    }
    await this.groupChat.resume_all();
    await this.machines.armIdleForRunning();
  }

  async listRunViews(agentId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.db.listRuns(agentId)).map((item) => this.runView(item));
  }

  runView(row: RunRow): Record<string, unknown> {
    return runItem(row, this.isGenerating(row.id));
  }

  private async currentRunView(runId: string): Promise<Record<string, unknown>> {
    const row = await this.db.getRun(runId);
    if (row === null) {
      throw new RunRequestError(404, "run not found");
    }
    return this.runView(row);
  }

  /** Admits a generation of the run on its agent; the agent's machine stops counting down to its idle stop. */
  async beginGeneration(runId: string, agentId: string): Promise<void> {
    const machineId = await this.generations.begin(runId, agentId);
    if (machineId !== null) {
      this.machines.cancelIdle(machineId);
    }
  }

  /**
   * Ends the run's generation. The machine it ran on, once no agent generates there, goes when
   * it changed meanwhile and otherwise counts down to its idle stop.
   */
  endGeneration(runId: string): void {
    const machineId = this.generations.end(runId);
    if (machineId !== null && !this.generations.isMachineBusy(machineId)) {
      this.machines.releaseMachine(machineId);
    }
  }

  /** Generates the run without waiting for it; a failure the generation does not record is logged. */
  generateInBackground = (runId: string, generation: number): void => {
    this.generations.setTask(
      runId,
      this.generator.generate(runId, generation).catch((error) => {
        writeLog(
          "error",
          errorMessage(error),
          { run_id: runId, operation: "generation", error_type: errorName(error) },
          error,
        );
      }),
    );
  };

}

/** The generation loop of the runs on `db`, run with `services` and `timings`. */
export function generationLoop(
  db: Queryable,
  services: GenerationLoopServices,
  timings: GenerationLoopTimings = LOOP_TIMINGS,
): GenerationLoop {
  const groupRouter = services.groupRouter ?? defaultGroupRouter();
  // The chat is called after the loop below is built, and asks it whether a guild is being deleted.
  const groupChat = guildGroupChat(db, {
    is_deleting: (guildId) => loop.isDeletingGuild(guildId),
    router: groupRouter,
  });
  const loop = new GenerationLoop(
    {
      ...services,
      db: generationDatabase(db),
      groupChat,
      groupRouter,
      issues: guildIssues(db),
      schedules: agentSchedules(db),
      scripts: agentScripts(db),
    },
    timings,
  );
  return loop;
}
