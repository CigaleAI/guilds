
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_TOOL_CALLS,
  maxScriptsOf,
  secretAliasesOf,
} from "../agents/validation.js";

import {
  agentSecrets,
  applySecretAliases,
  snapshotEnvValues,
} from "../access/runtime.js";
import { decryptPayload } from "../credentials/crypto.js";
import { isPlainRecord, recordOf } from "../db/json.js";
import { runItem } from "../db/views.js";
import {
  GroupChat,
  groupChatDatabase,
  type GroupDelivery,
  type GroupRunner,
} from "../groupchat/index.js";

import { OPEN_POLICY, type OrgPolicy } from "../policy/index.js";
import { countRunInputTokens } from "../attachments/hydrate.js";
import { type AttachmentRef, type AttachmentService } from "../attachments/index.js";

import {
  coreModelCredentials,
  type ModelCredentialsProvider,
} from "../llm/credentials.js";

import { sleep } from "../lib/event.js";
import { type Completion } from "../llm/index.js";

import { mcpDatabase, McpPool } from "../mcp/index.js";
import {
  ArtifactFiles,
  ArtifactStore,
  agentActor,
} from "../artifacts/index.js";
import { type NotesStore } from "../notes/store.js";
import { tokenRedactions } from "../oauth/index.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";

import {
  agentSandbox,
  applyRunScripts,
  prepareWorkspace,
  seatEnvironment,
  type SandboxHandle,
} from "../sandbox/index.js";
import { slotPorts } from "../machines/index.js";
import { agentHome } from "../lib/agent-file.js";
import { Scripts } from "../scripts/catalog.js";
import type { RunScriptSnapshot } from "../scripts/snapshot.js";

import { Schedules } from "../schedules/service.js";

import { readSecretFile, removeSecretFile, storeAgentSecret } from "../secrets/agent.js";

import { instanceRedactions } from "../connectors/instance.js";
import {
  defaultGroupRouter,
  type GroupRouter,
} from "../typesafe/index.js";
import { ActiveGenerations, AdmissionCoordinator } from "./admission.js";
import { CodingRuns, guildRepositories } from "./coding.js";
import { WorkspaceLimits } from "./workspace.js";
import { countInputTokensImpl, generationLive, ModelCompletion } from "./completion.js";
import { RunEvents } from "./events.js";
import { RunPreparation, type ConnectorPool } from "./prepare.js";
import { Runs } from "./runs.js";
import { AgentMachines, agentMachine, agentSeat, type GenerationSandboxes } from "./machines.js";
import {
  chainOf,
  continuedBy,
  HANDOFF_FRACTION,
  HANDOFF_REQUEST,
  HANDOFF_TOOL_REFUSED,
  handoffText,
  MAX_CHAIN_MESSAGE,
  MAX_CHAIN_RUNS,
} from "./chain.js";
import {
  createToolContext,
  remainingAfter,
  stampToolResult,
  withRemainingToolCalls as _withRemainingToolCalls,
} from "../toolbox/index.js";

import {
  harnessModelOf,
  harnessOf,
  REPOSITORIES_MISSING,
  REPOSITORIES_MISSING_MESSAGE,
} from "../coding/harnesses.js";
import { harnessEffortOf } from "../coding/harness-models.js";

import {
  harnessMissingError,
  shownProgressLines,
} from "../toolbox/harness.js";
import type { AgentSecretStore } from "../toolbox/types.js";
import { Issues } from "../issues/index.js";

import { dynamicScriptTools, liveExtraForAgent, SCRIPT_TOOLS } from "../toolbox/script.js";

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
  type AgentRow,
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
  GenerationCancelled,
  RunLimitError,
  RunRequestError,
} from "./errors.js";
import { positiveInt } from "./snapshot.js";
import {
  liveOfferedNames,
  mcpIndex,
  snapshotOfferedNames,
  toolSchemaName,
  withFirstClassScriptTools,
} from "./offered-tools.js";
import { executedToolCalls, ToolCalls, toolCallsOf } from "./tool-calls.js";

export { RunRequestError } from "./errors.js";

export const SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const SCHEDULER_TICK_MS = 30_000;
export const TOOL_CALL_LIMIT_MESSAGE = "Tool call limit reached. Start a new run to continue.";
export const INPUT_TOKEN_LIMIT_MESSAGE = "Input token limit reached. Start a new run to continue.";
export const REMAINING_TOOL_CALLS_PREFIX = "remaining_tool_calls: ";

/** A coding run's prompt reached the hand-off share of its input limit. */
class HandoffDue extends Error {
  constructor() {
    super("hand-off due");
    this.name = "HandoffDue";
  }
}

function runKind(run: Record<string, unknown> | null | undefined): string {
  if (!run) {
    return "direct";
  }
  const kind = run.kind;
  return typeof kind === "string" && kind ? kind : "direct";
}

function runWasResumed(run: Record<string, unknown>): boolean {
  const resumedAt = recordOf(run.metadata).resumed_at;
  return typeof resumedAt === "string" && resumedAt.length > 0;
}

const TERMINAL_CAP_OPERATIONS = new Set([
  "generation.max_tool_calls",
  "generation.max_input_tokens",
  "generation.max_chain",
]);

function runHitTerminalCap(run: Record<string, unknown>): boolean {
  if (!Array.isArray(run.errors)) {
    return false;
  }
  return run.errors.some((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return TERMINAL_CAP_OPERATIONS.has(String((entry as { operation?: unknown }).operation ?? ""));
  });
}

async function tokenRedactionsForConnection(
  db: { getMcpConnection(connectionId: string): Promise<Record<string, unknown> | null> },
  connectionId: string,
): Promise<Record<string, string>> {
  const connection = await db.getMcpConnection(connectionId);
  if (connection === null) {
    return {};
  }
  try {
    const payload = decryptPayload(connection.ciphertext as Buffer, connection.nonce as Buffer);
    return tokenRedactions(payload, connectionId);
  } catch {
    return {};
  }
}

export async function mcpRedactions(
  db: { getMcpConnection(connectionId: string): Promise<Record<string, unknown> | null> },
  snapshot: Record<string, unknown>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const mcp = snapshot.mcp;
  if (!Array.isArray(mcp)) {
    return values;
  }
  for (const group of mcp) {
    if (!isPlainRecord(group) || typeof group.connection_id !== "string") {
      continue;
    }
    Object.assign(values, await tokenRedactionsForConnection(db, group.connection_id));
  }
  return values;
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
  runs: Runs;
  /** A run that handed off, to the run that continues it once its generation ends. */
  _continuations = new Map<string, string>();

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

  /** A secret's value, name, or description changed: the active runs it reaches get a fresh snapshot. */
  async secretChanged(secretId: string): Promise<void> {
    await this.refreshEnvironments(await this.db.listActiveRunAgentIdsForSecret(secretId));
  }

  /** These agents gained or lost a secret: their active runs get a fresh snapshot. */
  async secretAccessChanged(agentIds: string[]): Promise<void> {
    if (!agentIds.length) {
      return;
    }
    const live = new Set((await this.db.listActiveRuns()).map((row) => row.agent_id));
    await this.refreshEnvironments(agentIds.filter((id) => live.has(id)));
  }

  private async refreshEnvironments(agentIds: string[]): Promise<void> {
    for (const agentId of [...new Set(agentIds)].sort()) {
      const agent = await this.db.getAgent(agentId);
      if (agent !== null) {
        await this.syncRunSecrets(agent);
      }
    }
  }

  async syncRunSecrets(agent: AgentRow): Promise<Array<Record<string, string>>> {
    const refs = await agentSecrets(this.db, agent);
    const now = new Date();
    for (const run of await this.db.listRuns(String(agent.id))) {
      if (run.status !== "active") {
        continue;
      }
      const snapshot = recordOf(run.config_snapshot);
      if (JSON.stringify(snapshot.secrets) === JSON.stringify(refs)) {
        continue;
      }
      await this.db.updateRunSecrets(run.id, refs, now);
      snapshot.secrets = refs;
      run.config_snapshot = snapshot;
    }
    return refs;
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
      throw new RunRequestError(409, `this run continued in run ${await this._latest_in_chain(next)}`);
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
    const kind = runKind(run);
    if ((kind === "group" || kind === "schedule") && !runWasResumed(run)) {
      throw new RunRequestError(409, `${kind}-triggered runs do not accept later messages`);
    }
    const next = continuedBy(run);
    if (next !== null) {
      throw new RunRequestError(409, `this run continued in run ${await this._latest_in_chain(next)}; send the message there`);
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
        await this.syncRunSecrets(agent);
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
      const kind = runKind(run);
      if ((kind !== "group" && kind !== "schedule") || runWasResumed(run)) {
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
      if (kind === "group") {
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
      this._generate(runId, generation).catch((error) => {
        writeLog(
          "error",
          errorMessage(error),
          { run_id: runId, operation: "generation", error_type: errorName(error) },
          error,
        );
      }),
    );
  };

  _on_cancel = async (
    runId: string,
    generation: number,
    extra: Record<string, string>,
  ): Promise<void> => {
    await this.toolCalls.resolveUnresolved(runId, generation);
    await this._fail(runId, generation, "generation.cancelled", new GenerationCancelled(), extra);
  };

  async _settle_cancel(
    runId: string,
    generation: number,
    extra: Record<string, string>,
  ): Promise<void> {
    try {
      await this.generations.settlement(runId, () => this._on_cancel(runId, generation, extra));
    } catch (error) {
      writeLog(
        "error",
        "cancel settlement failed",
        { ...extra, operation: "generation.cancelled", error_type: errorName(error) },
        error,
      );
    }
  }

  async _generate(runId: string, generation: number): Promise<void> {
    let extra: Record<string, string> = { run_id: runId };
    let cancelled = false;
    try {
      await this.events.publish(runId, "generation.started", { generation });
      const run = await this.db.getRun(runId);
      if (run === null) {
        return;
      }
      const agent = await this.db.getAgent(String(run.agent_id));
      if (agent === null) {
        await this._fail(runId, generation, "generation", new Error("agent not found"), extra);
        return;
      }
      extra = {
        run_id: runId,
        agent_id: String(agent.id),
        guild_id: String(agent.guild_id),
      };
      await this._generate_steps(runId, generation, run, agent, extra);
    } catch (error) {
      if (error instanceof GenerationCancelled) {
        cancelled = true;
      } else {
        await this._fail(runId, generation, "generation", error, extra);
      }
    } finally {
      try {
        if (cancelled) {
          await this._settle_cancel(runId, generation, extra);
        }
        await this.events.publish(runId, "generation.finished", { generation });
        const finished = await this.db.getRun(runId);
        if (finished !== null && !runWasResumed(finished)) {
          const kind = runKind(finished);
          // A group continuation completes itself; the group delivery completes the chain's first run.
          if (kind === "schedule" || (kind === "group" && chainOf(finished).index > 1)) {
            await this.db.completeRun(runId, new Date());
          }
        }
      } finally {
        const next = this._continuations.get(runId);
        this._continuations.delete(runId);
        if (next !== undefined && !cancelled) {
          await this._continue(runId, next);
        } else {
          this.endGeneration(runId);
        }
      }
    }
  }

  /**
   * Hands the agent's generation lock from a run to its continuation without releasing it,
   * tells the first run's subscribers where the work went, and generates the continuation.
   * The agent stays busy across the chain.
   */
  async _continue(fromRunId: string, toRunId: string): Promise<void> {
    this.generations.handOver(fromRunId, toRunId);
    await this.events.publish(fromRunId, "run.continued", { run_id: toRunId });
    const task = this._generate(toRunId, 1);
    this.generations.setTask(toRunId, task);
    await task;
  }

  /** The last run of the chain that `runId` belongs to, following each continuation. */
  async _latest_in_chain(runId: string): Promise<string> {
    let current = runId;
    for (let hop = 0; hop < MAX_CHAIN_RUNS; hop += 1) {
      const row = await this.db.getRun(current);
      const next = row ? continuedBy(row) : null;
      if (next === null) {
        return current;
      }
      current = next;
    }
    return current;
  }

  async _generate_steps(
    runId: string,
    generation: number,
    run: RunRow,
    agent: AgentRow,
    extra: Record<string, string>,
  ): Promise<void> {
    const machine = agentMachine(agent);
    const seat = agentSeat(agent);
    const snapshot = recordOf(run.config_snapshot);
    if (snapshot.coding === true && harnessOf(snapshot) === null) {
      const missing = harnessMissingError();
      await this._fail(runId, generation, missing.code, missing, extra);
      return;
    }
    if (snapshot.coding === true && !(await guildRepositories(this.db, agent)).length) {
      await this._fail(runId, generation, REPOSITORIES_MISSING, new Error(REPOSITORIES_MISSING_MESSAGE), extra);
      return;
    }
    try {
      const workspaceRoot = await this.machines.workspaceRootFor(machine.id);
      if (this.machines.sandboxes.machineHost) {
        const host = await this.machines.sandboxes.machineHost(machine.id);
        if (host) {
          extra.host_id = host.hostId;
          await this.db.mergeRunMetadata(runId, { host_id: host.hostId }, new Date());
        }
      }
      prepareWorkspace(workspaceRoot, machine.id, seat.agentId, { browser: Boolean(snapshot.browser) });
    } catch (error) {
      await this._fail(runId, generation, "workspace.create", error, extra);
      return;
    }
    let secretRefs: Array<Record<string, string>>;
    let env: Record<string, string>;
    let secrets: Record<string, string>;
    try {
      secretRefs = await this.syncRunSecrets(agent);
      snapshot.secrets = secretRefs;
      env = applySecretAliases(await snapshotEnvValues(this.db, secretRefs), secretAliasesOf(snapshot));
      secrets = { ...env, ...(await mcpRedactions(this.db, snapshot)), ...instanceRedactions() };
    } catch (error) {
      await this._fail(runId, generation, "secrets.resolve", error, extra);
      return;
    }
    let sandbox: SandboxHandle;
    let machineSandbox: SandboxHandle;
    try {
      const pinned = Array.isArray(snapshot.scripts)
        ? (snapshot.scripts as RunScriptSnapshot[])
        : await this.scripts.snapshot(String(agent.id));
      const liveRows = await this.scripts.listForAgent(String(agent.id));
      machineSandbox = await this.machines.sandboxForGeneration(agent);
      sandbox = agentSandbox(machineSandbox, agentHome(seat.agentId), { ...env, ...seatEnvironment(seat) });
      await applyRunScripts(sandbox, agentHome(seat.agentId), pinned, liveExtraForAgent(pinned, liveRows));
    } catch (error) {
      await this._fail(runId, generation, "sandbox.ensure", error, extra);
      return;
    }
    let tools = snapshot.tools || [];
    if (!Array.isArray(tools)) {
      tools = [];
    }
    const mcpTools = mcpIndex(snapshot.mcp);
    const runScripts = Array.isArray(snapshot.scripts)
      ? (snapshot.scripts as RunScriptSnapshot[])
      : [];
    const scope = {
      orgId: typeof agent.org_id === "string" && agent.org_id ? agent.org_id : null,
      guildId: String(agent.guild_id),
      agentId: String(agent.id),
    };
    const rows = await this.db.listBindingsCovering(scope);
    const liveConfig = recordOf(agent.config);
    const liveBrowser =
      typeof liveConfig.browser === "boolean" ? liveConfig.browser : Boolean(snapshot.browser);
    const liveCoding =
      typeof liveConfig.coding === "boolean" ? liveConfig.coding : Boolean(snapshot.coding);
    const liveScripting =
      typeof liveConfig.scripting === "boolean"
        ? liveConfig.scripting
        : snapshot.scripting !== false;
    const liveMemory =
      typeof liveConfig.memory === "boolean" ? liveConfig.memory : snapshot.memory !== false;
    const offered = liveOfferedNames(snapshotOfferedNames(tools), rows, {
      orgId: scope.orgId,
      guildId: scope.guildId,
      agentId: scope.agentId,
      browser: liveBrowser,
      coding: liveCoding,
      scripting: liveScripting,
      memory: liveMemory,
      schedules: runKind(run) !== "schedule",
      direct: runKind(run) === "direct",
    });
    tools = withFirstClassScriptTools(
      (tools as unknown[]).filter((tool) => offered.has(toolSchemaName(tool))),
      runScripts,
      offered.has("script_run"),
    );
    const ctx = createToolContext({
      run_id: runId,
      agent_id: String(agent.id),
      guild_id: String(agent.guild_id),
      sandbox,
      secrets,
      notes: this.notes,
      artifacts: this.artifacts,
      files: this.files,
      workspace_dir: await this.machines.agentWorkspace(agent),
      artifact_actor:
        typeof agent.org_id === "string" && agent.org_id
          ? agentActor({
              orgId: agent.org_id,
              guildId: String(agent.guild_id),
              agentId: String(agent.id),
              agentName: String(agent.name),
              runId,
            })
          : null,
      guild_name: String(agent.guild_name),
      agent_name: String(agent.name),
      org_slug: String(agent.org_slug),
      cancel_event: this.generations.cancelEvent(runId),
      track_command: (executionId) => this.generations.trackCommand(runId, sandbox, executionId),
      agent_home: agentHome(seat.agentId),
      cdp_port: snapshot.browser ? slotPorts(seat.slot).cdp : null,
      ensure_browser: snapshot.browser
        ? () => this.machines.ensureRunBrowser(agent, machineSandbox)
        : null,
      group_chat: this.groupChat,
      issues: this.issues,
      schedules: this.schedules,
      scripts: SCRIPT_TOOLS.some((name) => offered.has(name)) ? this.scripts : null,
      run_kind: runKind(run),
      secret_names: secretRefs.map((ref) => String(ref.name)),
      secret_store: this.agentSecretStore(agent),
      memory_replaced_by: await this._memory_replaced_by(run),
      run_scripts: runScripts,
      persist_run_scripts: async (scripts) => {
        await this.db.updateRunScripts(runId, scripts, new Date());
      },
      max_scripts: maxScriptsOf(liveConfig),
      dynamic_tools: offered.has("script_run") ? dynamicScriptTools(runScripts) : {},
      connection_tool_names: Object.keys(mcpTools),
      offered_tools: offered,
      harness: harnessOf(snapshot),
      harness_model: harnessModelOf(snapshot),
      harness_effort: harnessEffortOf(snapshot),
      secret_aliases: secretAliasesOf(snapshot),
      // `secrets` holds the run's values and, once minted, its GitHub tokens.
      publish_progress: async (toolCallId, update) => {
        await this.events.publish(runId, "tool.progress", {
          run_id: runId,
          tool_call_id: toolCallId,
          lines: shownProgressLines(update.lines, secrets),
          session_id: update.session_id,
        });
      },
      remember_harness_task: async (task) => {
        await this.db.mergeRunMetadata(runId, { harness_task: task }, new Date());
      },
      harness_login_seen: async (harness, account) => {
        await this.db.markHarnessLogin?.(String(agent.id), harness, new Date(), account);
      },
      harness_login_lost: async (harness) => {
        await this.db.clearHarnessLogin?.(String(agent.id), harness);
      },
    });
    const coding = Boolean(snapshot.coding);
    // Platform work runs on the machine's own sandbox: the agent's home and ports, none of its secrets.
    if (!(await this.workspace.hasRoom({ runId, generation, log: extra }, agent, machineSandbox))) {
      return;
    }
    if (coding && !(await this.coding.harnessReady({ runId, generation, log: extra }, ctx))) {
      return;
    }
    if (coding && !(await this.coding.prepareRepositories({ runId, generation, log: extra }, agent, machineSandbox, { ctx, secrets }))) {
      return;
    }
    try {
      await this._run_steps(runId, generation, run, snapshot, ctx, tools as unknown[], secrets, mcpTools, extra);
    } finally {
      if (coding) {
        await this.coding.recordCheckpoints(runId, agent, machineSandbox);
      }
      if (!this.generations.isCancelled(runId)) {
        await this.workspace.recordSize(runId, agent, machineSandbox);
      }
    }
  }

  async _run_steps(
    runId: string,
    generation: number,
    run: RunRow,
    snapshot: Record<string, unknown>,
    ctx: ReturnType<typeof createToolContext>,
    tools: unknown[],
    secrets: Record<string, string>,
    mcpTools: Record<string, [string, string]>,
    extra: Record<string, string>,
  ): Promise<void> {
    const maxSteps = Number(snapshot.max_steps);
    const maxToolCalls = positiveInt(snapshot.max_tool_calls, DEFAULT_MAX_TOOL_CALLS);
    const maxInputTokens = positiveInt(snapshot.max_input_tokens, DEFAULT_MAX_INPUT_TOKENS);

    const chainable = Boolean(snapshot.coding);
    const handoffAt = Math.floor(maxInputTokens * HANDOFF_FRACTION);
    const modelStep = async (): Promise<Array<Record<string, unknown>>> => {
      const agent = await this.db.getAgent(String(run.agent_id));
      const { rows, payloads } = await this.completion.modelHistory({ runId, generation, log: extra }, agent, snapshot, tools);
      const tokens = countRunInputTokens(
        String(snapshot.model),
        rows,
        Array.isArray(tools) ? tools : null,
        countInputTokensImpl,
      );
      if (tokens > maxInputTokens) {
        throw new RunLimitError("generation.max_input_tokens", INPUT_TOKEN_LIMIT_MESSAGE);
      }
      if (chainable && tokens >= handoffAt) {
        throw new HandoffDue();
      }
      const completion = await this.completion.complete(runId, {
        model: String(snapshot.model),
        messages: payloads,
        temperature: Number(snapshot.temperature),
        max_tokens: Number(snapshot.max_tokens),
        tools: (tools as unknown[]).length ? (tools as unknown[]) : null,
        ...(snapshot.thinking_level ? { thinking_level: String(snapshot.thinking_level) } : {}),
      });
      await this.events.commitMessage(runId, completion.payload, { generation, ...completion.metadata });
      const calls = toolCallsOf(completion.payload);
      if (calls.length) {
        await this.toolCalls.execute(
          { runId, generation, log: extra },
          { ctx, schemas: tools, secrets, connections: mcpTools, maxToolCalls },
          calls,
        );
      }
      return calls;
    };

    for (let step = 0; step < maxSteps; step += 1) {
      if (this.generations.isCancelled(runId)) {
        throw new GenerationCancelled();
      }
      if (executedToolCalls(await this.db.listMessages(runId)) >= maxToolCalls) {
        await this._fail(
          runId,
          generation,
          "generation.max_tool_calls",
          new RunLimitError("generation.max_tool_calls", TOOL_CALL_LIMIT_MESSAGE),
          extra,
        );
        await this._end_run(runId);
        return;
      }
      let calls: Array<Record<string, unknown>>;
      try {
        calls = await modelStep();
      } catch (error) {
        if (error instanceof GenerationCancelled) {
          throw error;
        }
        if (error instanceof HandoffDue) {
          await this._handoff(runId, generation, run, snapshot, tools, maxInputTokens, extra);
          return;
        }
        if (error instanceof RunLimitError) {
          await this._fail(runId, generation, error.operation, error, extra);
          await this._end_run(runId);
          return;
        }
        await this._fail(runId, generation, "llm.complete", error, extra);
        return;
      }
      if (!calls.length) {
        return;
      }
      if (executedToolCalls(await this.db.listMessages(runId)) >= maxToolCalls) {
        await this._fail(
          runId,
          generation,
          "generation.max_tool_calls",
          new RunLimitError("generation.max_tool_calls", TOOL_CALL_LIMIT_MESSAGE),
          extra,
        );
        await this._end_run(runId);
        return;
      }
      if (step === maxSteps - 1) {
        await this._fail(
          runId,
          generation,
          "generation.max_steps",
          new Error("max_steps reached"),
          extra,
        );
        return;
      }
    }
  }

  /**
   * A coding run's prompt reached the hand-off share of its input limit: the agent is asked
   * for a hand-off, given one step, and the run continues in a new one of the same kind.
   * The fifth run of a chain completes with `generation.max_chain` instead.
   */
  async _handoff(
    runId: string,
    generation: number,
    run: RunRow,
    snapshot: Record<string, unknown>,
    tools: unknown[],
    maxInputTokens: number,
    extra: Record<string, string>,
  ): Promise<void> {
    const position = chainOf(run);
    if (position.index >= MAX_CHAIN_RUNS) {
      await this._fail(runId, generation, "generation.max_chain", new RunLimitError("generation.max_chain", MAX_CHAIN_MESSAGE), extra);
      await this._end_run(runId);
      return;
    }
    await this.events.commitMessage(
      runId,
      { role: "user", content: HANDOFF_REQUEST },
      { generation, source: "handoff" },
    );
    const agent = await this.db.getAgent(String(run.agent_id));
    const { rows, payloads } = await this.completion.modelHistory({ runId, generation, log: extra }, agent, snapshot, tools);
    if (
      countRunInputTokens(
        String(snapshot.model),
        rows,
        tools.length ? tools : null,
        countInputTokensImpl,
      ) > maxInputTokens
    ) {
      await this._fail(
        runId,
        generation,
        "generation.max_input_tokens",
        new RunLimitError("generation.max_input_tokens", INPUT_TOKEN_LIMIT_MESSAGE),
        extra,
      );
      await this._end_run(runId);
      return;
    }
    let completion: Completion;
    try {
      completion = await this.completion.complete(runId, {
        model: String(snapshot.model),
        messages: payloads,
        temperature: Number(snapshot.temperature),
        max_tokens: Number(snapshot.max_tokens),
        tools: tools.length ? tools : null,
        ...(snapshot.thinking_level ? { thinking_level: String(snapshot.thinking_level) } : {}),
      });
    } catch (error) {
      if (error instanceof GenerationCancelled) {
        throw error;
      }
      await this._fail(runId, generation, "llm.complete", error, extra);
      return;
    }
    await this.events.commitMessage(runId, completion.payload, { generation, ...completion.metadata });
    // Tool schemas stay fixed for the run, so the model may still call one: each call gets a
    // refusal, which keeps the history valid, and is not run.
    const maxToolCalls = positiveInt(snapshot.max_tool_calls, DEFAULT_MAX_TOOL_CALLS);
    let executed = executedToolCalls(await this.db.listMessages(runId));
    for (const call of toolCallsOf(completion.payload)) {
      const fn = recordOf(call.function);
      executed += 1;
      const [payload, metadata] = stampToolResult(
        { role: "tool", tool_call_id: String(call.id ?? ""), content: HANDOFF_TOOL_REFUSED },
        {
          tool_name: String(fn.name ?? ""),
          tool_call_id: String(call.id ?? ""),
          duration_ms: 0,
          output_filter: "identity",
          truncated: false,
          original_bytes: Buffer.byteLength(HANDOFF_TOOL_REFUSED),
          stored_bytes: Buffer.byteLength(HANDOFF_TOOL_REFUSED),
          error: "a hand-off was requested",
        },
        remainingAfter(maxToolCalls, executed),
      );
      await this.events.commitMessage(runId, payload, { generation, ...metadata });
    }
    let next: string;
    try {
      next = await this.runs.createContinuation(run, handoffText(completion.payload), position);
    } catch (error) {
      await this._fail(runId, generation, "generation.continue", error, extra);
      return;
    }
    await this.db.mergeRunMetadata(runId, { continued_by_run_id: next }, new Date());
    await this.db.completeRun(runId, new Date());
    this._continuations.set(runId, next);
  }

  async _memory_replaced_by(run: Record<string, unknown>): Promise<string> {
    const kind = runKind(run);
    const runId = String(run.id);
    const position = chainOf(run);
    if (position.previous_run_id !== null) {
      return `run ${runId} (continuation of ${position.previous_run_id})`;
    }
    const rows = await this.db.listMessages(runId);
    if (kind === "schedule") {
      let instruction = "";
      const prefix = "Schedule wake-up: ";
      for (const row of rows) {
        const meta = recordOf(row.metadata);
        const payload = recordOf(row.payload);
        if (meta.source !== "schedule") {
          continue;
        }
        const raw = payload.content;
        if (typeof raw !== "string") {
          break;
        }
        if (raw.startsWith(prefix)) {
          try {
            const info = JSON.parse(raw.slice(prefix.length)) as Record<string, unknown>;
            instruction = String(info.instruction || "");
          } catch {
            instruction = raw.slice(prefix.length);
          }
        }
        break;
      }
      return `run ${runId} (schedule wake-up: "${instruction}")`;
    }
    if (kind === "group") {
      let tags: string[] = [];
      for (const row of rows) {
        const meta = recordOf(row.metadata);
        if (meta.source !== "group_chat") {
          continue;
        }
        const tagged = meta.tagged || [];
        if (Array.isArray(tagged)) {
          tags = tagged.filter((item) => item).map((item) => String(item));
        }
        break;
      }
      if (tags.length) {
        const label = tags.map((name) => `@${name}`).join(", ");
        return `run ${runId} (group delivery: ${label})`;
      }
      return `run ${runId} (group delivery)`;
    }
    return `run ${runId} (direct)`;
  }

  async _end_run(runId: string): Promise<void> {
    const run = await this.db.getRun(runId);
    if (run === null || run.status !== "active") {
      return;
    }
    await this.db.completeRun(runId, new Date());
  }

  async _fail(
    runId: string,
    generation: number,
    operation: string,
    error: unknown,
    extra?: Record<string, string>,
  ): Promise<void> {
    await this.events.recordError({ runId, generation, log: extra ?? { run_id: runId } }, operation, error);
  }

  /**
   * `secret_store` for one agent: reads the value file from its workspace, saves the
   * secret granted to it, removes the file, and refreshes environments the change reaches.
   */
  private agentSecretStore(agent: AgentRow): AgentSecretStore {
    const agentId = String(agent.id);
    return {
      store: async (input) => {
        const file = await readSecretFile(await this.machines.agentWorkspace(agent), input.file);
        const stored = await storeAgentSecret(
          this.db,
          { id: agentId, orgId: String(agent.org_id) },
          { name: input.name, description: input.description, value: file.value },
        );
        await removeSecretFile(file.path);
        if (stored.rotated) {
          await this.secretChanged(stored.secretId);
        } else {
          await this.secretAccessChanged([agentId]);
        }
        return { name: stored.name, rotated: stored.rotated, value: stored.value };
      },
    };
  }

}
