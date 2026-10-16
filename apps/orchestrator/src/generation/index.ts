import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  AgentValidationError,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_WORKSPACE_MIB,
  browserLanguageOf,
  keepToolResultGenerationsOf,
  maxScriptsOf,
  maxWorkspaceMibOf,
  memoryOf,
  secretAliasesOf,
  validateConfig,
  type AgentConfig,
} from "../agents/validation.js";
import { enabledToolNames, resolvedTools } from "../access/index.js";
import { NOTE_TOOLS } from "../db/seed/catalog.js";
import {
  agentRuntime,
  agentSecrets,
  applySecretAliases,
  snapshotEnvValues,
  type AccessDatabase,
} from "../access/runtime.js";
import { decryptPayload } from "../credentials/crypto.js";
import { jsonObj } from "../db/json.js";
import { iso, messageItem, runItem } from "../db/views.js";
import {
  DeliveryBusyError,
  DeliveryCreateError,
  GroupChat,
  groupChatUserMessage,
  type GroupChatDatabase,
  type GroupRunner,
} from "../groupchat/index.js";
import { guildOperators } from "../guilds/validation.js";
import { OPEN_POLICY, PolicyError, type OrgPolicy } from "../policy/index.js";
import { attachmentImageCount, countRunInputTokens } from "../attachments/hydrate.js";
import { IMAGE_INPUT_TOKENS, type AttachmentRef, type AttachmentService } from "../attachments/index.js";
import {
  AGENT_TOOL_RESULT_STUB_HINT,
  MIN_UNSTUBBED_TOOL_RESULTS,
  RUN_PROJECTION_POLICY_VERSION,
  TOOL_RESULT_STUB_MIN_BYTES,
  projectToolResults,
} from "../conversation/projection.js";
import { modelCatalog } from "../llm/catalog.js";
import {
  ModelNotConnectedError,
  NO_CREDENTIALS,
  coreModelCredentials,
  modelUsageOf,
  reportModelUsage,
  resolveModelCredentials,
  type ModelCredentials,
  type ModelCredentialsProvider,
} from "../llm/credentials.js";
import { newId } from "../lib/ids.js";
import { AsyncEvent, EventQueue, sleep } from "../lib/event.js";
import { IdleTimers } from "./idle.js";
import {
  LLMError,
  countInputTokens,
  streamCompletion,
  type Completion,
  type ModelEvent,
} from "../llm/index.js";
import { readMemory } from "../memory/index.js";
import { McpDisconnectedError, McpError, McpPool } from "../mcp/index.js";
import {
  ArtifactError,
  ArtifactStore,
  agentActor,
  catalogLevels,
  collectTaskEmbeds,
  displayPathFor,
  grantsFromBindings,
  inlineTaskEmbeds,
  operatorActor,
  snapshotTaskEmbeds,
  type ArtifactActor,
  type ArtifactGrants,
} from "../artifacts/index.js";
import { DEFAULT_ARTIFACT_GRANTS } from "../artifacts/types.js";
import { NotesError, type NotesStore } from "../notes/store.js";
import { tokenRedactions } from "../oauth/index.js";
import { writeLog, redactText } from "../observability/log.js";
import {
  PromptError,
  composeSystemPrompt,
  connectorGuidance,
  hydratePrompts,
  hydrateStanding,
  promptHash,
  standingForCapabilities,
} from "../prompts/index.js";
import {
  agentRunDir,
  agentSandbox,
  applyRunScripts,
  machineSpec,
  prepareWorkspace,
  SandboxError,
  seatEnvironment,
  type AgentSeat,
  type MachineSpec,
  type SandboxHandle,
} from "../sandbox/index.js";
import {
  agentDirectory,
  DEFAULT_MACHINE_MAX_WORKSPACE_MIB,
  machineDirectory,
  machineFromRow,
  slotPorts,
  type AgentNeeds,
} from "../machines/index.js";
import { agentHome } from "../lib/agent-file.js";
import { Scripts } from "../scripts/catalog.js";
import type { RunScriptSnapshot } from "../scripts/snapshot.js";
import { planAfterFire, rowTiming, type ScheduleTiming } from "../schedules/timing.js";
import type { PlannedWake } from "../schedules/window.js";
import { instructionHash, scheduleWakeUserMessage } from "../schedules/item.js";
import { Schedules, type ScheduleDatabase } from "../schedules/service.js";
import { redact } from "../secrets/index.js";
import { readSecretFile, removeSecretFile, storeAgentSecret, type AgentSecretsDatabase } from "../secrets/agent.js";
import { collectRunState } from "../state/index.js";
import { instanceRedactions } from "../connectors/instance.js";
import {
  defaultGroupRouter,
  serializeHistoryDecision,
  type GroupRouter,
} from "../typesafe/index.js";
import { AdmissionConflictError, AdmissionCoordinator } from "./admission.js";
import {
  chainOf,
  continuationMessage,
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
  REGISTRY,
  schemasFor,
  stampToolResult,
  toolResultMaxBytes,
  withRemainingToolCalls as _withRemainingToolCalls,
  CancelEvent,
} from "../toolbox/index.js";
import { BROWSER_TOOLS } from "../toolbox/browser.js";
import { agentGitIdentity, cloneFailures, RepositoryAccessError, RepositoryTokens } from "../coding/git.js";
import { codingRepositories, stateRepositories } from "../coding/repositories.js";
import {
  harnessModelOf,
  harnessOf,
  REPOSITORIES_MISSING,
  REPOSITORIES_MISSING_MESSAGE,
  type Harness,
} from "../coding/harnesses.js";
import { harnessEffortOf } from "../coding/harness-models.js";
import { GITHUB_SERVER_ID } from "../github/index.js";
import {
  CODING_TOOLS,
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
  HARNESS_TOOLS,
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
import { Issues, type IssuesDatabase } from "../issues/index.js";
import { SCHEDULE_TOOLS } from "../toolbox/schedule.js";
import { dynamicScriptTools, firstClassScriptSchemas, liveExtraForAgent, SCRIPT_TOOLS } from "../toolbox/script.js";
import type { DirectoryNotes } from "../directories/index.js";
import type { PromptNotes } from "../prompts/index.js";

export {
  LOW_TOOL_CALL_BUDGET,
  LOW_TOOL_CALL_WRAP_UP,
  remainingAfter,
  stampToolResult,
  withRemainingToolCalls,
  remainingAfter as remaining_after,
  stampToolResult as stamp_tool_result,
  withRemainingToolCalls as with_remaining_tool_calls,
} from "../toolbox/index.js";

export const INTERRUPTED_CONTENT = "ERROR: execution interrupted";
export const SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const SCHEDULER_TICK_MS = 30_000;
export const CANCEL_GRACE_MS = 2_000;
export const SHUTDOWN_TIMEOUT_MS = 15_000;
export const TOOL_CALL_LIMIT_MESSAGE = "Tool call limit reached. Start a new run to continue.";
export const INPUT_TOKEN_LIMIT_MESSAGE = "Input token limit reached. Start a new run to continue.";
export const REMAINING_TOOL_CALLS_PREFIX = "remaining_tool_calls: ";
const EVENT_QUEUE_LIMIT = 4096;
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

export const generationLive = {
  streamCompletion,
  countInputTokens,
  cancelGraceMs: CANCEL_GRACE_MS,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
};

export const streamCompletionImpl = (...args: Parameters<typeof streamCompletion>) =>
  generationLive.streamCompletion(...args);
export const countInputTokensImpl = (...args: Parameters<typeof countInputTokens>) =>
  generationLive.countInputTokens(...args);
export const cancelGraceMs = CANCEL_GRACE_MS;
export const shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS;

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class RunRequestError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "RunRequestError";
    this.status = status;
    this.detail = detail;
  }
}

export class GenerationCancelled extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "GenerationCancelled";
  }
}

/** A coding run's prompt reached the hand-off share of its input limit. */
class HandoffDue extends Error {
  constructor() {
    super("hand-off due");
    this.name = "HandoffDue";
  }
}

export class RunLimitError extends Error {
  operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "RunLimitError";
    this.operation = operation;
  }
}

function asObj(value: unknown): Record<string, unknown> {
  const loaded = jsonObj(value);
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    return {};
  }
  return loaded as Record<string, unknown>;
}

/** A `code_task` call the orchestrator lost track of when it restarted. */
type LostCodeTask = {
  harness: Harness;
  repository: string | null;
  session_id: string | null;
  log_path: string | null;
  run_id: string;
  call_id: string;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function callArguments(call: Record<string, unknown>): Record<string, unknown> {
  try {
    return parseArguments(call);
  } catch {
    return {};
  }
}

/** A lost `code_task` call, from what its run remembered about it and from the call's own arguments. */
function lostCodeTask(run: Record<string, unknown>, call: Record<string, unknown>, harness: Harness): LostCodeTask {
  const callId = callSegment(String(call.id ?? ""));
  const remembered = asObj(asObj(run.metadata).harness_task);
  const known = remembered.call_id === callId ? remembered : {};
  const args = callArguments(call);
  return {
    harness,
    repository: optionalText(known.repository) ?? optionalText(args.repo),
    session_id: optionalText(known.session_id) ?? optionalText(args.session_id),
    log_path: optionalText(known.log_path),
    run_id: String(run.id),
    call_id: callId,
  };
}

function runKind(run: Record<string, unknown> | null | undefined): string {
  if (!run) {
    return "direct";
  }
  const kind = run.kind;
  return typeof kind === "string" && kind ? kind : "direct";
}

function runWasResumed(run: Record<string, unknown>): boolean {
  const resumedAt = asObj(run.metadata).resumed_at;
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

function positiveInt(value: unknown, fallback: number): number {
  if (
    typeof value === "boolean" ||
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    return fallback;
  }
  return value;
}

function isDir(value: string): boolean {
  return Boolean(value) && existsSync(value) && statSync(value).isDirectory();
}

function errorName(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    typeof error.name === "string" &&
    error.name
  ) {
    return error.name;
  }
  return "Error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isBrowserOrCodingToolName(name: string): boolean {
  return (
    (BROWSER_TOOLS as readonly string[]).includes(name) ||
    (CODING_TOOLS as readonly string[]).includes(name) ||
    (HARNESS_TOOLS as readonly string[]).includes(name)
  );
}

function nameMatchesToolList(name: string, tools: readonly string[] | string): boolean {
  return typeof tools === "string" ? name === tools : tools.includes(name);
}

function isHiddenByOfferedFlag(
  name: string,
  options: {
    scripting?: boolean;
    memory?: boolean;
    schedules?: boolean;
    direct?: boolean;
  },
): boolean {
  const gates: Array<[boolean, readonly string[] | string]> = [
    [options.scripting !== false, SCRIPT_TOOLS],
    [options.memory !== false, "memory_write"],
    [Boolean(options.schedules), SCHEDULE_TOOLS],
    [Boolean(options.direct), "secret_request"],
  ];
  return gates.some(([allowed, tools]) => !allowed && nameMatchesToolList(name, tools));
}

function offeredNativeNames(
  names: string[],
  options: {
    scripting?: boolean;
    memory?: boolean;
    schedules?: boolean;
    direct?: boolean;
  },
): string[] {
  return names.filter((name) => {
    if (name === "report_issue" || isBrowserOrCodingToolName(name)) {
      return false;
    }
    return !isHiddenByOfferedFlag(name, options);
  });
}

function capabilityToolNames(options: { coding?: boolean; browser?: boolean }): string[] {
  return [
    ...(options.coding ? [...CODING_TOOLS, ...HARNESS_TOOLS] : []),
    ...(options.browser ? BROWSER_TOOLS : []),
  ];
}

// The browser and code tools follow the agent's flags, not bindings.
export function offeredToolNames(
  names: string[],
  options: {
    browser?: boolean;
    coding?: boolean;
    scripting?: boolean;
    memory?: boolean;
    schedules?: boolean;
    direct?: boolean;
  } = {},
): string[] {
  const offered = offeredNativeNames(names, options);
  for (const name of capabilityToolNames(options)) {
    if (!offered.includes(name)) {
      offered.push(name);
    }
  }
  offered.push("report_issue");
  return offered;
}

function toolSchemaName(tool: unknown): string {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return "";
  }
  const record = tool as Record<string, unknown>;
  const fn =
    record.function && typeof record.function === "object" && !Array.isArray(record.function)
      ? (record.function as Record<string, unknown>)
      : null;
  return (
    (fn && typeof fn.name === "string" ? fn.name : "") ||
    (typeof record.name === "string" ? record.name : "")
  );
}

function snapshotOfferedNames(tools: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(tools)) {
    return names;
  }
  for (const tool of tools) {
    const name = toolSchemaName(tool);
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function hasScriptTools(names: string[]): boolean {
  return SCRIPT_TOOLS.some((name) => names.includes(name));
}

function hasNoteTools(names: string[]): boolean {
  return NOTE_TOOLS.some((name) => names.includes(name));
}

function hasMemoryTool(names: string[]): boolean {
  return names.includes("memory_write");
}

/** First-class script schemas follow `script_run`, not the frozen native/MCP list. */
function withFirstClassScriptTools(
  tools: unknown[],
  runScripts: RunScriptSnapshot[],
  scriptRunOffered: boolean,
): unknown[] {
  const firstClass = new Set(
    runScripts.filter((row) => row.parameters !== null).map((row) => row.name),
  );
  const kept = tools.filter((tool) => !firstClass.has(toolSchemaName(tool)));
  if (!scriptRunOffered) {
    return kept;
  }
  return [...kept, ...firstClassScriptSchemas(runScripts)];
}

function liveOfferedNames(
  snapshotNames: Set<string>,
  rows: Array<Record<string, unknown>>,
  options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
    browser: boolean;
    coding: boolean;
    scripting: boolean;
    memory: boolean;
    schedules: boolean;
    direct: boolean;
  },
): Set<string> {
  const nativeRows = rows.filter((row) => row.catalog_kind === "native_tool");
  if (!nativeRows.length) {
    return snapshotNames;
  }
  const liveNative = new Set(
    offeredToolNames(enabledToolNames(resolvedTools(rows, options)), {
      browser: options.browser,
      coding: options.coding,
      scripting: options.scripting,
      memory: options.memory,
      schedules: options.schedules,
      direct: options.direct,
    }),
  );
  const offered = new Set<string>();
  for (const name of snapshotNames) {
    if (name in REGISTRY && !liveNative.has(name)) {
      continue;
    }
    offered.add(name);
  }
  return offered;
}

function mcpGroupRecord(group: unknown): Record<string, unknown> | null {
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    return null;
  }
  return group as Record<string, unknown>;
}

function schemasFromMcpTool(tool: unknown): Array<Record<string, unknown>> {
  const record = mcpGroupRecord(tool);
  if (!record) {
    return [];
  }
  const schema = record.schema;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? [schema as Record<string, unknown>]
    : [];
}

function schemasFromMcpGroups(mcp: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return mcp.flatMap((group) => {
    const tools = group.tools;
    return Array.isArray(tools) ? tools.flatMap(schemasFromMcpTool) : [];
  });
}

function mcpToolNamePairs(tools: unknown): Array<{ name: unknown; remote_name: unknown }> {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    const record = mcpGroupRecord(tool);
    return record ? [{ name: record.name, remote_name: record.remote_name }] : [];
  });
}

export function configSnapshot(
  config: AgentConfig | Record<string, unknown>,
  options: {
    tools: string[];
    secrets: Array<Record<string, string>>;
    mcp?: Array<Record<string, unknown>> | null;
    schedules?: boolean;
    direct?: boolean;
    scripts?: RunScriptSnapshot[];
  },
): Record<string, unknown> {
  const mcp = options.mcp ?? [];
  const native = schemasFor(
    offeredToolNames(options.tools, {
      browser: Boolean(config.browser),
      coding: Boolean(config.coding),
      scripting: config.scripting !== false,
      memory: memoryOf(config),
      schedules: Boolean(options.schedules),
      direct: Boolean(options.direct),
    }),
  );
  const snapshot: Record<string, unknown> = {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    max_steps: config.max_steps,
    max_tool_calls: positiveInt(config.max_tool_calls, DEFAULT_MAX_TOOL_CALLS),
    max_input_tokens: positiveInt(config.max_input_tokens, DEFAULT_MAX_INPUT_TOKENS),
    keep_tool_result_generations: keepToolResultGenerationsOf(config),
    projection_policy_version: RUN_PROJECTION_POLICY_VERSION,
    browser: Boolean(config.browser),
    browser_language: browserLanguageOf(config),
    coding: Boolean(config.coding),
    harness: harnessOf(config),
    harness_model: harnessModelOf(config),
    harness_effort: harnessEffortOf(config),
    secret_aliases: secretAliasesOf(config),
    scripting: config.scripting !== false,
    memory: memoryOf(config),
    thinking_level: config.thinking_level ?? "none",
    database: false,
    tools: [...native, ...schemasFromMcpGroups(mcp), ...firstClassScriptSchemas(options.scripts ?? [])],
    mcp: mcp.map((group) => ({
      connection_id: group.connection_id,
      server_id: group.server_id,
      slug: group.slug,
      tools: mcpToolNamePairs(group.tools),
    })),
    secrets: [...options.secrets],
  };
  if (options.scripts) {
    snapshot.scripts = options.scripts;
  }
  return snapshot;
}

// Maps a run snapshot's connection tools to `[connection_id, remote_name]`.
// A name the native registry owns is never a connection tool, whatever the
// snapshot lists: native dispatch wins.
function indexConnectionTools(
  index: Record<string, [string, string]>,
  connectionId: string,
  tools: unknown,
): void {
  if (!Array.isArray(tools)) {
    return;
  }
  for (const tool of tools) {
    const item = mcpGroupRecord(tool);
    if (!item) {
      continue;
    }
    const name = item.name;
    const remote = item.remote_name;
    if (typeof name === "string" && typeof remote === "string" && !(name in REGISTRY)) {
      index[name] = [connectionId, remote];
    }
  }
}

export function mcpIndex(mcp: unknown): Record<string, [string, string]> {
  const index: Record<string, [string, string]> = {};
  if (!Array.isArray(mcp)) {
    return index;
  }
  for (const group of mcp) {
    const record = mcpGroupRecord(group);
    if (!record || typeof record.connection_id !== "string") {
      continue;
    }
    indexConnectionTools(index, record.connection_id, record.tools);
  }
  return index;
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
    const record = mcpGroupRecord(group);
    if (!record || typeof record.connection_id !== "string") {
      continue;
    }
    Object.assign(values, await tokenRedactionsForConnection(db, record.connection_id));
  }
  return values;
}

export function toolCallsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls = payload.tool_calls || [];
  return Array.isArray(calls) ? (calls as Array<Record<string, unknown>>) : [];
}

export function executedToolCalls(rows: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const row of rows) {
    if (asObj(row.payload).role === "tool") {
      total += 1;
    }
  }
  return total;
}

function assistantCallId(call: unknown): string | null {
  if (!call || typeof call !== "object") {
    return null;
  }
  const callId = (call as Record<string, unknown>).id;
  return typeof callId === "string" && callId ? callId : null;
}

function rememberPendingAssistantCalls(
  pending: Map<string, [Record<string, unknown>, number]>,
  order: string[],
  payload: Record<string, unknown>,
  generation: number,
): void {
  for (const call of toolCallsOf(payload)) {
    const callId = assistantCallId(call);
    if (!callId) {
      continue;
    }
    if (!pending.has(callId)) {
      order.push(callId);
    }
    pending.set(callId, [call, generation]);
  }
}

function forgetResolvedToolCall(
  pending: Map<string, [Record<string, unknown>, number]>,
  order: string[],
  payload: Record<string, unknown>,
): void {
  const callId = payload.tool_call_id;
  if (typeof callId !== "string") {
    return;
  }
  pending.delete(callId);
  const index = order.indexOf(callId);
  if (index >= 0) {
    order.splice(index, 1);
  }
}

export function pendingToolCalls(
  rows: Array<Record<string, unknown>>,
): Array<[Record<string, unknown>, number]> {
  const pending = new Map<string, [Record<string, unknown>, number]>();
  const order: string[] = [];
  for (const row of rows) {
    const payload = asObj(row.payload);
    const generation = Number(asObj(row.metadata).generation || 1);
    if (payload.role === "assistant") {
      rememberPendingAssistantCalls(pending, order, payload, generation);
    } else if (payload.role === "tool") {
      forgetResolvedToolCall(pending, order, payload);
    }
  }
  return order.flatMap((callId) => {
    const item = pending.get(callId);
    return item ? [item] : [];
  });
}

function toolCallNameAndId(call: Record<string, unknown>): { name: string; callId: string } {
  const fn =
    call.function && typeof call.function === "object" && !Array.isArray(call.function)
      ? (call.function as Record<string, unknown>)
      : {};
  return {
    name: typeof fn.name === "string" ? fn.name : "",
    callId: typeof call.id === "string" ? call.id : "",
  };
}

export function interruptionRecord(
  call: Record<string, unknown>,
  generation: number,
): [Record<string, unknown>, Record<string, unknown>] {
  const { name, callId } = toolCallNameAndId(call);
  const payload = {
    role: "tool",
    tool_call_id: callId,
    content: INTERRUPTED_CONTENT,
  };
  const metadata: Record<string, unknown> = {
    generation,
    tool_name: name,
    tool_call_id: callId,
    duration_ms: 0,
    output_filter: "identity",
    truncated: false,
    original_bytes: Buffer.from(INTERRUPTED_CONTENT, "utf8").length,
    stored_bytes: Buffer.from(INTERRUPTED_CONTENT, "utf8").length,
    error: "execution interrupted",
  };
  if (name === "script_run" || name === "shell") {
    metadata.exit_code = null;
  }
  return [payload, metadata];
}

export class PreparedRun {
  constructor(
    public agent: Record<string, unknown>,
    public config: AgentConfig,
    public access: {
      tools: string[];
      secrets: Array<Record<string, string>>;
      mcp: Array<Record<string, unknown>>;
      grants?: ArtifactGrants;
    },
    public members: Array<Record<string, unknown>>,
    public history_rows: Array<Record<string, unknown>>,
    public standing: string,
    public system: string,
    public task: string,
    public memory: string,
    public scripts: RunScriptSnapshot[] = [],
    public taskSource: Record<string, unknown> | null = null,
    public typesafe: Record<string, unknown> | null = null,
  ) {}

  get secrets(): Array<Record<string, string>> {
    return this.access.secrets;
  }

  get hashes(): { system: string; task: string; memory: string } {
    return {
      system: promptHash(this.standing),
      task: promptHash(this.task),
      memory: promptHash(this.memory),
    };
  }

  snapshot(options: { schedules?: boolean; direct?: boolean } = {}): Record<string, unknown> {
    return configSnapshot(this.config, {
      tools: this.access.tools,
      secrets: this.access.secrets,
      mcp: this.access.mcp,
      schedules: Boolean(options.schedules),
      direct: Boolean(options.direct),
      scripts: this.scripts,
    });
  }
}

function preparedRunMetadata(
  prepared: PreparedRun,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (prepared.taskSource) {
    metadata.task_source = prepared.taskSource;
  }
  if (prepared.typesafe || extra) {
    metadata.typesafe = { ...(prepared.typesafe ?? {}), ...(extra ?? {}) };
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

export type GenerationDb = AccessDatabase &
  AgentSecretsDatabase &
  GroupChatDatabase & {
    getRun(runId: string): Promise<Record<string, unknown> | null>;
    getAgent(agentId: string): Promise<Record<string, unknown> | null>;
    getGuild(guildId: string): Promise<Record<string, unknown> | null>;
    listAgents(guildId: string): Promise<Array<Record<string, unknown>>>;
    listRuns(agentId: string): Promise<Array<Record<string, unknown>>>;
    listActiveRuns(): Promise<Array<Record<string, unknown>>>;
    listGroupMessages(
      guildId: string,
      options?: { throughSeq?: number | null },
    ): Promise<Array<Record<string, unknown>>>;
    createRun(
      runId: string,
      agentId: string,
      configSnapshot: Record<string, unknown>,
      systemContent: string,
      taskContent: string,
      userContent: string | null,
      now: Date,
      options: {
        systemPromptHash: string;
        taskPromptHash: string;
        memoryPromptHash: string;
        extraMessages?: Array<[Record<string, unknown>, Record<string, unknown>]>;
        runMetadata?: Record<string, unknown>;
        userMetadata?: Record<string, unknown>;
      },
    ): Promise<void>;
    createGroupRun(
      runId: string,
      agentId: string,
      configSnapshot: Record<string, unknown>,
      systemContent: string,
      taskContent: string,
      projected: Array<[Record<string, unknown>, Record<string, unknown>]>,
      throughSeq: number,
      now: Date,
      options: {
        systemPromptHash: string;
        taskPromptHash: string;
        memoryPromptHash: string;
        runMetadata?: Record<string, unknown>;
      },
    ): Promise<void>;
    createScheduleRun(
      runId: string,
      agentId: string,
      configSnapshot: Record<string, unknown>,
      systemContent: string,
      taskContent: string,
      projected: Array<[Record<string, unknown>, Record<string, unknown>]>,
      now: Date,
      options: {
        systemPromptHash: string;
        taskPromptHash: string;
        memoryPromptHash: string;
        scheduleId?: string | null;
        runMetadata?: Record<string, unknown>;
      },
    ): Promise<void>;
    insertMessage(
      runId: string,
      seq: number,
      payload: Record<string, unknown>,
      metadata: Record<string, unknown>,
      now: Date,
    ): Promise<Record<string, unknown>>;
    listMessages(runId: string): Promise<Array<Record<string, unknown>>>;
    listPayloads(runId: string): Promise<Array<Record<string, unknown>>>;
    nextSeq(runId: string): Promise<number>;
    nextGeneration(runId: string): Promise<number>;
    appendRunError(runId: string, entry: Record<string, unknown>, now: Date): Promise<unknown[]>;
    mergeRunMetadata(runId: string, extra: Record<string, unknown>, now: Date): Promise<void>;
    /** Records when the agent's harness last found a login in its home. */
    markHarnessLogin?(agentId: string, harness: Harness, now: Date, account: string | null): Promise<void>;
    clearHarnessLogin?(agentId: string, harness: Harness): Promise<void>;
    /** Keeps the harness CLIs a machine's image carries. */
    setMachineHarnesses?(machineId: string, harnesses: string[]): Promise<void>;
    completeRun(runId: string, now: Date): Promise<void>;
    reopenRun(runId: string, now: Date): Promise<void>;
    completeGroupDelivery(
      runId: string,
      agentId: string,
      throughSeq: number,
      now: Date,
    ): Promise<void>;
    updateRunSecrets(
      runId: string,
      secrets: Array<Record<string, string>>,
      now: Date,
    ): Promise<void>;
    updateRunScripts(runId: string, scripts: RunScriptSnapshot[], now: Date): Promise<void>;
    listDueSchedules(now: Date): Promise<Array<Record<string, unknown>>>;
    markScheduleFired(scheduleId: string, now: Date, wake: PlannedWake): Promise<void>;
    listActiveRunAgentIdsForSecret(secretId: string): Promise<string[]>;
    purgeAgent(agentId: string): Promise<void>;
    purgeGuild(guildId: string): Promise<void>;
    getMcpConnection(connectionId: string): Promise<Record<string, unknown> | null>;
    getMcpServer(serverId: string): Promise<Record<string, unknown> | null>;
    getAgentScript(agentId: string, name: string): Promise<Record<string, unknown> | null>;
    upsertAgentScript(
      actor: ArtifactActor,
      scriptId: string,
      agentId: string,
      name: string,
      description: string,
      parameters: Record<string, unknown> | null,
      source: string,
      sourceHash: string,
      now: Date,
    ): Promise<Record<string, unknown>>;
    listAgentScripts(agentId: string): Promise<Array<Record<string, unknown>>>;
    deleteAgentScript(
      actor: ArtifactActor,
      agentId: string,
      name: string,
    ): Promise<Record<string, unknown> | null>;
    insertSchedule?(
      scheduleId: string,
      agentId: string,
      timing: ScheduleTiming,
      description: string,
      instruction: string,
      wake: PlannedWake,
      now: Date,
    ): Promise<Record<string, unknown>>;
    deleteSchedule?(agentId: string, scheduleId: string): Promise<Record<string, unknown> | null>;
    getSchedule?(agentId: string, scheduleId: string): Promise<Record<string, unknown> | null>;
    setSchedulePaused?(
      agentId: string,
      scheduleId: string,
      paused: boolean,
      wake: PlannedWake | null,
      now: Date,
    ): Promise<Record<string, unknown> | null>;
    listSchedules?(agentId: string): Promise<Array<Record<string, unknown>>>;
    listSchedulesForGuild?(guildId: string): Promise<Array<Record<string, unknown>>>;
    setScheduleNextRun?(scheduleId: string, wake: PlannedWake, now: Date): Promise<void>;
    insertIssue?(
      issueId: string,
      guildId: string,
      orgId: string,
      agentId: string | null,
      agentName: string,
      runId: string | null,
      kind: string,
      severity: string,
      summary: string,
      detail: string,
      toolName: string | null,
      now: Date,
    ): Promise<Record<string, unknown>>;
    listIssuesForGuild?(
      guildId: string,
      status: string | null,
    ): Promise<Array<Record<string, unknown>>>;
    getIssue?(guildId: string, issueId: string): Promise<Record<string, unknown> | null>;
    setIssueStatus?(
      guildId: string,
      issueId: string,
      status: string,
      resolvedAt: Date | null,
      resolvedBy: string | null,
      now: Date,
    ): Promise<Record<string, unknown> | null>;
    resolveOpenIssues?(
      guildId: string,
      resolvedAt: Date,
      resolvedBy: string,
      now: Date,
    ): Promise<number>;
    countOpenIssues?(guildId: string): Promise<number>;
    setAgentWorkspaceMib?(agentId: string, mib: number): Promise<void>;
    setMachineWorkspaceMib?(machineId: string, mib: number): Promise<void>;
    moveAgent?(
      agentId: string,
      machineId: string,
      options?: { maxAgentsPerMachine?: number | null; needs?: AgentNeeds },
    ): Promise<{ from: { machineId: string; slot: number }; to: { machineId: string; slot: number } } | null>;
    listGuildRepositories?(guildId: string): Promise<Array<Record<string, unknown>>>;
    getMcpConnectionForOwner?(
      serverId: string,
      ownerScope: string,
      ownerId: string | null,
    ): Promise<Record<string, unknown> | null>;
    saveMcpConnection?(
      connectionId: string,
      options: {
        ciphertext: Buffer;
        nonce: Buffer;
        status: string;
        accountHint: string;
        oauthState: string | null;
        now: Date;
      },
    ): Promise<Record<string, unknown> | null>;
    getOrgMonthlyUsage?(orgId: string, month: string): Promise<Record<string, unknown> | null>;
    getOrgModelProvider?(orgId: string, provider: string): Promise<Record<string, unknown> | null>;
  };

export type GenerationNotes = Partial<DirectoryNotes> &
  Partial<PromptNotes> & {
    agentDir(orgSlug: string, guildName: string, agentName: string): string;
    systemPath(): string;
    deleteAgent?(orgSlug: string, guildName: string, name: string): Promise<void>;
    deleteGuild?(orgSlug: string, name: string): Promise<void>;
    writeMemory?(
      orgSlug: string,
      guildName: string,
      agentName: string,
      content: string,
      options: { source: string; replacedBy: string },
    ): Promise<unknown>;
    ensureSystemPrompt?(): Promise<void>;
    createGuild?(orgSlug: string, name: string): Promise<void>;
    createAgent?(orgSlug: string, guildName: string, name: string, task?: string): Promise<void>;
    readRoutineNote?(
      orgSlug: string,
      guildName: string,
      agentName: string,
      scheduleId: string,
    ): string | null;
  };

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
  /** Starts the agent's display, Chrome, and noVNC when they are not up, and waits until they answer. */
  startBrowser(sandbox: SandboxHandle, seat: AgentSeat): Promise<void>;
  stopBrowser(sandbox: SandboxHandle, seat: AgentSeat): Promise<void>;
  /** Stops the agent's browser and terminal; with `purge`, also removes its runtime files. */
  stopAgent(sandbox: SandboxHandle, seat: AgentSeat, options?: { purge?: boolean }): Promise<void>;
  novncTarget(sandbox: SandboxHandle, seat: AgentSeat): Promise<[string, Record<string, string>]>;
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
export function agentMachine(agent: Record<string, unknown>): MachineSpec {
  return machineSpec({
    id: String(agent.machine_id),
    org_id: String(agent.org_id),
    box: machineFromRow({ box: agent.machine_box }).box,
    cpu: agent.machine_cpu === null || agent.machine_cpu === undefined ? null : Number(agent.machine_cpu),
    memory_mib:
      agent.machine_memory_mib === null || agent.machine_memory_mib === undefined
        ? null
        : Number(agent.machine_memory_mib),
  });
}

/** An agent row's seat on its machine. */
export function agentSeat(agent: Record<string, unknown>): AgentSeat {
  return {
    agentId: String(agent.id),
    machineId: String(agent.machine_id),
    slot: Number(agent.machine_slot),
    browserLanguage: browserLanguageOf(asObj(agent.config)),
  };
}

export class GenerationLoop implements GroupRunner {
  db: GenerationDb;
  notes: GenerationNotes;
  workspace_root: string;
  sandboxes: GenerationSandboxes;
  mcp: McpPool | { call: McpPool["call"]; syncTools?: McpPool["syncTools"] };
  group_chat: GroupChat;
  groupChat: GroupChat;
  issues: Issues;
  schedules: Schedules;
  scripts: Scripts;
  artifacts: ArtifactStore | null;
  attachments: AttachmentService | null;
  lock_generation = 0;
  admission = new AdmissionCoordinator();
  policy: OrgPolicy;
  credentials: ModelCredentialsProvider;
  _busy = new Set<string>();
  _busy_agents = new Set<string>();
  _deleting_guilds = new Set<string>();
  _run_agent = new Map<string, string>();
  _begin_mutex: Promise<void> = Promise.resolve();
  _tasks = new Map<string, Promise<void>>();
  /** Each running machine's idle stop, by machine id. */
  _idle_tasks: IdleTimers;
  /** Each running Chrome's idle stop, by agent id. */
  _browser_idle: IdleTimers;
  /** The machine of each agent that generates. */
  _agent_machine = new Map<string, string>();
  /** The machine of each agent whose Browser or CLI view started or had input, until it moves or goes. */
  _touched_machine = new Map<string, string>();
  _subs = new Map<string, Set<EventQueue<[string, Record<string, unknown>]>>>();
  _cancels = new Map<string, CancelEvent>();
  _cancel_tasks = new Map<string, Promise<void>>();
  _commands = new Map<string, [SandboxHandle, string]>();
  /** Machines whose tier or size changed while an agent on them generated. */
  _stale_machines = new Set<string>();
  /** The harness list each machine's row was last given. */
  _harness_reports = new Map<string, string>();
  /** A run that handed off, to the run that continues it once its generation ends. */
  _continuations = new Map<string, string>();
  _scheduler_tick_ms: number;
  _scheduler_abort: AbortController | null = null;
  _scheduler_task: Promise<void> | null = null;
  _lock_event = new AsyncEvent();
  _group_router: GroupRouter;

  constructor(
    db: GenerationDb,
    notes: GenerationNotes,
    workspaceRoot: string,
    sandboxes: GenerationSandboxes,
    options: {
      idleTimeoutMs?: number;
      schedulerTickMs?: number;
      cancelGraceMs?: number;
      shutdownTimeoutMs?: number;
      mcp?: McpPool | { call: McpPool["call"]; syncTools?: McpPool["syncTools"] } | null;
      artifacts?: ArtifactStore | null;
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
    this.workspace_root = workspaceRoot;
    this.sandboxes = sandboxes;
    this.mcp = options.mcp ?? new McpPool();
    this.artifacts = options.artifacts ?? null;
    this.attachments = options.attachments ?? null;
    if (options.admission) {
      this.admission = options.admission;
    }
    this.policy = options.policy ?? OPEN_POLICY;
    this.credentials =
      options.credentials ??
      (db.getOrgModelProvider
        ? coreModelCredentials({ getOrgModelProvider: (orgId, provider) => db.getOrgModelProvider!(orgId, provider) })
        : NO_CREDENTIALS);
    const idleTimeoutMs = options.idleTimeoutMs ?? SANDBOX_IDLE_TIMEOUT_MS;
    this._idle_tasks = new IdleTimers(idleTimeoutMs);
    this._browser_idle = new IdleTimers(idleTimeoutMs);
    this._scheduler_tick_ms = options.schedulerTickMs ?? SCHEDULER_TICK_MS;
    if (options.cancelGraceMs !== undefined) {
      generationLive.cancelGraceMs = options.cancelGraceMs;
    }
    if (options.shutdownTimeoutMs !== undefined) {
      generationLive.shutdownTimeoutMs = options.shutdownTimeoutMs;
    }
    const groupRouter = options.groupRouter ?? defaultGroupRouter();
    this.group_chat = new GroupChat(db, {
      is_deleting: (guildId) => this.deleting_guild(guildId),
      router: groupRouter,
    });
    this.groupChat = this.group_chat;
    this.group_chat.bind(this);
    this._group_router = groupRouter;
    this.issues = new Issues(db as IssuesDatabase);
    this.schedules = new Schedules(db as ScheduleDatabase, notes as NotesStore);
    this.scripts = new Scripts(db);
  }

  get lockGeneration(): number {
    return this.lock_generation;
  }

  generating(runId: string): boolean {
    return this._busy.has(runId);
  }

  subscribe(runId: string): EventQueue<[string, Record<string, unknown>]> {
    const queue = new EventQueue<[string, Record<string, unknown>]>();
    const listeners = this._subs.get(runId) ?? new Set();
    listeners.add(queue);
    this._subs.set(runId, listeners);
    return queue;
  }

  unsubscribe(runId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    const listeners = this._subs.get(runId);
    if (listeners) {
      listeners.delete(queue);
      if (!listeners.size) {
        this._subs.delete(runId);
      }
    }
  }

  async publish(runId: string, event: string, data: Record<string, unknown>): Promise<void> {
    for (const queue of [...(this._subs.get(runId) ?? [])]) {
      if (queue.size >= EVENT_QUEUE_LIMIT) {
        this.unsubscribe(runId, queue);
        continue;
      }
      await queue.put([event, data]);
    }
  }

  async create_run(
    agentId: string,
    message: string | null,
    options: { attachments?: AttachmentRef[] } = {},
  ): Promise<Record<string, unknown>> {
    return this.createRun(agentId, message, options);
  }

  async createRun(
    agentId: string,
    message: string | null,
    options: { attachments?: AttachmentRef[] } = {},
  ): Promise<Record<string, unknown>> {
    const attachments = options.attachments ?? [];
    const opening = message === null && attachments.length ? "" : message;
    const prepared = await this._prepare_run(agentId);
    if (opening !== null && this._busy_agents.has(agentId)) {
      throw new RunRequestError(409, "agent is already generating");
    }
    const runId = newId("r");
    const now = new Date();
    const current = prepared.hashes;
    const runMetadata = preparedRunMetadata(prepared);
    const userMetadata = attachments.length ? { attachments } : undefined;
    const create = () =>
      this.db.createRun(
        runId,
        agentId,
        prepared.snapshot({ schedules: true, direct: true }),
        prepared.system,
        prepared.task,
        opening,
        now,
        {
          systemPromptHash: current.system,
          taskPromptHash: current.task,
          memoryPromptHash: current.memory,
          ...(runMetadata ? { runMetadata } : {}),
          ...(userMetadata ? { userMetadata } : {}),
        },
      );
    if (opening === null) {
      await create();
    } else {
      try {
        await this._create_started(runId, agentId, create);
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new RunRequestError(409, error.message);
        }
        throw error;
      }
    }
    const row = await this.db.getRun(runId);
    if (row === null) {
      throw new RunRequestError(404, "run not found");
    }
    return this.run_view(row);
  }

  async deliver_group_run(
    agentId: string,
    throughSeq: number,
    deliveredThrough: number,
  ): Promise<void> {
    return this.deliverGroupRun(agentId, throughSeq, deliveredThrough);
  }

  async deliverGroupRun(
    agentId: string,
    throughSeq: number,
    deliveredThrough: number,
  ): Promise<void> {
    let prepared: PreparedRun;
    try {
      prepared = await this._prepare_run(agentId, { throughSeq });
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new DeliveryCreateError(error.detail);
      }
      throw error;
    }
    const agent = prepared.agent;
    if (this._busy_agents.has(agentId)) {
      throw new DeliveryBusyError();
    }
    const projected = [
      groupChatUserMessage({
        members: prepared.members,
        rows: prepared.history_rows,
        viewerName: String(agent.name),
        deliveredThrough,
      }),
    ];
    const runId = newId("r");
    const now = new Date();
    const current = prepared.hashes;
    const recipients = this.group_chat.recipientMetadata();
    const runMetadata = preparedRunMetadata(prepared, recipients ? { recipients } : null);
    const create = () =>
      this.db.createGroupRun(
        runId,
        agentId,
        prepared.snapshot({ schedules: true }),
        prepared.system,
        prepared.task,
        projected,
        throughSeq,
        now,
        {
          systemPromptHash: current.system,
          taskPromptHash: current.task,
          memoryPromptHash: current.memory,
          ...(runMetadata ? { runMetadata } : {}),
        },
      );
    try {
      await this._create_started(runId, agentId, create);
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new DeliveryBusyError();
      }
      throw error;
    }
    const task = this._tasks.get(runId);
    if (task) {
      await task;
    }
    await this.db.completeGroupDelivery(runId, agentId, throughSeq, new Date());
  }

  async deliver_schedule_run(schedule: Record<string, unknown>): Promise<void> {
    return this.deliverScheduleRun(schedule);
  }

  async deliverScheduleRun(schedule: Record<string, unknown>): Promise<void> {
    const agentId = String(schedule.agent_id);
    let prepared: PreparedRun;
    try {
      prepared = await this._prepare_run(agentId);
    } catch (error) {
      if (error instanceof RunRequestError) {
        throw new DeliveryCreateError(error.detail);
      }
      throw error;
    }
    if (this._busy_agents.has(agentId)) {
      throw new DeliveryBusyError();
    }
    const instruction = await this.schedules.instructionFor(agentId, schedule);
    const projected = [
      scheduleWakeUserMessage({
        id: String(schedule.id),
        timing: rowTiming(schedule),
        instruction,
        previousRunAt: schedule.last_run_at ? iso(schedule.last_run_at) : null,
      }),
    ];
    const runId = newId("r");
    const now = new Date();
    const current = prepared.hashes;
    const runMetadata = {
      ...(preparedRunMetadata(prepared) ?? {}),
      instruction_hash: instructionHash(instruction),
    };
    const create = () =>
      this.db.createScheduleRun(
        runId,
        agentId,
        prepared.snapshot(),
        prepared.system,
        prepared.task,
        projected,
        now,
        {
          systemPromptHash: current.system,
          taskPromptHash: current.task,
          memoryPromptHash: current.memory,
          scheduleId: String(schedule.id),
          runMetadata,
        },
      );
    try {
      await this._create_started(runId, agentId, create);
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new DeliveryBusyError();
      }
      throw error;
    }
  }

  async fire_due_schedules(now?: Date): Promise<void> {
    return this.fireDueSchedules(now);
  }

  async fireDueSchedules(now?: Date): Promise<void> {
    const when = now ?? new Date();
    for (const row of await this.db.listDueSchedules(when)) {
      if (this._busy_agents.has(String(row.agent_id))) {
        continue;
      }
      try {
        await this.deliver_schedule_run(row);
      } catch (error) {
        if (error instanceof DeliveryBusyError) {
          continue;
        }
        if (error instanceof DeliveryCreateError) {
          writeLog("error", error.message, {
            agent_id: String(row.agent_id),
            operation: "schedule.fire",
          });
        } else {
          writeLog(
            "error",
            "schedule wake-up failed",
            {
              agent_id: String(row.agent_id),
              operation: "schedule.fire",
              error_type: errorName(error),
            },
            error,
          );
        }
      }
      await this.db.markScheduleFired(String(row.id), when, planAfterFire(row, when));
    }
  }

  start_scheduler(): void {
    this.startScheduler();
  }

  startScheduler(): void {
    if (this._scheduler_abort && !this._scheduler_abort.signal.aborted) {
      return;
    }
    const abort = new AbortController();
    this._scheduler_abort = abort;
    this._scheduler_task = this._scheduler_loop(abort.signal);
  }

  async close(): Promise<void> {
    const abort = this._scheduler_abort;
    this._scheduler_abort = null;
    abort?.abort();
    for (const machineId of this._idle_tasks.keys()) {
      this._cancel_idle(machineId);
    }
    for (const agentId of this._browser_idle.keys()) {
      this._cancel_browser_idle(agentId);
    }
    if (this._scheduler_task) {
      const abortWait = new AbortController();
      await Promise.race([this._scheduler_task, sleep(50, abortWait.signal)]);
      abortWait.abort();
      this._scheduler_task = null;
    }
    await this.group_chat.stopDispatchers();
    const runIds = [...this._busy];
    for (const runId of runIds) {
      this._cancels.get(runId)?.set();
      const command = this._commands.get(runId);
      if (command) {
        try {
          await command[0].commands.interrupt?.(command[1]);
        } catch (error) {
          writeLog(
            "error",
            "command.interrupt failed",
            {
              run_id: runId,
              agent_id: this._run_agent.get(runId) ?? null,
              operation: "command.interrupt",
              error_type: errorName(error),
            },
            error,
          );
        }
      }
    }
    const tasks = runIds.flatMap((runId) => {
      const task = this._tasks.get(runId);
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

  deleting_guild(guildId: string): boolean {
    return this._deleting_guilds.has(guildId);
  }

  deletingGuild(guildId: string): boolean {
    return this.deleting_guild(guildId);
  }

  agent_is_busy(agentId: string): boolean {
    return this._busy_agents.has(agentId);
  }

  agentIsBusy(agentId: string): boolean {
    return this.agent_is_busy(agentId);
  }

  async wait_lock_release(seen: number): Promise<void> {
    while (this.lock_generation <= seen) {
      this._lock_event.clear();
      if (this.lock_generation > seen) {
        return;
      }
      await this._lock_event.wait();
    }
  }

  async waitForLockRelease(seen: number): Promise<void> {
    return this.wait_lock_release(seen);
  }

  _notify_lock_release(): void {
    this.lock_generation += 1;
    this._lock_event.set();
  }

  /** Whether an agent on this machine generates, `except` aside. */
  machineBusy(machineId: string, except?: string): boolean {
    for (const [agentId, machine] of this._agent_machine) {
      if (machine === machineId && agentId !== except && this._busy_agents.has(agentId)) {
        return true;
      }
    }
    return false;
  }

  _cancel_idle(machineId: string): void {
    this._idle_tasks.cancel(machineId);
  }

  /** Arms a machine's idle stop: its container goes after the idle timeout without work or input. */
  _schedule_idle(machineId: string): void {
    this._idle_tasks.arm(machineId, () => this._idle_stop(machineId));
  }

  async _idle_stop(machineId: string): Promise<void> {
    try {
      if (this.machineBusy(machineId)) {
        return;
      }
      await this.sandboxes.destroy(machineId);
      this._stale_machines.delete(machineId);
    } catch (error) {
      writeLog(
        "error",
        "idle sandbox stop failed",
        {
          machine_id: machineId,
          operation: "sandbox.idle.stop",
          error_type: errorName(error),
        },
        error,
      );
    }
  }

  _cancel_browser_idle(agentId: string): void {
    this._browser_idle.cancel(agentId);
  }

  /** Arms an agent's Chrome idle stop: it stops after the idle timeout without a browser call or input. */
  _schedule_browser_idle(agentId: string): void {
    this._browser_idle.arm(agentId, () => this.stopAgentBrowser(agentId));
  }

  /** Stops the agent's Chrome when its machine runs. Its profile and logins stay in its home. */
  async stopAgentBrowser(agentId: string): Promise<void> {
    this._cancel_browser_idle(agentId);
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      return;
    }
    try {
      const sandbox = await this.sandboxes.connectRunning(String(agent.machine_id));
      if (sandbox !== null) {
        await this.sandboxes.stopBrowser(sandbox, agentSeat(agent));
      }
    } catch (error) {
      writeLog(
        "error",
        "browser stop failed",
        { agent_id: agentId, operation: "browser.stop", error_type: errorName(error) },
        error,
      );
    }
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
    const live = new Set((await this.db.listActiveRuns()).map((row) => String(row.agent_id)));
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

  async sync_run_secrets(agent: Record<string, unknown>): Promise<Array<Record<string, string>>> {
    return this.syncRunSecrets(agent);
  }

  async syncRunSecrets(agent: Record<string, unknown>): Promise<Array<Record<string, string>>> {
    const refs = await agentSecrets(this.db, agent);
    const now = new Date();
    for (const run of await this.db.listRuns(String(agent.id))) {
      if (run.status !== "active" || (run.archived_at !== null && run.archived_at !== undefined)) {
        continue;
      }
      const snapshot = asObj(run.config_snapshot);
      if (JSON.stringify(snapshot.secrets) === JSON.stringify(refs)) {
        continue;
      }
      await this.db.updateRunSecrets(String(run.id), refs, now);
      snapshot.secrets = refs;
      run.config_snapshot = snapshot;
    }
    return refs;
  }

  /**
   * A machine's tier or size changed: an idle container goes now, a busy one once the last
   * generation on it ends. The next work on the machine starts a container of the new size.
   */
  async machineChanged(machineId: string): Promise<void> {
    this._stale_machines.add(machineId);
    if (this.machineBusy(machineId)) {
      return;
    }
    this._cancel_idle(machineId);
    try {
      await this.sandboxes.destroy(machineId);
      this._stale_machines.delete(machineId);
    } catch (error) {
      writeLog(
        "error",
        "sandbox refresh failed",
        { machine_id: machineId, operation: "sandbox.refresh", error_type: errorName(error) },
        error,
      );
    }
  }

  /**
   * A deleted machine: its container goes, and its directory with it. A container that fails to
   * go is retried by the machine's idle stop.
   */
  async deleteMachine(machineId: string): Promise<void> {
    this._cancel_idle(machineId);
    this._stale_machines.delete(machineId);
    try {
      await this.sandboxes.destroy(machineId);
    } catch (error) {
      writeLog(
        "error",
        "deleted machine sandbox stop failed",
        { machine_id: machineId, operation: "machine.delete", error_type: errorName(error) },
        error,
      );
      this._schedule_idle(machineId);
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
    await this.stopAgentBrowser(agentId);
  }

  async ensure_browser(agentId: string): Promise<unknown> {
    return this.ensureBrowser(agentId);
  }

  /** The agent's Chrome for the Browser tab: its machine woken, its display and noVNC up. */
  async ensureBrowser(agentId: string): Promise<unknown> {
    const agent = await this._runnable_agent(agentId);
    const config = this._valid_config(agent);
    if (!config.browser) {
      throw new RunRequestError(409, "browser is not enabled");
    }
    const sandbox = await this.wakeSandbox(agentId);
    this._touched_machine.set(agentId, String(agent.machine_id));
    await this.startAgentBrowser(agent, sandbox);
    return sandbox;
  }

  /** Starts the agent's Chrome on its machine and arms its idle stop. */
  async startAgentBrowser(agent: Record<string, unknown>, sandbox: SandboxHandle): Promise<void> {
    const agentId = String(agent.id);
    try {
      await this.sandboxes.startBrowser(sandbox, agentSeat(agent));
    } catch (error) {
      if (error instanceof SandboxError) {
        throw new RunRequestError(503, error.message);
      }
      throw error;
    }
    this._schedule_browser_idle(agentId);
  }

  async browser_proxy_target(agentId: string): Promise<[string, Record<string, string>]> {
    return this.browserProxyTarget(agentId);
  }

  async browserProxyTarget(agentId: string): Promise<[string, Record<string, string>]> {
    const agent = await this._runnable_agent(agentId);
    const sandbox = await this.sandboxes.connectRunning(String(agent.machine_id));
    if (sandbox === null) {
      throw new RunRequestError(503, "sandbox is not running");
    }
    try {
      return await this.sandboxes.novncTarget(sandbox, agentSeat(agent));
    } catch {
      throw new RunRequestError(503, "browser view is unavailable");
    }
  }

  async ensure_cli(agentId: string): Promise<unknown> {
    return this.ensureCli(agentId);
  }

  /** Wakes the agent's machine and starts the agent's terminal in its home. */
  async ensureCli(agentId: string): Promise<unknown> {
    const agent = await this._runnable_agent(agentId);
    const sandbox = await this.wakeSandbox(agentId);
    this._touched_machine.set(agentId, String(agent.machine_id));
    await this.startCliOn(sandbox, agent);
    return sandbox;
  }

  /** The agent's config, refused with 422 when it does not validate. */
  _valid_config(agent: Record<string, unknown>): AgentConfig {
    try {
      return validateConfig(asObj(agent.config));
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
    const agent = await this._runnable_agent(agentId);
    const config = this._valid_config(agent);
    const machine = agentMachine(agent);
    try {
      prepareWorkspace(await this.workspaceRootFor(machine.id), machine.id, agentId, { browser: config.browser });
    } catch (error) {
      throw new RunRequestError(503, errorMessage(error));
    }
    if (this.machineBusy(machine.id)) {
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
    this._stale_machines.delete(machine.id);
    this._schedule_idle(machine.id);
    this._report_harnesses(machine.id);
    return sandbox;
  }

  /**
   * Keeps on the machine's row the harness CLIs its container carries, as the provider read
   * them when it created the container.
   */
  _report_harnesses(machineId: string): void {
    const listed = this.sandboxes.harnessesOf?.(machineId) ?? null;
    if (listed === null || this._harness_reports.get(machineId) === listed.join(" ")) {
      return;
    }
    this._harness_reports.set(machineId, listed.join(" "));
    void Promise.resolve(this.db.setMachineHarnesses?.(machineId, listed)).catch((error: unknown) => {
      writeLog("warn", errorMessage(error), { operation: "machine.harnesses", error_type: errorName(error) });
    });
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
    const agent = await this._runnable_agent(agentId);
    const sandbox = await this.wakeSandbox(agentId);
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
    const agent = await this._runnable_agent(agentId);
    const sandbox = await this.wakeSandbox(agentId);
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
  async codingRepositoryNames(agent: Record<string, unknown>): Promise<string[]> {
    return (await this._guild_repositories(agent)).map((row) => String(row.name));
  }

  /**
   * Checks the agent's machine, waking it, for what `harness` would run on outside a run: a
   * login in the agent's home or nothing, since a granted secret reaches only a run. Records
   * the login as seen, or forgets it when none is left.
   */
  async checkHarness(agentId: string, harness: Harness): Promise<HarnessCheck> {
    const agent = await this._runnable_agent(agentId);
    const sandbox = await this.wakeSandbox(agentId);
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

  async cli_proxy_target(agentId: string): Promise<[string, Record<string, string>]> {
    return this.cliProxyTarget(agentId);
  }

  async cliProxyTarget(agentId: string): Promise<[string, Record<string, string>]> {
    const agent = await this._runnable_agent(agentId);
    const sandbox = await this.sandboxes.connectRunning(String(agent.machine_id));
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

  private async startCliOn(sandbox: SandboxHandle, agent: Record<string, unknown>): Promise<string> {
    try {
      return await this.sandboxes.startCli(sandbox, agentSeat(agent));
    } catch (error) {
      if (error instanceof SandboxError) {
        throw new RunRequestError(503, error.message);
      }
      throw error;
    }
  }

  touch_sandbox(agentId: string): void {
    this.touchSandbox(agentId);
  }

  /**
   * Operator input on a proxied Browser or CLI view counts as activity: the armed idle timers of
   * the agent's machine and of its Chrome restart.
   */
  touchSandbox(agentId: string): void {
    if (this._browser_idle.has(agentId)) {
      this._schedule_browser_idle(agentId);
    }
    const known = this._touched_machine.get(agentId);
    if (known !== undefined) {
      this.touchMachine(known);
      return;
    }
    void this.db.getAgent(agentId).then(
      (agent) => {
        if (agent !== null) {
          this._touched_machine.set(agentId, String(agent.machine_id));
          this.touchMachine(String(agent.machine_id));
        }
      },
      () => undefined,
    );
  }

  /** Input on a running machine's views arms its idle stop again. */
  private touchMachine(machineId: string): void {
    if (!this.machineBusy(machineId) && this._idle_tasks.has(machineId)) {
      this._schedule_idle(machineId);
    }
  }

  /**
   * Stops the agent's processes on its machine when it runs, and removes its runtime files and
   * its home. The machine's container stays up for the other agents on it.
   */
  private async removeAgentFromMachine(agent: Record<string, unknown>): Promise<void> {
    const agentId = String(agent.id);
    const machineId = String(agent.machine_id);
    this._cancel_browser_idle(agentId);
    this._touched_machine.delete(agentId);
    const sandbox = await this.sandboxes.connectRunning(machineId);
    if (sandbox !== null) {
      try {
        await this.sandboxes.stopAgent(sandbox, agentSeat(agent), { purge: true });
      } catch (error) {
        writeLog(
          "error",
          "agent stop failed",
          { agent_id: agentId, machine_id: machineId, operation: "agent.stop", error_type: errorName(error) },
          error,
        );
      }
    }
    const workspace = agentDirectory(await this.workspaceRootFor(machineId), machineId, agentId);
    if (existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  async delete_agent(agentId: string): Promise<void> {
    return this.deleteAgent(agentId);
  }

  async deleteAgent(agentId: string): Promise<void> {
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      throw new RunRequestError(404, "agent not found");
    }
    if (this._busy_agents.has(agentId)) {
      throw new RunRequestError(409, "agent is already generating");
    }
    this._busy_agents.add(agentId);
    try {
      await this.removeAgentFromMachine(agent);
      await this.notes.deleteAgent?.(
        String(agent.org_slug),
        String(agent.guild_name),
        String(agent.name),
      );
      await this.db.purgeAgent(agentId);
    } finally {
      this._busy_agents.delete(agentId);
      this._notify_lock_release();
    }
  }

  async delete_guild(guildId: string): Promise<void> {
    return this.deleteGuild(guildId);
  }

  async deleteGuild(guildId: string): Promise<void> {
    const guild = await this.db.getGuild(guildId);
    if (guild === null) {
      throw new RunRequestError(404, "guild not found");
    }
    if (this._deleting_guilds.has(guildId)) {
      throw new RunRequestError(409, "guild is already being deleted");
    }
    if (this.group_chat.is_dispatching(guildId)) {
      throw new RunRequestError(409, "guild group chat is delivering");
    }
    const agentIds = (await this.db.listAgents(guildId)).map((row) => String(row.id));
    if (agentIds.some((agentId) => this._busy_agents.has(agentId))) {
      throw new RunRequestError(409, "a member agent is already generating");
    }
    this._deleting_guilds.add(guildId);
    for (const agentId of agentIds) {
      this._busy_agents.add(agentId);
    }
    try {
      for (const agentId of agentIds) {
        const agent = await this.db.getAgent(agentId);
        if (agent !== null) {
          await this.removeAgentFromMachine(agent);
        }
      }
      await this.notes.deleteGuild?.(String(guild.org_slug), String(guild.name));
      await this.db.purgeGuild(guildId);
    } finally {
      for (const agentId of agentIds) {
        this._busy_agents.delete(agentId);
      }
      this._deleting_guilds.delete(guildId);
      this._notify_lock_release();
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
    options: { maxAgentsPerMachine?: number | null; needs?: AgentNeeds } = {},
  ): Promise<void> {
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      throw new RunRequestError(404, "agent not found");
    }
    const from = String(agent.machine_id);
    if (from === machineId) {
      return;
    }
    const { source, target, move } = await this.assertMovable(agentId, from, machineId);
    this._busy_agents.add(agentId);
    this._touched_machine.delete(agentId);
    try {
      this._cancel_browser_idle(agentId);
      const sandbox = await this.sandboxes.connectRunning(from);
      if (sandbox !== null) {
        await this.sandboxes.stopAgent(sandbox, agentSeat(agent), { purge: true });
      }
      const homeMoved = existsSync(source);
      if (homeMoved) {
        mkdirSync(path.dirname(target), { recursive: true });
        renameSync(source, target);
      }
      try {
        if ((await move(agentId, machineId, options)) === null) {
          throw new RunRequestError(404, "agent not found");
        }
      } catch (error) {
        if (homeMoved) {
          renameSync(target, source);
        }
        throw error;
      }
    } finally {
      this._busy_agents.delete(agentId);
      this._notify_lock_release();
    }
  }

  /** Refuses a move of a busy agent, where moves are unsupported, across hosts, or onto a home already there. */
  private async assertMovable(
    agentId: string,
    from: string,
    to: string,
  ): Promise<{ source: string; target: string; move: NonNullable<GenerationDb["moveAgent"]> }> {
    if (this._busy_agents.has(agentId)) {
      throw new RunRequestError(409, "agent is already generating");
    }
    if (!this.db.moveAgent) {
      throw new RunRequestError(501, "agents cannot move here");
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
    return { source: agentDirectory(sourceRoot, from, agentId), target, move: this.db.moveAgent.bind(this.db) };
  }

  async add_message(
    runId: string,
    content: string,
    attachments: AttachmentRef[] = [],
  ): Promise<Record<string, unknown>> {
    return this.addMessage(runId, content, attachments);
  }

  async resume_run(runId: string): Promise<Record<string, unknown>> {
    return this.resumeRun(runId);
  }

  async resumeRun(runId: string): Promise<Record<string, unknown>> {
    const run = await this.db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    if (run.archived_at !== null && run.archived_at !== undefined) {
      throw new RunRequestError(409, "run is archived");
    }
    if (run.status === "active") {
      return this.run_view(run);
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
    if (agent === null || (agent.archived_at !== null && agent.archived_at !== undefined)) {
      throw new RunRequestError(409, "agent is archived");
    }
    const now = new Date();
    await this.db.reopenRun(runId, now);
    const row = await this.db.getRun(runId);
    if (row === null) {
      throw new RunRequestError(404, "run not found");
    }
    return this.run_view(row);
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
    if (run.archived_at !== null && run.archived_at !== undefined) {
      throw new RunRequestError(409, "run is archived");
    }
    const next = continuedBy(run);
    if (next !== null) {
      throw new RunRequestError(409, `this run continued in run ${await this._latest_in_chain(next)}; send the message there`);
    }
    if (run.status !== "active") {
      throw new RunRequestError(409, "this run has ended; resume it to continue");
    }
    try {
      await this._begin(runId, String(run.agent_id));
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
        runId,
        seq,
        { role: "user", content },
        { generation, source: "ui", ...(attachments.length ? { attachments } : {}) },
        now,
      );
    } catch (error) {
      this._end(runId);
      throw error;
    }
    this._spawn(runId, generation);
    const row = await this.db.getRun(runId);
    if (row === null) {
      throw new RunRequestError(404, "run not found");
    }
    return this.run_view(row);
  }

  async cancel(runId: string): Promise<Record<string, unknown> | null> {
    const run = await this.db.getRun(runId);
    if (run === null) {
      throw new RunRequestError(404, "run not found");
    }
    if (run.status !== "active" || (run.archived_at !== null && run.archived_at !== undefined)) {
      throw new RunRequestError(409, "run is archived");
    }
    if (!this._busy.has(runId)) {
      return null;
    }
    const event = this._cancels.get(runId);
    event?.set();
    const command = this._commands.get(runId);
    if (command) {
      const [sandbox, executionId] = command;
      try {
        await sandbox.commands.interrupt?.(executionId);
      } catch (error) {
        writeLog(
          "error",
          "command.interrupt failed",
          {
            run_id: runId,
            agent_id: String(run.agent_id),
            operation: "command.interrupt",
            error_type: errorName(error),
          },
          error,
        );
      }
    }
    const task = this._tasks.get(runId);
    if (task) {
      const abortWait = new AbortController();
      await Promise.race([task, sleep(generationLive.cancelGraceMs, abortWait.signal)]);
      abortWait.abort();
      await task;
    }
    const row = await this.db.getRun(runId);
    return row ? this.run_view(row) : null;
  }

  async reconcile(): Promise<void> {
    const now = new Date();
    for (const run of await this.db.listActiveRuns()) {
      await this._resolve_unresolved(String(run.id));
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
      await this.db.appendRunError(String(run.id), entry, now);
      if (kind === "group") {
        const through = run.group_chat_through_seq;
        await this.db.completeGroupDelivery(
          String(run.id),
          String(run.agent_id),
          Number(through || 0),
          now,
        );
      } else {
        await this.db.completeRun(String(run.id), now);
      }
    }
    await this.group_chat.resume_all();
    for (const machineId of await this.sandboxes.listRunningMachineIds()) {
      if (!this.machineBusy(machineId)) {
        this._schedule_idle(machineId);
      }
    }
  }

  async run_payload(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.run_view(row);
  }

  async list_run_payloads(agentId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.db.listRuns(agentId)).map((item) => this.run_view(item));
  }

  async listRunPayloads(agentId: string): Promise<Array<Record<string, unknown>>> {
    return this.list_run_payloads(agentId);
  }

  run_view(row: Record<string, unknown>): Record<string, unknown> {
    return runItem(row, { generating: this.generating(String(row.id)) });
  }

  async _runnable_agent(agentId: string): Promise<Record<string, unknown>> {
    const agent = await this.db.getAgent(agentId);
    if (agent === null) {
      throw new RunRequestError(404, "agent not found");
    }
    if (agent.archived_at !== null && agent.archived_at !== undefined) {
      throw new RunRequestError(409, "agent is archived");
    }
    if (agent.guild_archived_at !== null && agent.guild_archived_at !== undefined) {
      throw new RunRequestError(409, "guild is archived");
    }
    if (this._deleting_guilds.has(String(agent.guild_id))) {
      throw new RunRequestError(409, "guild is being deleted");
    }
    return agent;
  }

  async _active_members(guildId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.db.listAgents(guildId)).filter(
      (member) => member.archived_at === null || member.archived_at === undefined,
    );
  }

  async _hydrate(agent: Record<string, unknown>): Promise<[string, string, string]> {
    if (this.artifacts && typeof agent.org_id === "string" && agent.org_id) {
      let system: string;
      try {
        system = hydrateStanding({
          systemPath: this.notes.systemPath(),
          agentName: String(agent.name),
          agentId: String(agent.id),
        });
      } catch (error) {
        if (error instanceof PromptError) {
          throw new RunRequestError(422, error.message);
        }
        throw error;
      }
      const operator = operatorActor({
        orgId: String(agent.org_id),
        actorId: "hydrate",
        actorName: "operator",
        guildId: String(agent.guild_id),
        agentId: String(agent.id),
      });
      try {
        const task = await inlineTaskEmbeds(this.artifacts, operator, String(agent.task ?? ""));
        const memory = await this.artifacts.readMemory(operator, String(agent.id));
        return [system, task, memory];
      } catch (error) {
        if (error instanceof ArtifactError) {
          throw new RunRequestError(422, error.message);
        }
        throw error;
      }
    }
    const agentDir = this.notes.agentDir(
      String(agent.org_slug),
      String(agent.guild_name),
      String(agent.name),
    );
    if (!isDir(agentDir)) {
      throw new RunRequestError(422, "agent folder not found");
    }
    let system: string;
    let task: string | null;
    try {
      [system, task] = hydratePrompts(agentDir, {
        systemPath: this.notes.systemPath(),
        includeTask: true,
        notes: this.notes as PromptNotes,
        orgSlug: String(agent.org_slug),
        guildName: String(agent.guild_name),
        agentName: String(agent.name),
        agentId: String(agent.id),
      });
    } catch (error) {
      if (error instanceof PromptError || error instanceof NotesError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
    if (typeof task !== "string") {
      throw new RunRequestError(422, "task prompt is required");
    }
    return [system, task, readMemory(agentDir)];
  }

  async _prepare_run(
    agentId: string,
    options: { throughSeq?: number | null } = {},
  ): Promise<PreparedRun> {
    const agent = await this._runnable_agent(agentId);
    let config: AgentConfig;
    let access;
    try {
      config = validateConfig(asObj(agent.config));
      access = await agentRuntime(this.db, agent, { mcpPool: this.mcp });
    } catch (error) {
      if (error instanceof AgentValidationError || error instanceof McpDisconnectedError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
    const members = await this._active_members(String(agent.guild_id));
    const [rawStanding, task, memory] = await this._hydrate(agent);
    const caps = {
      scripts: config.scripting && hasScriptTools(access.tools),
      notes: hasNoteTools(access.tools),
      browser: Boolean(config.browser),
      coding: Boolean(config.coding),
      memory: memoryOf(config),
      memoryWrite: memoryOf(config) && hasMemoryTool(access.tools),
    };
    const standing = standingForCapabilities(rawStanding, caps);
    const historyRows = await this.db.listGroupMessages(String(agent.guild_id), {
      throughSeq: options.throughSeq ?? null,
    });
    const historyDecision = await this._group_router.history({
      rows: historyRows,
      agentName: String(agent.name),
      agentFocus: String(agent.focus ?? ""),
    });
    const selectedHistory = historyDecision.rows;
    const scripts = caps.scripts ? await this.scripts.snapshot(String(agent.id)) : [];
    const taskSource = await this._taskSource(agent);
    const typesafe =
      historyDecision.source === "limit"
        ? null
        : { history: serializeHistoryDecision(historyDecision) };
    const system = composeSystemPrompt(
      standing,
      task,
      await this._run_state(
        agent,
        members,
        selectedHistory,
        access.secrets,
        config.max_tool_calls,
        access.grants,
        await this._connector_state(agent),
        caps.scripts ? await this.scripts.catalog(String(agent.id)) : [],
        caps.coding ? stateRepositories(await this._guild_repositories(agent), String(agent.id)) : null,
      ),
      memory,
      caps,
      connectorGuidance(access.mcp.map((group) => String(group.slug))),
    );
    return new PreparedRun(
      agent,
      config,
      access,
      members,
      historyRows,
      standing,
      system,
      task,
      memory,
      scripts,
      taskSource,
      typesafe,
    );
  }

  async _taskSource(agent: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!this.artifacts || typeof agent.org_id !== "string" || !agent.org_id) {
      return null;
    }
    const operator = operatorActor({
      orgId: String(agent.org_id),
      actorId: "hydrate",
      actorName: "operator",
      guildId: String(agent.guild_id),
      agentId: String(agent.id),
    });
    const source = String(agent.task ?? "");
    const version = Number(agent.task_version ?? 1);
    const hash = String(agent.task_hash ?? "");
    let embeds: Array<Record<string, unknown>> = [];
    try {
      embeds = await snapshotTaskEmbeds(this.artifacts, operator, source);
    } catch {
      /* keep empty embeds */
    }
    return {
      version,
      hash,
      display_path: displayPathFor({
        orgId: String(agent.org_id),
        level: "agent",
        ownerId: String(agent.id),
        kind: "task",
        path: "",
        key: "task.md",
      }),
      embeds,
      has_embeds: collectTaskEmbeds(source).length > 0,
    };
  }

  async _connector_state(agent: Record<string, unknown>): Promise<Record<string, unknown>> {
    return "state" in this.mcp ? this.mcp.state(this.db, agent) : {};
  }

  async _run_state(
    agent: Record<string, unknown>,
    members: Array<Record<string, unknown>>,
    historyRows: Array<Record<string, unknown>>,
    secrets: Array<Record<string, unknown>> | null,
    maxToolCalls: number,
    grants: ArtifactGrants = DEFAULT_ARTIFACT_GRANTS,
    connectors: Record<string, unknown> = {},
    scripts: unknown[] = [],
    repositories: Array<Record<string, string>> | null = null,
  ): Promise<Record<string, unknown>> {
    const machineId = String(agent.machine_id);
    prepareWorkspace(await this.workspaceRootFor(machineId), machineId, String(agent.id), {
      browser: Boolean(asObj(agent.config).browser),
    });
    const levels = catalogLevels(grants);
    let collections: unknown[] = [];
    if (this.artifacts && typeof agent.org_id === "string" && agent.org_id) {
      const actor = agentActor({
        orgId: String(agent.org_id),
        guildId: String(agent.guild_id),
        agentId: String(agent.id),
        agentName: String(agent.name),
        grants,
      });
      try {
        collections = await this.artifacts.catalog(actor);
      } catch (error) {
        if (error instanceof ArtifactError) {
          collections = [];
        } else {
          throw error;
        }
      }
    }
    try {
      return collectRunState(
        this.artifacts ? null : (this.notes as DirectoryNotes),
        String(agent.org_slug),
        String(agent.guild_name),
        String(agent.name),
        {
          members,
          operators: guildOperators({ operators: agent.guild_operators }),
          historyRows,
          guildAbout: String(agent.guild_about || ""),
          guildDescription: String(agent.guild_description || ""),
          collections,
          secrets,
          scripts,
          maxToolCalls,
          readableLevels: levels.readable,
          writableLevels: levels.writable,
          connectors,
          repositories,
        },
      );
    } catch (error) {
      if (error instanceof NotesError) {
        throw new RunRequestError(422, error.message);
      }
      throw error;
    }
  }

  async _begin(runId: string, agentId: string): Promise<void> {
    const previous = this._begin_mutex;
    let release: (() => void) | undefined;
    this._begin_mutex = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this._busy.has(runId)) {
        throw new ConflictError("generation already in progress");
      }
      if (this._busy_agents.has(agentId)) {
        throw new ConflictError("agent is already generating");
      }
      const agent = this.db.getAgent ? await this.db.getAgent(agentId) : null;
      const orgId = String(agent?.org_id ?? "");
      const machineId = agent?.machine_id === undefined || agent?.machine_id === null ? null : String(agent.machine_id);
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
      if (machineId !== null) {
        this._cancel_idle(machineId);
        this._agent_machine.set(agentId, machineId);
      }
      this._busy.add(runId);
      this._busy_agents.add(agentId);
      this._run_agent.set(runId, agentId);
      this._cancels.set(runId, new CancelEvent());
    } finally {
      release?.();
    }
  }

  _end(runId: string): void {
    this._busy.delete(runId);
    const agentId = this._run_agent.get(runId);
    this._run_agent.delete(runId);
    if (agentId !== undefined) {
      this._busy_agents.delete(agentId);
      this.admission.release("agent", agentId);
      const machineId = this._agent_machine.get(agentId);
      this._agent_machine.delete(agentId);
      if (machineId !== undefined && !this.machineBusy(machineId)) {
        if (this._stale_machines.has(machineId)) {
          void this.machineChanged(machineId);
        } else {
          this._schedule_idle(machineId);
        }
      }
    }
    this._tasks.delete(runId);
    this._cancels.delete(runId);
    this._cancel_tasks.delete(runId);
    this._commands.delete(runId);
    this._notify_lock_release();
  }

  _start(runId: string, agentId: string, generation: number): void {
    void this._begin(runId, agentId).then(
      () => this._spawn(runId, generation),
      (error: unknown) => {
        writeLog(
          "error",
          errorMessage(error),
          {
            run_id: runId,
            agent_id: agentId,
            operation: "generation.begin",
            error_type: errorName(error),
          },
          error,
        );
      },
    );
  }

  async _create_started(
    runId: string,
    agentId: string,
    create: () => Promise<void>,
  ): Promise<void> {
    await this._begin(runId, agentId);
    try {
      await create();
    } catch (error) {
      this._end(runId);
      throw error;
    }
    this._spawn(runId, 1);
  }

  _spawn = (runId: string, generation: number): void => {
    this._tasks.set(
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

  _cancelled(runId: string): boolean {
    const event = this._cancels.get(runId);
    return event !== undefined && event.aborted;
  }

  _track_command(runId: string, sandbox: SandboxHandle, executionId: string | null): void {
    if (executionId) {
      this._commands.set(runId, [sandbox, executionId]);
    } else {
      this._commands.delete(runId);
    }
  }

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
      const server = await this.db.getMcpServer(String(connection.mcp_server_id));
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
    const snapshot = asObj(run?.config_snapshot);
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
      await this._commit_message(runId, payload, metadata);
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
    const harness = harnessOf(asObj(run.config_snapshot));
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
  ): Promise<{ agent: Record<string, unknown>; sandbox: SandboxHandle } | null> {
    const agent = await this.db.getAgent(agentId);
    if (!agent?.machine_id) {
      return null;
    }
    const sandbox = await this.sandboxes.connectRunning(String(agent.machine_id));
    return sandbox === null ? null : { agent, sandbox };
  }

  async _commit_message(
    runId: string,
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const seq = await this.db.nextSeq(runId);
    const row = await this.db.insertMessage(runId, seq, payload, metadata, new Date());
    await this.publish(runId, "message.committed", messageItem(row));
    return row;
  }

  async _modelMessages(
    runId: string,
    agent: Record<string, unknown>,
    options: {
      generation: number;
      snapshot: Record<string, unknown>;
      tools: unknown[];
    },
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    payloads: Array<Record<string, unknown>>;
  }> {
    const listed = await this.db.listMessages(runId);
    const maxInput = positiveInt(options.snapshot.max_input_tokens, DEFAULT_MAX_INPUT_TOKENS);
    const projectedPayloads = projectToolResults({
      history: listed,
      currentGeneration: options.generation,
      keepGenerations: keepToolResultGenerationsOf(options.snapshot),
      hint: AGENT_TOOL_RESULT_STUB_HINT,
      minUnstubbed: MIN_UNSTUBBED_TOOL_RESULTS,
      minStubBytes: TOOL_RESULT_STUB_MIN_BYTES,
      budget: {
        model: String(options.snapshot.model ?? ""),
        schemas: options.tools,
        maxInput,
        countInputTokens: (model, messages, tools) =>
          countInputTokensImpl(model, messages, tools) +
          attachmentImageCount(listed) * IMAGE_INPUT_TOKENS,
      },
    });
    const rows = listed.map((row, index) => {
      const projected = projectedPayloads[index];
      return projected === undefined || projected === row.payload ? row : { ...row, payload: projected };
    });
    if (!this.attachments) {
      return { rows, payloads: projectedPayloads };
    }
    const model = asObj(agent.config).model;
    return {
      rows,
      payloads: await this.attachments.projectMessages(
        String(agent.org_id ?? ""),
        rows,
        typeof model === "string" ? model : "",
      ),
    };
  }

  async _llm_completion(
    runId: string,
    options: {
      model: string;
      messages: Array<Record<string, unknown>>;
      temperature: number;
      max_tokens: number;
      tools: unknown[] | null;
      thinking_level?: string;
    },
  ): Promise<Completion> {
    const cancelEvent = this._cancels.get(runId);
    const abort = new AbortController();
    const agentId = this._run_agent.get(runId);
    const orgId = agentId ? this.admission.orgId("agent", agentId) : undefined;
    if (orgId) {
      const { blocked } = await this.policy.standing(orgId);
      if (blocked) {
        throw new RunLimitError("generation.subscription", blocked.message);
      }
    }
    const credentials = await this._model_credentials(orgId ?? "", options.model);
    void modelCatalog.ensureFresh();
    const agen = streamCompletionImpl({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      tools: options.tools,
      signal: abort.signal,
      apiKey: credentials.apiKey,
      ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}),
      ...(options.thinking_level ? { thinking_level: options.thinking_level } : {}),
    });
    const iterator = agen[Symbol.asyncIterator]();
    let completion: Completion | null = null;
    const closeIterator = async () => {
      abort.abort();
      try {
        await iterator.return?.(undefined);
      } catch {
        // Python ignores RuntimeError on aclose.
      }
    };
    try {
      while (true) {
        const nextPromise = iterator.next();
        let result: IteratorResult<ModelEvent>;
        if (cancelEvent) {
          const waitAbort = new AbortController();
          try {
            const winner = await Promise.race([
              nextPromise.then((value) => ({ cancelled: false as const, value })),
              cancelEvent.wait(waitAbort.signal).then(
                () => ({ cancelled: true as const }),
                () => ({ cancelled: false as const, aborted: true as const, value: undefined }),
              ),
            ]);
            if (winner.cancelled) {
              abort.abort();
              void nextPromise.catch(() => undefined);
              await closeIterator();
              throw new GenerationCancelled();
            }
            if ("aborted" in winner && winner.aborted) {
              result = await nextPromise;
            } else {
              result = winner.value as IteratorResult<ModelEvent>;
            }
          } finally {
            waitAbort.abort();
          }
        } else {
          result = await nextPromise;
        }
        if (result.done) {
          break;
        }
        const [kind, value] = result.value;
        if (kind === "delta") {
          await this.publish(runId, "assistant.delta", { text: value });
        } else if (kind === "reasoning") {
          await this.publish(runId, "assistant.reasoning.delta", { text: value });
        } else {
          completion = value;
        }
      }
    } finally {
      try {
        await closeIterator();
      } catch {
        // Python ignores RuntimeError on aclose.
      }
    }
    if (completion === null) {
      throw new LLMError("empty completion");
    }
    await reportModelUsage(credentials, modelUsageOf(runId, options.model, completion.metadata));
    return completion;
  }

  /** The credentials the run calls the model with; a provider that is not connected ends the run. */
  async _model_credentials(orgId: string, model: string): Promise<ModelCredentials> {
    try {
      return await resolveModelCredentials(this.credentials, orgId, model);
    } catch (error) {
      if (error instanceof ModelNotConnectedError) {
        throw new RunLimitError("generation.model_key", error.message);
      }
      if (error instanceof PolicyError) {
        throw new RunLimitError("generation.model_credentials", error.message);
      }
      throw error;
    }
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
    let task = this._cancel_tasks.get(runId);
    if (task === undefined) {
      task = this._on_cancel(runId, generation, extra);
      this._cancel_tasks.set(runId, task);
    }
    try {
      await task;
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
      await this.publish(runId, "generation.started", { generation });
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
        await this.publish(runId, "generation.finished", { generation });
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
          this._end(runId);
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
    const agentId = this._run_agent.get(fromRunId);
    this._busy.delete(fromRunId);
    this._run_agent.delete(fromRunId);
    this._cancels.delete(fromRunId);
    this._cancel_tasks.delete(fromRunId);
    this._commands.delete(fromRunId);
    this._tasks.delete(fromRunId);
    this._busy.add(toRunId);
    if (agentId !== undefined) {
      this._run_agent.set(toRunId, agentId);
    }
    this._cancels.set(toRunId, new CancelEvent());
    await this.publish(fromRunId, "run.continued", { run_id: toRunId });
    const task = this._generate(toRunId, 1);
    this._tasks.set(toRunId, task);
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
    run: Record<string, unknown>,
    agent: Record<string, unknown>,
    extra: Record<string, string>,
  ): Promise<void> {
    const machine = agentMachine(agent);
    const seat = agentSeat(agent);
    const snapshot = asObj(run.config_snapshot);
    if (snapshot.coding === true && harnessOf(snapshot) === null) {
      const missing = harnessMissingError();
      await this._fail(runId, generation, missing.code, missing, extra);
      return;
    }
    if (snapshot.coding === true && !(await this._guild_repositories(agent)).length) {
      await this._fail(runId, generation, REPOSITORIES_MISSING, new Error(REPOSITORIES_MISSING_MESSAGE), extra);
      return;
    }
    try {
      const workspaceRoot = await this.workspaceRootFor(machine.id);
      if (this.sandboxes.machineHost) {
        const host = await this.sandboxes.machineHost(machine.id);
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
      // While another agent on the machine generates, its container stays as it is, even when
      // the machine was resized: the new size comes once the last generation on it ends.
      const shared = this.machineBusy(machine.id, seat.agentId)
        ? await this.sandboxes.connectRunning(machine.id)
        : null;
      if (shared !== null) {
        machineSandbox = shared;
      } else {
        machineSandbox = await this.sandboxes.ensure(machine);
        this._stale_machines.delete(machine.id);
      }
      this._report_harnesses(machine.id);
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
      orgId: typeof agent.org_id === "string" && agent.org_id ? String(agent.org_id) : null,
      guildId: String(agent.guild_id),
      agentId: String(agent.id),
    };
    const rows = await this.db.listBindingsCovering(scope);
    const liveConfig = asObj(agent.config);
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
    let grants = DEFAULT_ARTIFACT_GRANTS;
    if (this.artifacts && scope.orgId) {
      grants = grantsFromBindings(rows, scope);
    }
    const ctx = createToolContext({
      run_id: runId,
      agent_id: String(agent.id),
      guild_id: String(agent.guild_id),
      sandbox,
      secrets,
      notes: this.notes as NotesStore,
      artifacts: this.artifacts,
      artifact_actor:
        typeof agent.org_id === "string" && agent.org_id
          ? agentActor({
              orgId: String(agent.org_id),
              guildId: String(agent.guild_id),
              agentId: String(agent.id),
              agentName: String(agent.name),
              grants,
              runId,
            })
          : null,
      guild_name: String(agent.guild_name),
      agent_name: String(agent.name),
      org_slug: String(agent.org_slug),
      cancel_event: this._cancels.get(runId) ?? null,
      track_command: (executionId) => this._track_command(runId, sandbox, executionId),
      agent_home: agentHome(seat.agentId),
      cdp_port: snapshot.browser ? slotPorts(seat.slot).cdp : null,
      ensure_browser: snapshot.browser
        ? async () => {
            if (this._browser_idle.has(seat.agentId)) {
              this._schedule_browser_idle(seat.agentId);
              return;
            }
            await this.startAgentBrowser(agent, machineSandbox);
          }
        : null,
      group_chat: this.group_chat,
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
        await this.publish(runId, "tool.progress", {
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
      if (!this._cancelled(runId)) {
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

  async _effective_github_connection(agent: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const lookup = this.db.getMcpConnectionForOwner?.bind(this.db);
    if (!lookup) {
      return null;
    }
    const connected = async (scope: string, ownerId: unknown) => {
      if (typeof ownerId !== "string" || !ownerId) {
        return null;
      }
      const row = await lookup(GITHUB_SERVER_ID, scope, ownerId);
      return row !== null && row.status === "connected" ? row : null;
    };
    return (
      (await connected("agent", agent.id)) ??
      (await connected("guild", agent.guild_id)) ??
      (await connected("org", agent.org_id)) ??
      null
    );
  }

  async _guild_repositories(agent: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const guildRepos = (await this.db.listGuildRepositories?.(String(agent.guild_id))) ?? [];
    return codingRepositories(guildRepos, await this._effective_github_connection(agent));
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
    agent: Record<string, unknown>,
    sandbox: SandboxHandle,
    ctx: ReturnType<typeof createToolContext>,
    secrets: Record<string, string>,
    extra: Record<string, string>,
  ): Promise<boolean> {
    const repositories = await this._guild_repositories(agent);
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
  async _record_checkpoints(runId: string, agent: Record<string, unknown>, sandbox: SandboxHandle): Promise<void> {
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
    run: Record<string, unknown>,
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
      const { rows, payloads } = await this._modelMessages(runId, agent ?? { org_id: "" }, {
        generation,
        snapshot,
        tools: Array.isArray(tools) ? tools : [],
      });
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
      const completion = await this._llm_completion(runId, {
        model: String(snapshot.model),
        messages: payloads,
        temperature: Number(snapshot.temperature),
        max_tokens: Number(snapshot.max_tokens),
        tools: (tools as unknown[]).length ? (tools as unknown[]) : null,
        ...(snapshot.thinking_level ? { thinking_level: String(snapshot.thinking_level) } : {}),
      });
      await this._commit_message(runId, completion.payload, { generation, ...completion.metadata });
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
      if (this._cancelled(runId)) {
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
    run: Record<string, unknown>,
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
    await this._commit_message(
      runId,
      { role: "user", content: HANDOFF_REQUEST },
      { generation, source: "handoff" },
    );
    const agent = await this.db.getAgent(String(run.agent_id));
    const { rows, payloads } = await this._modelMessages(runId, agent ?? { org_id: "" }, {
      generation,
      snapshot,
      tools: Array.isArray(tools) ? tools : [],
    });
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
      completion = await this._llm_completion(runId, {
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
    await this._commit_message(runId, completion.payload, { generation, ...completion.metadata });
    // Tool schemas stay fixed for the run, so the model may still call one: each call gets a
    // refusal, which keeps the history valid, and is not run.
    const maxToolCalls = positiveInt(snapshot.max_tool_calls, DEFAULT_MAX_TOOL_CALLS);
    let executed = executedToolCalls(await this.db.listMessages(runId));
    for (const call of toolCallsOf(completion.payload)) {
      const fn = asObj(call.function);
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
      await this._commit_message(runId, payload, { generation, ...metadata });
    }
    let next: string;
    try {
      next = await this._create_continuation(run, handoffText(completion.payload), position);
    } catch (error) {
      await this._fail(runId, generation, "generation.continue", error, extra);
      return;
    }
    await this.db.mergeRunMetadata(runId, { continued_by_run_id: next }, new Date());
    await this.db.completeRun(runId, new Date());
    this._continuations.set(runId, next);
  }

  /**
   * The next run of a chain: same agent and kind, a freshly composed prompt, and one user
   * message carrying the hand-off. A group continuation keeps the delivery's snapshot, a
   * schedule continuation its routine.
   */
  async _create_continuation(
    previous: Record<string, unknown>,
    handoff: string,
    position: { root_run_id: string; index: number },
  ): Promise<string> {
    const agentId = String(previous.agent_id);
    const kind = runKind(previous);
    const throughSeq =
      previous.group_chat_through_seq === null || previous.group_chat_through_seq === undefined
        ? null
        : Number(previous.group_chat_through_seq);
    const prepared = await this._prepare_run(agentId, kind === "group" ? { throughSeq } : {});
    const runId = newId("r");
    const now = new Date();
    const hashes = prepared.hashes;
    const opening = continuationMessage(String(previous.id), handoff);
    const runMetadata: Record<string, unknown> = {
      ...(preparedRunMetadata(prepared) ?? {}),
      chain: { root_run_id: position.root_run_id, index: position.index + 1, previous_run_id: String(previous.id) },
    };
    const options = {
      systemPromptHash: hashes.system,
      taskPromptHash: hashes.task,
      memoryPromptHash: hashes.memory,
      runMetadata,
    };
    if (kind === "group") {
      await this.db.createGroupRun(runId, agentId, prepared.snapshot({ schedules: true }), prepared.system, prepared.task, [opening], Number(throughSeq ?? 0), now, options);
    } else if (kind === "schedule") {
      const instruction = asObj(previous.metadata).instruction_hash;
      await this.db.createScheduleRun(runId, agentId, prepared.snapshot(), prepared.system, prepared.task, [opening], now, {
        ...options,
        runMetadata: { ...runMetadata, ...(typeof instruction === "string" ? { instruction_hash: instruction } : {}) },
        scheduleId: typeof previous.schedule_id === "string" ? previous.schedule_id : null,
      });
    } else {
      await this.db.createRun(runId, agentId, prepared.snapshot({ schedules: true, direct: true }), prepared.system, prepared.task, null, now, {
        ...options,
        extraMessages: [opening],
      });
    }
    return runId;
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
      .filter((row) => asObj(row.payload).role === "tool")
      .map((row) => ({ seq: Number(row.seq), metadata: asObj(row.metadata) }));
    for (const call of calls) {
      if (this._cancelled(runId)) {
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
          await this.agentWorkspace(owner),
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
      const row = await this._commit_message(runId, payload, { generation, ...metadata });
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
    agent: Record<string, unknown>,
    sandbox: SandboxHandle,
    extra: Record<string, string>,
  ): Promise<boolean> {
    const ctx = this._maintenance_ctx(runId, agent, sandbox);
    const checks = [
      {
        limit: agentWorkspaceMaxMib(asObj(agent.config)),
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
  async _record_workspace_size(runId: string, agent: Record<string, unknown>, sandbox: SandboxHandle): Promise<void> {
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
    agent: Record<string, unknown>,
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
        const meta = asObj(row.metadata);
        const payload = asObj(row.payload);
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
        const meta = asObj(row.metadata);
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
    const fields = extra ?? { run_id: runId };
    writeLog(
      "error",
      errorMessage(error),
      {
        run_id: fields.run_id ?? runId,
        agent_id: fields.agent_id ?? null,
        guild_id: fields.guild_id ?? null,
        operation,
        error_type: errorName(error),
      },
      error,
    );
    const now = new Date();
    const entry = {
      at: now.toISOString(),
      generation,
      operation,
      error_type: errorName(error),
      message: redactText(errorMessage(error)),
    };
    await this.db.appendRunError(runId, entry, now);
    await this.publish(runId, "run.error", entry);
  }

  private async _scheduler_loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await sleep(this._scheduler_tick_ms, signal);
      if (signal.aborted) {
        return;
      }
      try {
        await this.fireDueSchedules();
      } catch (error) {
        writeLog(
          "error",
          "schedule tick failed",
          { operation: "schedule.tick", error_type: errorName(error) },
          error,
        );
      }
    }
  }

  /**
   * `secret_store` for one agent: reads the value file from its workspace, saves the
   * secret granted to it, removes the file, and refreshes environments the change reaches.
   */
  private agentSecretStore(agent: Record<string, unknown>): AgentSecretStore {
    const agentId = String(agent.id);
    return {
      store: async (input) => {
        const file = await readSecretFile(await this.agentWorkspace(agent), input.file);
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

  /** The agent's home on the host: its folder in its machine's directory. */
  private async agentWorkspace(agent: Record<string, unknown> | null): Promise<string> {
    if (agent === null) {
      throw new Error("agent not found");
    }
    const machineId = String(agent.machine_id);
    return agentDirectory(await this.workspaceRootFor(machineId), machineId, String(agent.id));
  }

  /** Where the machine's directory is kept: its host's workspace root, or core's one root. */
  private async workspaceRootFor(machineId: string): Promise<string> {
    if (!this.sandboxes.machineHost) {
      return this.workspace_root;
    }
    const host = await this.sandboxes.machineHost(machineId);
    if (!host) {
      return this.workspace_root;
    }
    return host.workspaceRoot;
  }
}
