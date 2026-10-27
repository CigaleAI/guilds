
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_WORKSPACE_MIB,
  maxScriptsOf,
  maxWorkspaceMibOf,
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

import { mcpDatabase, McpDisconnectedError, McpError, McpPool } from "../mcp/index.js";
import {
  ArtifactFiles,
  ArtifactStore,
  agentActor,
} from "../artifacts/index.js";
import { type NotesStore } from "../notes/store.js";
import { tokenRedactions } from "../oauth/index.js";
import { errorMessage, errorName, writeLog } from "../observability/log.js";

import {
  agentRunDir,
  agentSandbox,
  applyRunScripts,
  prepareWorkspace,
  seatEnvironment,
  type SandboxHandle,
} from "../sandbox/index.js";
import {
  DEFAULT_MACHINE_MAX_WORKSPACE_MIB,
  slotPorts,
} from "../machines/index.js";
import { agentHome } from "../lib/agent-file.js";
import { Scripts } from "../scripts/catalog.js";
import type { RunScriptSnapshot } from "../scripts/snapshot.js";

import { Schedules } from "../schedules/service.js";

import { redact } from "../secrets/index.js";
import { readSecretFile, removeSecretFile, storeAgentSecret } from "../secrets/agent.js";

import { instanceRedactions } from "../connectors/instance.js";
import {
  defaultGroupRouter,
  type GroupRouter,
} from "../typesafe/index.js";
import { ActiveGenerations, AdmissionCoordinator } from "./admission.js";
import { guildRepositories } from "./coding.js";
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
  identityOutput,
  invokeTool,
  parseArguments,
  processOutput,
  remainingAfter,
  stampToolResult,
  toolResultMaxBytes,
  withRemainingToolCalls as _withRemainingToolCalls,
} from "../toolbox/index.js";
import { agentGitIdentity, cloneFailures, RepositoryTokens } from "../coding/git.js";
import { RepositoryAccessError } from "../github/tokens.js";

import {
  harnessModelOf,
  harnessOf,
  REPOSITORIES_MISSING,
  REPOSITORIES_MISSING_MESSAGE,
  type Harness,
} from "../coding/harnesses.js";
import { harnessEffortOf } from "../coding/harness-models.js";

import {
  measureMachine,
  measureWorkspace,
  repeatedReadStep,
  repeatedReadText,
  callSegment,
  runCodeHelper,
} from "../toolbox/code.js";
import {
  assertHarnessReady,
  checkHarnessOn,
  endLostTurn,
  type HarnessCheck,
  harnessMissingError,
  HarnessSetupError,
  interruptedText,
  type HarnessLog,
  type LostTurnEnd,
  readHarnessLog,
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
import {
  executedToolCalls,
  interruptionRecord,
  lostCodeTask,
  pendingToolCalls,
  toolCallsOf,
  type LostCodeTask,
} from "./tool-calls.js";

export { RunRequestError } from "./errors.js";

export const SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const SCHEDULER_TICK_MS = 30_000;
export const TOOL_CALL_LIMIT_MESSAGE = "Tool call limit reached. Start a new run to continue.";
export const INPUT_TOKEN_LIMIT_MESSAGE = "Input token limit reached. Start a new run to continue.";
export const REMAINING_TOOL_CALLS_PREFIX = "remaining_tool_calls: ";
export const DEFAULT_WORKSPACE_MAX_MIB = DEFAULT_MAX_WORKSPACE_MIB;
export const RUN_DIFF_MAX_BYTES = 256 * 1024;

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

  /**
   * The diff a run made in one repository, between its start and end checkpoints, or with
   * `task` between one `code_task` call's, from the agent's machine (woken as the CLI tab
   * wakes it), at most 256 KiB and redacted.
   */
  async runDiff(
    runId: string,
    repository: string,
    task: string | null = null,
  ): Promise<{ diff: string; truncated: boolean }> {
    const run = await this.db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    const agentId = String(run.agent_id);
    const agent = await this.generations.runnableAgent(agentId);
    const sandbox = await this.machines.wakeSandbox(agentId);
    let result;
    try {
      const args = task === null ? { repository } : { repository, task: callSegment(task) };
      result = await runCodeHelper(this._maintenance_ctx(runId, agent, sandbox), "diff", args, {
        maxBytes: RUN_DIFF_MAX_BYTES,
      });
    } catch (error) {
      throw new RunRequestError(404, errorMessage(error));
    }
    let secrets: Record<string, string>;
    try {
      secrets = await snapshotEnvValues(this.db, await agentSecrets(this.db, agent));
    } catch {
      secrets = {};
    }
    return { diff: redact(result.text, secrets), truncated: result.meta.truncated === true };
  }

  /**
   * The kept event log of one `code_task` call of a run, run on `harness`, from the agent's
   * machine (woken as the CLI tab wakes it), redacted with the agent's secrets. Throws 404 once
   * the agent's home no longer keeps it.
   */
  async harnessLog(runId: string, callId: string, harness: Harness): Promise<HarnessLog> {
    const run = await this.db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    const agentId = String(run.agent_id);
    const agent = await this.generations.runnableAgent(agentId);
    const sandbox = await this.machines.wakeSandbox(agentId);
    let secrets: Record<string, string>;
    try {
      secrets = await snapshotEnvValues(this.db, await agentSecrets(this.db, agent));
    } catch {
      secrets = {};
    }
    let log: HarnessLog | null;
    try {
      log = await readHarnessLog(this._maintenance_ctx(runId, agent, sandbox), harness, callSegment(callId), secrets);
    } catch (error) {
      throw new RunRequestError(503, errorMessage(error));
    }
    if (log === null) {
      throw new RunRequestError(404, "that log is no longer kept: an agent's home keeps its 20 most recent runs");
    }
    return log;
  }

  /** The guild repositories a coding run of the agent clones, by their folder under `repos/`. */
  async codingRepositoryNames(agent: AgentRow): Promise<string[]> {
    return (await guildRepositories(this.db, agent)).map((row) => String(row.name));
  }

  /**
   * Checks the agent's machine, waking it, for what `harness` would run on outside a run: a
   * login in the agent's home or nothing, since a granted secret reaches only a run. Records
   * the login as seen, or forgets it when none is left.
   */
  async checkHarness(agentId: string, harness: Harness): Promise<HarnessCheck> {
    const agent = await this.generations.runnableAgent(agentId);
    const sandbox = await this.machines.wakeSandbox(agentId);
    let check: HarnessCheck;
    try {
      check = await checkHarnessOn(this._maintenance_ctx("", agent, sandbox), harness);
    } catch (error) {
      throw new RunRequestError(503, errorMessage(error));
    }
    if (check.credential === "login") {
      await this.db.markHarnessLogin?.(agentId, harness, new Date(), check.account);
    } else if (check.installed) {
      await this.db.clearHarnessLogin?.(agentId, harness);
    }
    return check;
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
      await this._resolve_unresolved(run.id);
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

  async _invoke_mcp(
    target: [string, string],
    call: Record<string, unknown>,
    secrets: Record<string, string>,
    maxBytes: number,
    workspaceDir?: string,
    orgId?: string,
  ): Promise<[Record<string, unknown>, Record<string, unknown>]> {
    const [connectionId, remoteName] = target;
    const fn =
      call.function && typeof call.function === "object" && !Array.isArray(call.function)
        ? (call.function as Record<string, unknown>)
        : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    const callId = typeof call.id === "string" ? call.id : "";
    const started = performance.now();
    let error: string | null = null;
    let raw: string;
    try {
      const arguments_ = parseArguments(call);
      const connection = await this.db.getMcpConnection(connectionId);
      if (connection === null) {
        throw new McpDisconnectedError("connection not found");
      }
      const server = await this.db.getMcpServer(connection.mcp_server_id);
      if (server === null) {
        throw new McpError("mcp server not found");
      }
      const result = await this.mcp.call(
        this.db as never,
        connection,
        server,
        remoteName,
        arguments_,
        { ...(workspaceDir ? { workspaceDir } : {}), ...(orgId ? { orgId } : {}) },
      );
      if (typeof result !== "string") {
        throw new TypeError("mcp tool must return str");
      }
      raw = result;
    } catch (caught) {
      writeLog("warn", errorMessage(caught), {
        operation: `tool.${name}`,
        run_id: callId,
        error_type: errorName(caught),
      });
      raw = `ERROR: ${errorMessage(caught)}`;
      error = errorMessage(caught);
    }
    const [content, pipeline] = processOutput(raw, identityOutput, secrets, maxBytes);
    if (typeof pipeline.error === "string" && pipeline.error) {
      error = pipeline.error;
    }
    return [
      { role: "tool", tool_call_id: callId, content },
      {
        tool_name: name,
        tool_call_id: callId,
        duration_ms: Math.trunc(performance.now() - started),
        output_filter: "identity",
        truncated: pipeline.truncated,
        original_bytes: pipeline.original_bytes,
        stored_bytes: pipeline.stored_bytes,
        error,
      },
    ];
  }

  async _resolve_unresolved(runId: string, generation?: number | null): Promise<number> {
    const rows = await this.db.listMessages(runId);
    const pending = pendingToolCalls(rows);
    const run = await this.db.getRun(runId);
    const snapshot = recordOf(run?.config_snapshot);
    const maxToolCalls = positiveInt(snapshot.max_tool_calls, DEFAULT_MAX_TOOL_CALLS);
    let executed = executedToolCalls(rows);
    for (const [call, callGeneration] of pending) {
      let [payload, metadata] = interruptionRecord(call, generation ?? callGeneration);
      if (metadata.tool_name === "code_task" && run) {
        [payload, metadata] = await this._interrupted_code_task(run, call, [payload, metadata]);
      }
      executed += 1;
      const remaining = remainingAfter(maxToolCalls, executed);
      [payload, metadata] = stampToolResult(payload, metadata, remaining);
      await this.events.commitMessage(runId, payload, metadata);
    }
    return pending.length;
  }

  /**
   * A `code_task` the orchestrator never saw finish: the harness gets `stop` on its machine, so
   * it never keeps running with nobody polling it; its state is cleared, the task's end
   * checkpoint is taken, and the result names its session and log.
   */
  async _interrupted_code_task(
    run: Record<string, unknown>,
    call: Record<string, unknown>,
    record: [Record<string, unknown>, Record<string, unknown>],
  ): Promise<[Record<string, unknown>, Record<string, unknown>]> {
    const harness = harnessOf(recordOf(run.config_snapshot));
    if (harness === null) {
      return record;
    }
    const task = lostCodeTask(run, call, harness);
    const ended = await this._end_lost_turn(String(run.agent_id), task);
    const session_id = ended.session_id ?? task.session_id;
    const content = interruptedText({ ...task, session_id, stopped: ended.stopped });
    const bytes = Buffer.byteLength(content, "utf8");
    return [
      { ...record[0], content },
      {
        ...record[1],
        harness,
        status: "interrupted",
        session_id,
        repository: task.repository ?? "unknown",
        log_path: task.log_path,
        start_sha: ended.start_sha,
        end_sha: ended.end_sha,
        original_bytes: bytes,
        stored_bytes: bytes,
      },
    ];
  }

  /** Ends a lost `code_task` on its agent's machine; a machine that is not running has no harness left to stop. */
  async _end_lost_turn(agentId: string, task: LostCodeTask): Promise<LostTurnEnd> {
    try {
      const running = await this._running_agent_sandbox(agentId);
      if (running === null) {
        return { stopped: true, session_id: null, start_sha: null, end_sha: null };
      }
      const ctx = this._maintenance_ctx(task.run_id, running.agent, running.sandbox);
      ctx.tool_call_id = task.call_id;
      return await endLostTurn(ctx, task.harness, task.repository);
    } catch (error) {
      writeLog("warn", errorMessage(error), {
        run_id: task.run_id,
        agent_id: agentId,
        operation: "code_task.stop",
        error_type: errorName(error),
      });
      return { stopped: false, session_id: null, start_sha: null, end_sha: null };
    }
  }

  /** The agent and its machine's sandbox when that machine is running, else null. */
  async _running_agent_sandbox(
    agentId: string,
  ): Promise<{ agent: AgentRow; sandbox: SandboxHandle } | null> {
    const agent = await this.db.getAgent(agentId);
    if (!agent?.machine_id) {
      return null;
    }
    const sandbox = await this.machines.sandboxes.connectRunning(String(agent.machine_id));
    return sandbox === null ? null : { agent, sandbox };
  }

  _on_cancel = async (
    runId: string,
    generation: number,
    extra: Record<string, string>,
  ): Promise<void> => {
    await this._resolve_unresolved(runId, generation);
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
    if (!(await this._workspace_has_room(runId, generation, agent, machineSandbox, extra))) {
      return;
    }
    if (coding && !(await this._harness_ready(runId, generation, ctx, extra))) {
      return;
    }
    if (coding && !(await this._prepare_repositories(runId, generation, agent, machineSandbox, ctx, secrets, extra))) {
      return;
    }
    try {
      await this._run_steps(runId, generation, run, snapshot, ctx, tools as unknown[], secrets, mcpTools, extra);
    } finally {
      if (coding) {
        await this._record_checkpoints(runId, agent, machineSandbox);
      }
      if (!this.generations.isCancelled(runId)) {
        await this._record_workspace_size(runId, agent, machineSandbox);
      }
    }
  }

  /** Whether the run's harness is installed and has a credential; a run that cannot delegate code work fails here. */
  async _harness_ready(
    runId: string,
    generation: number,
    ctx: ReturnType<typeof createToolContext>,
    extra: Record<string, string>,
  ): Promise<boolean> {
    try {
      await assertHarnessReady(ctx);
      return true;
    } catch (error) {
      await this._fail(runId, generation, error instanceof HarnessSetupError ? error.code : "harness.check", error, extra);
      return false;
    }
  }

  /**
   * A coding generation's repositories: installation tokens for those with a GitHub
   * connection (written under /run/guilds and added to redaction), the agent's git
   * identity, a clone of each one missing from the workspace, and the run's start
   * checkpoint. The working directory starts in the repository when there is one.
   */
  async _prepare_repositories(
    runId: string,
    generation: number,
    agent: AgentRow,
    sandbox: SandboxHandle,
    ctx: ReturnType<typeof createToolContext>,
    secrets: Record<string, string>,
    extra: Record<string, string>,
  ): Promise<boolean> {
    const repositories = await guildRepositories(this.db, agent);
    const tokens = new RepositoryTokens(this.db as never, repositories);
    const redact = () => {
      tokens.values.forEach((value, index) => {
        secrets[`GITHUB_TOKEN_${index + 1}`] = value;
      });
    };
    const maintenance = this._maintenance_ctx(runId, agent, sandbox);
    try {
      await tokens.mint();
      redact();
      if (sandbox.files) {
        await sandbox.commands.run(`mkdir -p -m 700 ${agentRunDir(String(agent.id))}`, { timeoutSeconds: 10 });
        await tokens.write(sandbox.files, String(agent.id));
      }
    } catch (error) {
      await this._fail(runId, generation, "repository.token", error, extra);
      return false;
    }
    let failed: Array<{ name: string; error: string }>;
    try {
      const guild = await this.db.getGuild(String(agent.guild_id));
      const setup = await runCodeHelper(
        maintenance,
        "git_setup",
        {
          identity: agentGitIdentity(agent, {
            email: typeof guild?.git_author_email === "string" ? guild.git_author_email : "",
          }),
          repositories: repositories.map((row) => ({ name: row.name, url: row.url })),
        },
        { timeoutSeconds: 60 + 600 * Math.max(1, repositories.length) },
      );
      failed = Array.isArray(setup.meta.failed) ? (setup.meta.failed as Array<{ name: string; error: string }>) : [];
    } catch (error) {
      await this._fail(runId, generation, "repository.clone", error, extra);
      return false;
    }
    if (failed.length) {
      const detail = cloneFailures(failed, repositories, tokens.entries);
      await this._fail(runId, generation, "repository.clone", new RepositoryAccessError(`clone failed: ${detail}`), extra);
      return false;
    }
    try {
      await runCodeHelper(maintenance, "checkpoint", { which: "start" }, { timeoutSeconds: 300 });
    } catch (error) {
      writeLog("warn", errorMessage(error), {
        run_id: runId,
        agent_id: String(agent.id),
        operation: "repository.checkpoint",
        error_type: errorName(error),
      });
    }
    ctx.code_repositories = repositories.map((row) => String(row.name));
    if (repositories.length === 1) {
      ctx.code_default_cwd = `repos/${String(repositories[0]!.name)}`;
    }
    if (tokens.connected.length) {
      ctx.before_command = async () => {
        if (!tokens.needsRefresh()) {
          return;
        }
        await tokens.mint();
        redact();
        if (sandbox.files) {
          await tokens.write(sandbox.files, String(agent.id));
        }
      };
    }
    return true;
  }

  /** The end checkpoint of every working tree, and what the run changed since its start. */
  async _record_checkpoints(runId: string, agent: AgentRow, sandbox: SandboxHandle): Promise<void> {
    try {
      const result = await runCodeHelper(
        this._maintenance_ctx(runId, agent, sandbox),
        "checkpoint",
        { which: "end" },
        { timeoutSeconds: 300 },
      );
      const repos = Array.isArray(result.meta.repositories) ? result.meta.repositories : [];
      if (repos.length) {
        await this.db.mergeRunMetadata(runId, { repos }, new Date());
      }
    } catch (error) {
      writeLog("warn", errorMessage(error), {
        run_id: runId,
        agent_id: String(agent.id),
        operation: "repository.checkpoint",
        error_type: errorName(error),
      });
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
    const maxBytes = toolResultMaxBytes();

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
        await this._execute_tool_calls(
          runId,
          generation,
          calls,
          ctx,
          secrets,
          maxBytes,
          mcpTools,
          maxToolCalls,
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

  async _execute_tool_calls(
    runId: string,
    generation: number,
    calls: Array<Record<string, unknown>>,
    ctx: ReturnType<typeof createToolContext>,
    secrets: Record<string, string>,
    maxBytes: number,
    mcpTools: Record<string, [string, string]>,
    maxToolCalls: number,
  ): Promise<void> {
    const history = await this.db.listMessages(runId);
    let executed = executedToolCalls(history);
    const owner = await this.db.getAgent(ctx.agent_id);
    const orgId = typeof owner?.org_id === "string" && owner.org_id ? owner.org_id : undefined;
    const reads = history
      .filter((row) => recordOf(row.payload).role === "tool")
      .map((row) => ({ seq: row.seq, metadata: recordOf(row.metadata) }));
    for (const call of calls) {
      if (this.generations.isCancelled(runId)) {
        throw new GenerationCancelled();
      }
      if (!call || typeof call !== "object") {
        continue;
      }
      const fn =
        call.function && typeof call.function === "object" && !Array.isArray(call.function)
          ? (call.function as Record<string, unknown>)
          : {};
      const toolName = typeof fn.name === "string" ? fn.name : "";
      let payload: Record<string, unknown>;
      let metadata: Record<string, unknown>;
      const allowed =
        ctx.offered_tools === null ||
        ctx.offered_tools.has(toolName) ||
        toolName in ctx.dynamic_tools;
      if (allowed && toolName in mcpTools) {
        [payload, metadata] = await this._invoke_mcp(
          mcpTools[toolName] as [string, string],
          call,
          secrets,
          maxBytes,
          await this.machines.agentWorkspace(owner),
          orgId,
        );
      } else {
        [payload, metadata] = await invokeTool(ctx, call, secrets, maxBytes);
        const step = repeatedReadStep(reads, metadata);
        if (step !== null) {
          const [content, pipeline] = processOutput(repeatedReadText(metadata, step), identityOutput, secrets, maxBytes);
          payload = { ...payload, content };
          metadata = { ...metadata, ...pipeline, repeat_of: step };
        }
      }
      executed += 1;
      const remaining = remainingAfter(maxToolCalls, executed);
      [payload, metadata] = stampToolResult(payload, metadata, remaining);
      const row = await this.events.commitMessage(runId, payload, { generation, ...metadata });
      reads.push({ seq: Number(row.seq), metadata });
    }
  }

  /**
   * A generation starts only while the agent's home is under its `max_workspace_mib` (and the
   * host `WORKSPACE_MAX_MIB`) and its machine's directory under the machine's `max_workspace_mib`.
   * The sizes stored after the last generation decide; one that is over is measured again, so
   * space the operator freed from the CLI tab counts.
   */
  async _workspace_has_room(
    runId: string,
    generation: number,
    agent: AgentRow,
    sandbox: SandboxHandle,
    extra: Record<string, string>,
  ): Promise<boolean> {
    const ctx = this._maintenance_ctx(runId, agent, sandbox);
    const checks = [
      {
        limit: agentWorkspaceMaxMib(recordOf(agent.config)),
        stored: agent.workspace_mib,
        measure: () => measureWorkspace(ctx),
        store: (mib: number) => this.db.setAgentWorkspaceMib?.(String(agent.id), mib),
        what: "the agent's home",
      },
      {
        limit: Number(agent.machine_max_workspace_mib ?? DEFAULT_MACHINE_MAX_WORKSPACE_MIB),
        stored: agent.machine_workspace_mib,
        measure: () => measureMachine(ctx),
        store: (mib: number) => this.db.setMachineWorkspaceMib?.(String(agent.machine_id), mib),
        what: `machine ${String(agent.machine_name ?? agent.machine_id)}`,
      },
    ];
    for (const check of checks) {
      if (check.stored === null || check.stored === undefined || Number(check.stored) <= check.limit) {
        continue;
      }
      let mib: number;
      try {
        mib = await check.measure();
        await check.store(mib);
      } catch (error) {
        await this._fail(runId, generation, "workspace.measure", error, extra);
        return false;
      }
      if (mib > check.limit) {
        await this._fail(
          runId,
          generation,
          "workspace.full",
          new Error(`${check.what} holds ${mib} MiB, above the ${check.limit} MiB limit; free space from the CLI tab`),
          extra,
        );
        return false;
      }
    }
    return true;
  }

  /** Measures the agent's home and its machine's directory and stores both sizes. */
  async _record_workspace_size(runId: string, agent: AgentRow, sandbox: SandboxHandle): Promise<void> {
    const ctx = this._maintenance_ctx(runId, agent, sandbox);
    try {
      const home = await measureWorkspace(ctx);
      await this.db.setAgentWorkspaceMib?.(String(agent.id), home);
      const machine = await measureMachine(ctx);
      await this.db.setMachineWorkspaceMib?.(String(agent.machine_id), machine);
    } catch (error) {
      writeLog(
        "warn",
        errorMessage(error),
        { run_id: runId, agent_id: String(agent.id), operation: "workspace.measure", error_type: errorName(error) },
      );
    }
  }

  /** A tool context for platform work in the sandbox: not cancellable, not tracked, no secrets. */
  _maintenance_ctx(
    runId: string,
    agent: AgentRow,
    sandbox: SandboxHandle,
  ): ReturnType<typeof createToolContext> {
    const seat = agentSeat(agent);
    return createToolContext({
      run_id: runId,
      agent_id: String(agent.id),
      guild_id: String(agent.guild_id),
      sandbox: agentSandbox(sandbox, agentHome(seat.agentId), seatEnvironment(seat)),
      secrets: {},
    });
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
