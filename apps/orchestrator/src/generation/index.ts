

import { isPlainRecord } from "../db/json.js";
import { runItem } from "../db/views.js";
import {
  GroupChat,
  groupChatDatabase,
  type GroupDelivery,
  type GroupRunner,
} from "../groupchat/index.js";

import { OPEN_POLICY, type OrgPolicy } from "../policy/index.js";

import { type AttachmentRef, type AttachmentService } from "../attachments/index.js";

import {
  coreModelCredentials,
  type ModelCredentialsProvider,
} from "../llm/credentials.js";

import { sleep } from "../lib/event.js";

import { mcpDatabase, McpPool } from "../mcp/index.js";
import {
  ArtifactFiles,
  ArtifactStore,
} from "../artifacts/index.js";
import { type NotesStore } from "../notes/store.js";

import { errorMessage, errorName, writeLog } from "../observability/log.js";

import { Scripts } from "../scripts/catalog.js";

import { Schedules } from "../schedules/service.js";

import {
  defaultGroupRouter,
  type GroupRouter,
} from "../typesafe/index.js";
import { ActiveGenerations, AdmissionCoordinator } from "./admission.js";
import { CodingRuns } from "./coding.js";
import { WorkspaceLimits } from "./workspace.js";
import { generationLive, ModelCompletion } from "./completion.js";
import { RunEvents } from "./events.js";
import { RunPreparation, type ConnectorPool } from "./prepare.js";
import { RunSecrets } from "./run-secrets.js";
import { Runs } from "./runs.js";
import { RunGenerator, runWasResumed } from "./generate.js";
import { AgentMachines, type GenerationSandboxes } from "./machines.js";
import { continuedBy, RunChains } from "./chain.js";
import { withRemainingToolCalls as _withRemainingToolCalls } from "../toolbox/index.js";

import { Issues } from "../issues/index.js";

import {
  appendRunError,
  completeGroupDelivery,
  completeRun,
  createGroupRun,
  createRun,
  createScheduleRun,
  getRun,
  insertMessage,
  listActiveRuns,
  listMessages,
  listPayloads,
  listRuns,
  mergeRunMetadata,
  nextGeneration,
  nextSeq,
  reopenRun,
  updateRunScripts,
  updateRunSecrets,
  type RunRow,
} from "../db/runs.js";
import {
  clearHarnessLogin,
  deleteAgent,
  deleteAgentScript,
  getAgent,
  getAgentScript,
  listAgentScripts,
  listAgents,
  markHarnessLogin,
  setAgentWorkspaceMib,
  upsertAgentScript,
} from "../db/agents.js";
import { deleteGuild, getGuild, listGuildRepositories } from "../db/guilds.js";
import { listGroupMessages } from "../db/group-chat.js";
import { moveAgent, setMachineHarnesses, setMachineWorkspaceMib } from "../db/machines.js";
import {
  deleteSchedule,
  getSchedule,
  insertSchedule,
  listDueSchedules,
  listSchedules,
  listSchedulesForGuild,
  markScheduleFired,
  pauseSchedule,
  resumeSchedule,
  setScheduleNextRun,
  updateSchedule,
} from "../db/schedules.js";
import { listActiveRunAgentIdsForSecret } from "../db/secrets.js";
import { getMcpConnection, getMcpConnectionForOwner, saveMcpConnection } from "../db/mcp.js";
import { getMcpServer } from "../db/connectors.js";
import {
  countOpenIssues,
  getIssue,
  insertIssue,
  listIssuesForGuild,
  resolveOpenIssues,
  setIssueStatus,
} from "../db/issues.js";
import { getOrgMonthlyUsage } from "../db/usage.js";
import { getOrgModelProvider } from "../db/orgs.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import { agentSecretsDatabase } from "../secrets/agent.js";

import {
  ConflictError,
  RunRequestError,
} from "./errors.js";

import { ToolCalls } from "./tool-calls.js";

export { RunRequestError } from "./errors.js";

const SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SCHEDULER_TICK_MS = 30_000;

const TERMINAL_CAP_OPERATIONS = new Set([
  "generation.max_tool_calls",
  "generation.max_input_tokens",
  "generation.max_chain",
]);

/** Whether the run ended on its tool-call, input-token, or chain cap, which a resume cannot lift. */
function runHitTerminalCap(run: RunRow): boolean {
  return run.errors.some((entry) => isPlainRecord(entry) && TERMINAL_CAP_OPERATIONS.has(String(entry.operation ?? "")));
}

/** The db/ functions a generation reads and writes through, on `db`. */
export function generationDatabase(db: Queryable) {
  return {
    ...mcpDatabase(db),
    ...agentSecretsDatabase(db),
    ...groupChatDatabase(db),
    getRun: bindQuery(db, getRun),
    getAgent: bindQuery(db, getAgent),
    getGuild: bindQuery(db, getGuild),
    listAgents: bindQuery(db, listAgents),
    listRuns: bindQuery(db, listRuns),
    listActiveRuns: bindQuery(db, listActiveRuns),
    listGroupMessages: bindQuery(db, listGroupMessages),
    createRun: bindQuery(db, createRun),
    createGroupRun: bindQuery(db, createGroupRun),
    createScheduleRun: bindQuery(db, createScheduleRun),
    insertMessage: bindQuery(db, insertMessage),
    listMessages: bindQuery(db, listMessages),
    listPayloads: bindQuery(db, listPayloads),
    nextSeq: bindQuery(db, nextSeq),
    nextGeneration: bindQuery(db, nextGeneration),
    appendRunError: bindQuery(db, appendRunError),
    mergeRunMetadata: bindQuery(db, mergeRunMetadata),
    markHarnessLogin: bindQuery(db, markHarnessLogin),
    clearHarnessLogin: bindQuery(db, clearHarnessLogin),
    setMachineHarnesses: bindQuery(db, setMachineHarnesses),
    completeRun: bindQuery(db, completeRun),
    reopenRun: bindQuery(db, reopenRun),
    completeGroupDelivery: bindQuery(db, completeGroupDelivery),
    updateRunSecrets: bindQuery(db, updateRunSecrets),
    updateRunScripts: bindQuery(db, updateRunScripts),
    listDueSchedules: bindQuery(db, listDueSchedules),
    markScheduleFired: bindQuery(db, markScheduleFired),
    listActiveRunAgentIdsForSecret: bindQuery(db, listActiveRunAgentIdsForSecret),
    deleteAgent: bindQuery(db, deleteAgent),
    deleteGuild: bindQuery(db, deleteGuild),
    getMcpConnection: bindQuery(db, getMcpConnection),
    getMcpServer: bindQuery(db, getMcpServer),
    getAgentScript: bindQuery(db, getAgentScript),
    upsertAgentScript: bindQuery(db, upsertAgentScript),
    listAgentScripts: bindQuery(db, listAgentScripts),
    deleteAgentScript: bindQuery(db, deleteAgentScript),
    insertSchedule: bindQuery(db, insertSchedule),
    deleteSchedule: bindQuery(db, deleteSchedule),
    getSchedule: bindQuery(db, getSchedule),
    pauseSchedule: bindQuery(db, pauseSchedule),
    resumeSchedule: bindQuery(db, resumeSchedule),
    listSchedules: bindQuery(db, listSchedules),
    listSchedulesForGuild: bindQuery(db, listSchedulesForGuild),
    updateSchedule: bindQuery(db, updateSchedule),
    setScheduleNextRun: bindQuery(db, setScheduleNextRun),
    insertIssue: bindQuery(db, insertIssue),
    listIssuesForGuild: bindQuery(db, listIssuesForGuild),
    getIssue: bindQuery(db, getIssue),
    setIssueStatus: bindQuery(db, setIssueStatus),
    resolveOpenIssues: bindQuery(db, resolveOpenIssues),
    countOpenIssues: bindQuery(db, countOpenIssues),
    setAgentWorkspaceMib: bindQuery(db, setAgentWorkspaceMib),
    setMachineWorkspaceMib: bindQuery(db, setMachineWorkspaceMib),
    moveAgent: bindQuery(db, moveAgent),
    listGuildRepositories: bindQuery(db, listGuildRepositories),
    getMcpConnectionForOwner: bindQuery(db, getMcpConnectionForOwner),
    saveMcpConnection: bindQuery(db, saveMcpConnection),
    getOrgMonthlyUsage: bindQuery(db, getOrgMonthlyUsage),
    getOrgModelProvider: bindQuery(db, getOrgModelProvider),
  };
}

export type GenerationDatabase = ReturnType<typeof generationDatabase>;

export class GenerationLoop implements GroupRunner {
  db: GenerationDatabase;
  notes: NotesStore;
  mcp: ConnectorPool;
  groupChat: GroupChat;
  issues: Issues;
  schedules: Schedules;
  scripts: Scripts;
  artifacts: ArtifactStore | null;
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
  constructor(
    db: GenerationDatabase,
    notes: NotesStore,
    workspaceRoot: string,
    sandboxes: GenerationSandboxes,
    options: {
      idleTimeoutMs?: number;
      schedulerTickMs?: number;
      cancelGraceMs?: number;
      shutdownTimeoutMs?: number;
      mcp?: ConnectorPool | null;
      artifacts?: ArtifactStore | null;
      files?: ArtifactFiles | null;
      attachments?: AttachmentService | null;
      admission?: AdmissionCoordinator;
      policy?: OrgPolicy;
      /** What a model provider is called with; core's own rows over `db` when absent. */
      credentials?: ModelCredentialsProvider;
      groupRouter?: GroupRouter;
    } = {},
  ) {
    this.db = db;
    this.notes = notes;
    this.mcp = options.mcp ?? new McpPool();
    this.artifacts = options.artifacts ?? null;
    this.files = options.files ?? null;
    this.attachments = options.attachments ?? null;
    this.policy = options.policy ?? OPEN_POLICY;
    this.generations = new ActiveGenerations(db, options.admission ?? new AdmissionCoordinator(), this.policy);
    this.events = new RunEvents(db);
    this.credentials = options.credentials ?? coreModelCredentials(db);
    this.machines = new AgentMachines(
      { db, sandboxes, workspaceRoot, generations: this.generations },
      options.idleTimeoutMs ?? SANDBOX_IDLE_TIMEOUT_MS,
    );
    if (options.cancelGraceMs !== undefined) {
      generationLive.cancelGraceMs = options.cancelGraceMs;
    }
    if (options.shutdownTimeoutMs !== undefined) {
      generationLive.shutdownTimeoutMs = options.shutdownTimeoutMs;
    }
    const groupRouter = options.groupRouter ?? defaultGroupRouter();
    this.groupChat = new GroupChat(db, {
      is_deleting: (guildId) => this.isDeletingGuild(guildId),
      router: groupRouter,
    });
    this.groupChat.bind(this);
    this.issues = new Issues(db);
    this.schedules = new Schedules(db);
    this.scripts = new Scripts(db);
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
      options.schedulerTickMs ?? SCHEDULER_TICK_MS,
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
      await this.notes.deleteAgent(
        String(agent.org_slug),
        String(agent.guild_name),
        String(agent.name),
      );
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
      await this.notes.deleteGuild(String(guild.org_slug), String(guild.name));
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
    const agent = await this.db.getAgent(String(run.agent_id));
    if (agent === null) {
      throw new RunRequestError(404, "agent not found");
    }
    const now = new Date();
    await this.db.reopenRun(runId, now);
    const row = await this.db.getRun(runId);
    if (row === null) {
      throw new RunRequestError(404, "run not found");
    }
    return this.runView(row);
  }

  async addMessage(
    runId: string,
    content: string,
    attachments: AttachmentRef[] = [],
  ): Promise<Record<string, unknown>> {
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
    try {
      await this.beginGeneration(runId, String(run.agent_id));
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new RunRequestError(409, error.message);
      }
      throw error;
    }
    let generation: number;
    try {
      const now = new Date();
      generation = await this.db.nextGeneration(runId);
      const agent = await this.db.getAgent(String(run.agent_id));
      const seq = await this.db.nextSeq(runId);
      if (agent !== null) {
        await this.secrets.sync(agent);
      }
      await this.db.insertMessage(
        {
          runId,
          seq,
          payload: { role: "user", content },
          metadata: { generation, source: "ui", ...(attachments.length ? { attachments } : {}) },
        },
        now,
      );
    } catch (error) {
      this.endGeneration(runId);
      throw error;
    }
    this.generateInBackground(runId, generation);
    const row = await this.db.getRun(runId);
    if (row === null) {
      throw new RunRequestError(404, "run not found");
    }
    return this.runView(row);
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

  runView(row: Record<string, unknown>): Record<string, unknown> {
    return runItem(row, { generating: this.isGenerating(String(row.id)) });
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
