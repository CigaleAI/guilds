import { mkdirSync } from "node:fs";
import path from "node:path";
import { PLATFORM_SEED_TOOLS } from "../../src/access/runtime.js";
import type { ArtifactActor } from "../../src/artifacts/index.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { secretPayload } from "../../src/credentials/validate.js";
import {
  GenerationLoop,
  type GenerationDatabase,
  type GenerationNotes,
  type GenerationSandboxes,
} from "../../src/generation/index.js";
import type { Completion } from "../../src/llm/index.js";
import { NotesStore } from "../../src/notes/store.js";
import { SandboxError, type AgentSeat, type MachineSpec } from "../../src/sandbox/index.js";
import { HEX_MASTER_KEY, tempDir } from "./env.js";
import { templatesRoot } from "./fixtures.js";
import { TEST_CREDENTIALS } from "./models.js";
import type { PlannedWake } from "../../src/schedules/window.js";
import type { AgentScriptRow, NewAgentScript } from "../../src/db/agents.js";
import type { ScriptDatabase } from "../../src/scripts/catalog.js";
import type { NewDirectRun, NewGroupRun, NewMessage, NewScheduleRun } from "../../src/db/runs.js";
import type { ScheduleRow } from "../../src/db/schedules.js";

export const AGENT_CONFIG = {
  model: "openrouter/openai/gpt-5.6-luna",
  temperature: 0,
  max_tokens: 32,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
};

export function scheduleRow(
  overrides: Partial<Omit<ScheduleRow, "cron" | "wake_window">> = {},
): ScheduleRow {
  return {
    id: "sch_1",
    agent_id: "a_1",
    cron: "*/30 * * * *",
    wake_window: null,
    window_fires: 0,
    description: "",
    instruction: "ping",
    paused: false,
    next_run_at: "2026-10-12T09:30:00.000Z",
    last_run_at: null,
    created_at: "2026-10-12T09:00:00.000Z",
    updated_at: "2026-10-12T09:00:00.000Z",
    ...overrides,
  };
}

/** Agent scripts in memory, with the actor of every write. */
export class MemoryScriptDB implements ScriptDatabase {
  rows: AgentScriptRow[] = [];
  actors: ArtifactActor[] = [];

  async listAgentScripts(agentId: string): Promise<AgentScriptRow[]> {
    return this.rows.filter((row) => row.agent_id === agentId);
  }

  async upsertAgentScript(
    script: NewAgentScript,
    actor: ArtifactActor,
    now: Date,
  ): Promise<AgentScriptRow> {
    const { scriptId, agentId, name, description, parameters, source, sourceHash } = script;
    this.actors.push(actor);
    const stamp = now.toISOString();
    const index = this.rows.findIndex((row) => row.agent_id === agentId && row.name === name);
    const existing = this.rows[index];
    if (existing) {
      const updated = {
        ...existing,
        description,
        parameters,
        source,
        source_hash: sourceHash,
        updated_at: stamp,
      };
      this.rows[index] = updated;
      return updated;
    }
    const row = {
      id: scriptId,
      agent_id: agentId,
      name,
      description,
      parameters,
      source,
      source_hash: sourceHash,
      created_at: stamp,
      updated_at: stamp,
    };
    this.rows.push(row);
    return row;
  }

  async getAgentScript(agentId: string, name: string): Promise<AgentScriptRow | null> {
    return this.rows.find((row) => row.agent_id === agentId && row.name === name) ?? null;
  }

  async deleteAgentScript(
    _actor: ArtifactActor,
    agentId: string,
    name: string,
  ): Promise<AgentScriptRow | null> {
    const index = this.rows.findIndex((row) => row.agent_id === agentId && row.name === name);
    if (index < 0) {
      return null;
    }
    return this.rows.splice(index, 1)[0] ?? null;
  }
}

function attachScripts<T extends object>(target: T, scripts: MemoryScriptDB): T & MemoryScriptDB {
  const bound = target as T & MemoryScriptDB;
  bound.rows = scripts.rows;
  bound.listAgentScripts = scripts.listAgentScripts.bind(scripts);
  bound.upsertAgentScript = scripts.upsertAgentScript.bind(scripts);
  bound.getAgentScript = scripts.getAgentScript.bind(scripts);
  bound.deleteAgentScript = scripts.deleteAgentScript.bind(scripts);
  return bound;
}

export class FakeCommands {
  commands: string[] = [];
  /** The options of each command, in order: its working directory and environment. */
  options: Array<Record<string, unknown>> = [];

  async run(command: string, opts?: unknown, _handlers?: unknown) {
    this.commands.push(command);
    this.options.push((opts ?? {}) as Record<string, unknown>);
    return {
      exit_code: 0,
      logs: { stdout: [{ text: `ok:${command}` }], stderr: [] },
    };
  }
}

/** The machine fields of an agent row on its organisation's default machine. */
export const AGENT_MACHINE = {
  machine_id: "mach_1",
  machine_slot: 0,
  machine_name: "default",
  machine_box: "standard",
  machine_cpu: null,
  machine_memory_mib: null,
  machine_max_workspace_mib: 10240,
  machine_workspace_mib: null,
};

/** A sandbox provider that records what generation asks of its machines, and runs nothing. */
export class FakeSandboxes {
  commands: {
    commands?: string[];
    run: (command: string, opts?: unknown, handlers?: unknown) => Promise<unknown>;
    interrupt?: (executionId: string) => Promise<void>;
  } = new FakeCommands();
  /** Machines ensured, in order. */
  created: MachineSpec[] = [];
  /** Machines whose containers went. */
  destroyed: string[] = [];
  running = new Set<string>();
  /** Agents whose Chrome started, in order. */
  browser_starts: string[] = [];
  /** Agents whose processes stopped, with what stopped. */
  stopped: Array<{ agentId: string; what: "browser" | "all" | "purge" }> = [];
  browser_failure: string | null = null;

  async ensure(machine: MachineSpec) {
    this.created.push(machine);
    this.running.add(machine.id);
    return { id: "sbx_fake", commands: this.commands };
  }

  async connectRunning(machineId: string) {
    return this.running.has(machineId) ? { id: "sbx_fake", commands: this.commands } : null;
  }

  async startBrowser(_sandbox: unknown, seat: AgentSeat): Promise<void> {
    if (this.browser_failure !== null) {
      throw new SandboxError(this.browser_failure);
    }
    this.browser_starts.push(seat.agentId);
  }

  async stopBrowser(_sandbox: unknown, seat: AgentSeat): Promise<void> {
    this.stopped.push({ agentId: seat.agentId, what: "browser" });
  }

  async stopAgent(_sandbox: unknown, seat: AgentSeat, options: { purge?: boolean } = {}): Promise<void> {
    this.stopped.push({ agentId: seat.agentId, what: options.purge ? "purge" : "all" });
  }

  async novncTarget(_sandbox: unknown, _seat: AgentSeat): Promise<[string, Record<string, string>]> {
    return ["http://novnc.test", { "OPEN-SANDBOX-API-KEY": "k" }];
  }

  cli_starts = 0;
  cli_token = "a".repeat(48);
  cli_failure: string | null = null;

  async startCli(_sandbox: unknown, _seat: AgentSeat): Promise<string> {
    this.cli_starts += 1;
    if (this.cli_failure !== null) {
      throw new SandboxError(this.cli_failure);
    }
    return this.cli_token;
  }

  async cliTarget(_sandbox: unknown, _seat: AgentSeat, token: string): Promise<[string, Record<string, string>]> {
    return [`http://cli.test/t/${token}`, { "OPEN-SANDBOX-API-KEY": "k" }];
  }

  async listRunningMachineIds(): Promise<Set<string>> {
    return new Set(this.running);
  }

  async destroy(machineId: string): Promise<void> {
    this.destroyed.push(machineId);
    this.running.delete(machineId);
  }
}

export class FakeDB {
  run: Record<string, unknown>;
  agent: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  llm_histories: Array<Array<Record<string, unknown>>> = [];
  active_secret_agent_ids: string[] = [];
  bindings: Array<Record<string, unknown>> = [];
  secrets: Array<Record<string, unknown>> = [];
  mcp_connection: Record<string, unknown> | null = null;
  mcp_server: Record<string, unknown> | null = null;
  monthlyUsage: Record<string, unknown> | null = null;
  due_schedules: ScheduleRow[] = [];
  fired: Array<Record<string, unknown>> = [];

  constructor(snapshot: Record<string, unknown>) {
    const now = new Date();
    this.run = {
      id: "r_1",
      agent_id: "a_1",
      status: "active",
      config_snapshot: snapshot,
      errors: [],
      created_at: now,
      updated_at: now,
      metadata: {},
    };
    this.agent = {
      id: "a_1",
      guild_id: "guild_1",
      name: "researcher",
      guild_name: "research",
      org_id: "org_1",
      org_slug: "acme",
      config: {},
      ...AGENT_MACHINE,
    };
    this.messages = [
      {
        id: 1,
        seq: 0,
        payload: { role: "system", content: "sys" },
        metadata: { generation: 1 },
        created_at: now,
      },
      {
        id: 2,
        seq: 1,
        payload: { role: "user", content: "use bash twice" },
        metadata: { generation: 1, source: "ui" },
        created_at: now,
      },
    ];
    attachScripts(this, new MemoryScriptDB());
  }

  async getRun(runId: string) {
    return this.run.id === runId ? this.run : null;
  }

  async getAgent(agentId: string) {
    return this.agent.id === agentId ? this.agent : null;
  }

  async getOrgMonthlyUsage(_orgId: string, _month: string) {
    return this.monthlyUsage;
  }

  async getGuild(guildId: string) {
    return guildId === "guild_1" ? { id: "guild_1", name: "research", org_slug: "acme" } : null;
  }

  async listBindingsCovering(_options?: unknown) {
    return this.bindings;
  }

  async listAgentSecrets(options: { guildId: string; agentId: string }) {
    return this.secrets.filter((secret) => secretReaches(secret, options));
  }

  async getSecret(secretId: string) {
    return this.secrets.find((item) => item.id === secretId) ?? null;
  }

  async listRuns(agentId: string) {
    return this.run.agent_id === agentId ? [this.run] : [];
  }

  async updateRunSecrets(runId: string, secrets: Array<Record<string, string>>, now: Date) {
    if (this.run.id !== runId) {
      return;
    }
    const snapshot = { ...(this.run.config_snapshot as Record<string, unknown>), secrets };
    this.run.config_snapshot = snapshot;
    this.run.updated_at = now;
  }

  async updateRunScripts(runId: string, scripts: unknown[], now: Date) {
    if (this.run.id !== runId) {
      return;
    }
    const snapshot = { ...(this.run.config_snapshot as Record<string, unknown>), scripts };
    this.run.config_snapshot = snapshot;
    this.run.updated_at = now;
  }

  async listAgents(guildId: string) {
    return this.agent.guild_id === guildId ? [this.agent] : [];
  }

  async listGuilds(_orgId?: string | null) {
    return [];
  }

  async listAllAgents() {
    return [this.agent];
  }

  async listMcpServers() {
    return [];
  }

  async listMcpConnections(_options?: unknown) {
    return [];
  }

  async listMcpTools(_connectionId: string) {
    return [];
  }

  async getMcpConnection(_connectionId: string) {
    return this.mcp_connection;
  }

  async getMcpServer(_serverId: string) {
    return this.mcp_server;
  }

  async listPayloads(_runId: string) {
    return this.messages.map((row) => row.payload as Record<string, unknown>);
  }

  async listMessages(_runId: string) {
    return this.messages;
  }

  async listActiveRuns() {
    return [this.run];
  }

  async nextSeq(_runId: string) {
    return Math.max(...this.messages.map((row) => Number(row.seq))) + 1;
  }

  async nextGeneration(_runId: string) {
    const gens = this.messages
      .map((row) => (row.metadata as Record<string, unknown>).generation)
      .filter((value): value is number => typeof value === "number");
    return (gens.length ? Math.max(...gens) : 0) + 1;
  }

  async insertMessage(input: NewMessage, now: Date) {
    const row = {
      id: this.messages.length + 1,
      run_id: input.runId,
      seq: input.seq,
      payload: input.payload,
      metadata: input.metadata,
      created_at: now,
    };
    this.messages.push(row);
    return row;
  }

  async appendRunError(_runId: string, entry: Record<string, unknown>, now: Date) {
    this.run.errors = [...((this.run.errors as unknown[]) ?? []), entry];
    this.run.updated_at = now;
    return this.run.errors as unknown[];
  }

  async listActiveRunAgentIdsForSecret(_secretId: string) {
    return this.active_secret_agent_ids;
  }

  async mergeRunMetadata(runId: string, extra: Record<string, unknown>, now: Date) {
    if (this.run.id !== runId) {
      return;
    }
    const current = { ...((this.run.metadata as Record<string, unknown>) ?? {}), ...extra };
    this.run.metadata = current;
    this.run.updated_at = now;
  }

  async completeRun(runId: string, now: Date) {
    if (this.run.id === runId) {
      this.run.status = "completed";
      this.run.updated_at = now;
    }
  }

  async reopenRun(runId: string, now: Date) {
    if (this.run.id !== runId || this.run.status !== "completed") {
      return;
    }
    this.run.status = "active";
    const current = { ...((this.run.metadata as Record<string, unknown>) ?? {}) };
    current.resumed_at = now.toISOString();
    this.run.metadata = current;
    this.run.updated_at = now;
  }

  async completeGroupDelivery(_runId: string, _agentId: string, _throughSeq: number, _now: Date) {
    return undefined;
  }

  async listGroupMessages(_guildId: string, _options?: { throughSeq?: number | null }) {
    return [];
  }

  async listDueSchedules(_now: Date) {
    return [...this.due_schedules];
  }

  async markScheduleFired(scheduleId: string, now: Date, wake: PlannedWake) {
    this.fired.push({ id: scheduleId, now, next_run_at: wake.at, window_fires: wake.windowFires });
  }

  async deleteAgent(_agentId: string) {
    return undefined;
  }

  async deleteGuild(_guildId: string) {
    return undefined;
  }

  async createRun(): Promise<void> {
    return undefined;
  }

  async createGroupRun(): Promise<void> {
    return undefined;
  }

  async createScheduleRun(): Promise<void> {
    return undefined;
  }
}

export class RecordingDB {
  agent: Record<string, unknown>;
  run: Record<string, unknown> | null = null;
  create_args: Record<string, unknown> | null = null;
  messages: Array<Record<string, unknown>> = [];
  group_messages: Array<Record<string, unknown>> = [];
  bindings: Array<Record<string, unknown>> = [];
  secrets: Array<Record<string, unknown>> = [];
  due_schedules: ScheduleRow[] = [];
  fired: Array<Record<string, unknown>> = [];
  delivered: string | undefined;
  mcp_connection: Record<string, unknown> | null = null;
  mcp_server: Record<string, unknown> | null = null;

  constructor(agent: Record<string, unknown>) {
    this.agent = agent;
    attachScripts(this, new MemoryScriptDB());
  }

  async getAgent(agentId: string) {
    return agentId === this.agent.id ? this.agent : null;
  }

  async listAgents(guildId: string) {
    return guildId === this.agent.guild_id ? [this.agent] : [];
  }

  async listGroupMessages(guildId: string, options: { throughSeq?: number | null } = {}) {
    let rows = this.group_messages.filter((row) => (row.guild_id ?? guildId) === guildId);
    if (options.throughSeq !== undefined && options.throughSeq !== null) {
      rows = rows.filter((row) => Number(row.seq) <= options.throughSeq!);
    }
    return rows;
  }

  async listBindingsCovering(_options?: unknown) {
    return [
      ...PLATFORM_SEED_TOOLS.map((name) => ({
        id: `bind_${name}`,
        catalog_kind: "native_tool",
        catalog_id: name,
        scope: "platform",
        scope_id: null,
        enabled: true,
        connection_id: null,
      })),
      ...this.bindings,
    ];
  }

  async listAgentSecrets(options: { guildId: string; agentId: string }) {
    return this.secrets.filter((secret) => secretReaches(secret, options));
  }

  async getSecret(secretId: string) {
    return this.secrets.find((item) => item.id === secretId) ?? null;
  }

  async listMcpServers() {
    return [];
  }

  async listMcpConnections(_options?: unknown) {
    return [];
  }

  async listMcpTools(_connectionId: string) {
    return [];
  }

  async getMcpConnection(_connectionId: string) {
    return this.mcp_connection;
  }

  async getMcpServer(_serverId: string) {
    return this.mcp_server;
  }

  async getRun(runId: string) {
    return this.run && this.run.id === runId ? this.run : null;
  }

  async getGuild(guildId: string) {
    return guildId === this.agent.guild_id
      ? { id: this.agent.guild_id, name: this.agent.guild_name, org_slug: this.agent.org_slug }
      : null;
  }

  async listRuns(agentId: string) {
    if (this.run === null || this.run.agent_id !== agentId) {
      return [];
    }
    return [this.run];
  }

  async updateRunSecrets(runId: string, secrets: Array<Record<string, string>>, now: Date) {
    if (this.run === null || this.run.id !== runId) {
      return;
    }
    const snapshot = { ...(this.run.config_snapshot as Record<string, unknown>), secrets };
    this.run.config_snapshot = snapshot;
    this.run.updated_at = now;
  }

  async updateRunScripts(runId: string, scripts: unknown[], now: Date) {
    if (this.run === null || this.run.id !== runId) {
      return;
    }
    const snapshot = { ...(this.run.config_snapshot as Record<string, unknown>), scripts };
    this.run.config_snapshot = snapshot;
    this.run.updated_at = now;
  }

  async createRun(input: NewDirectRun, now: Date) {
    const {
      runId,
      agentId,
      configSnapshot,
      systemContent,
      taskContent,
      userContent,
      systemPromptHash,
      taskPromptHash,
      memoryPromptHash,
      extraMessages: rawExtra,
      userMetadata,
    } = input;
    const extraMessages = rawExtra ?? [];
    this.create_args = {
      run_id: runId,
      system_content: systemContent,
      task_content: taskContent,
      user_content: userContent,
      extra_messages: extraMessages,
      user_metadata: userMetadata,
    };
    this.messages = [
      {
        seq: 0,
        payload: { role: "system", content: systemContent },
        metadata: { source: "system" },
        created_at: now,
      },
    ];
    let seq = 1;
    for (const [payload, metadata] of extraMessages) {
      this.messages.push({ seq, payload, metadata, created_at: now });
      seq += 1;
    }
    if (userContent !== null) {
      this.messages.push({
        seq,
        payload: { role: "user", content: userContent },
        metadata: { generation: 1, source: "ui", ...(userMetadata ?? {}) },
        created_at: now,
      });
    }
    this.run = {
      id: runId,
      agent_id: agentId,
      status: "active",
      config_snapshot: configSnapshot,
      errors: [],
      created_at: now,
      updated_at: now,
      system_prompt_hash: systemPromptHash,
      task_prompt_hash: taskPromptHash,
      memory_prompt_hash: memoryPromptHash,
      metadata: {},
    };
  }

  async nextSeq(_runId: string) {
    return Math.max(...this.messages.map((row) => Number(row.seq))) + 1;
  }

  async nextGeneration(_runId: string) {
    const gens = this.messages
      .map((row) => (row.metadata as Record<string, unknown> | undefined)?.generation)
      .filter((value): value is number => typeof value === "number");
    return (gens.length ? Math.max(...gens) : 0) + 1;
  }

  async insertMessage(input: NewMessage, now: Date) {
    const row = {
      id: this.messages.length + 1,
      run_id: input.runId,
      seq: input.seq,
      payload: input.payload,
      metadata: input.metadata,
      created_at: now,
    };
    this.messages.push(row);
    return row;
  }

  async listMessages(_runId: string) {
    return this.messages;
  }

  async listPayloads(_runId: string) {
    return this.messages.map((row) => row.payload as Record<string, unknown>);
  }

  async listActiveRuns() {
    return this.run !== null ? [this.run] : [];
  }

  async appendRunError(_runId: string, entry: Record<string, unknown>, now: Date) {
    if (this.run === null) {
      throw new Error("run missing");
    }
    this.run.errors = [...((this.run.errors as unknown[]) ?? []), entry];
    this.run.updated_at = now;
    return this.run.errors as unknown[];
  }

  async createScheduleRun(input: NewScheduleRun, now: Date) {
    const {
      runId,
      agentId,
      configSnapshot,
      systemContent,
      taskContent,
      projected,
      systemPromptHash,
      taskPromptHash,
      memoryPromptHash,
    } = input;
    this.create_args = {
      run_id: runId,
      system_content: systemContent,
      task_content: taskContent,
      projected,
    };
    this.messages = [
      {
        seq: 0,
        payload: { role: "system", content: systemContent },
        metadata: { source: "system" },
        created_at: now,
      },
    ];
    let seq = 1;
    for (const [payload, metadata] of projected) {
      this.messages.push({ seq, payload, metadata, created_at: now });
      seq += 1;
    }
    this.run = {
      id: runId,
      agent_id: agentId,
      status: "active",
      kind: "schedule",
      config_snapshot: configSnapshot,
      errors: [],
      created_at: now,
      updated_at: now,
      system_prompt_hash: systemPromptHash,
      task_prompt_hash: taskPromptHash,
      memory_prompt_hash: memoryPromptHash,
      metadata: {},
    };
  }

  async createGroupRun(input: NewGroupRun, now: Date) {
    const {
      runId,
      agentId,
      configSnapshot,
      systemContent,
      taskContent,
      projected,
      throughSeq,
      systemPromptHash,
      taskPromptHash,
      memoryPromptHash,
    } = input;
    this.create_args = {
      run_id: runId,
      system_content: systemContent,
      task_content: taskContent,
      projected,
    };
    this.messages = [
      {
        seq: 0,
        payload: { role: "system", content: systemContent },
        metadata: { source: "system" },
        created_at: now,
      },
    ];
    let seq = 1;
    for (const [payload, metadata] of projected) {
      this.messages.push({ seq, payload, metadata, created_at: now });
      seq += 1;
    }
    this.run = {
      id: runId,
      agent_id: agentId,
      status: "active",
      kind: "group",
      group_chat_through_seq: throughSeq,
      config_snapshot: configSnapshot,
      errors: [],
      created_at: now,
      updated_at: now,
      system_prompt_hash: systemPromptHash,
      task_prompt_hash: taskPromptHash,
      memory_prompt_hash: memoryPromptHash,
      metadata: {},
    };
  }

  async listDueSchedules(_now: Date) {
    return [...this.due_schedules];
  }

  async markScheduleFired(scheduleId: string, now: Date, wake: PlannedWake) {
    this.fired.push({ id: scheduleId, now, next_run_at: wake.at, window_fires: wake.windowFires });
  }

  async mergeRunMetadata(runId: string, extra: Record<string, unknown>, now: Date) {
    if (this.run === null || this.run.id !== runId) {
      return;
    }
    const current = { ...((this.run.metadata as Record<string, unknown>) ?? {}), ...extra };
    this.run.metadata = current;
    this.run.updated_at = now;
  }

  async completeRun(runId: string, now: Date) {
    if (this.run !== null && this.run.id === runId) {
      this.run.status = "completed";
      this.run.updated_at = now;
    }
  }

  async reopenRun(runId: string, now: Date) {
    if (this.run === null || this.run.id !== runId || this.run.status !== "completed") {
      return;
    }
    this.run.status = "active";
    const current = { ...((this.run.metadata as Record<string, unknown>) ?? {}) };
    current.resumed_at = now.toISOString();
    this.run.metadata = current;
    this.run.updated_at = now;
  }

  async completeGroupDelivery(runId: string, _agentId: string, _throughSeq: number, now: Date) {
    await this.completeRun(runId, now);
  }

  async listGuilds(_orgId?: string | null) {
    return [];
  }

  async listAllAgents() {
    return [this.agent];
  }

  async listActiveRunAgentIdsForSecret(_secretId: string) {
    return [];
  }

  async deleteAgent(_agentId: string) {
    return undefined;
  }

  async deleteGuild(_guildId: string) {
    return undefined;
  }
}

export function parsedState(system: string): Record<string, unknown> {
  const marker = "\n\nState: ";
  const idx = system.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error("state marker missing");
  }
  let rest = system.slice(idx + marker.length).trimStart();
  const end = rest.indexOf("</state>");
  if (end >= 0) {
    rest = rest.slice(0, end).trimEnd();
  }
  return JSON.parse(rest) as Record<string, unknown>;
}

export function makeLoop(
  db: object,
  notes: object,
  workspaceRoot: string,
  sandboxes: object,
  options: ConstructorParameters<typeof GenerationLoop>[4] = {},
): GenerationLoop {
  return new GenerationLoop(
    db as GenerationDatabase,
    notes as GenerationNotes,
    workspaceRoot,
    sandboxes as GenerationSandboxes,
    { idleTimeoutMs: 0, credentials: TEST_CREDENTIALS, ...options },
  );
}

export async function seededLoop(
  workspaceRoot = path.join(tempDir("guilds-gen-"), "workspaces"),
): Promise<{ loop: GenerationLoop; db: RecordingDB; notes: NotesStore; tmp: string }> {
  const tmp = path.dirname(workspaceRoot);
  const root = path.join(tmp, "notes");
  mkdirSync(root, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const notes = new NotesStore(root, templatesRoot());
  await notes.ensureSystemPrompt();
  await notes.createGuild("acme", "research");
  await notes.createAgent("acme", "research", "researcher");
  const db = new RecordingDB({
    id: "a_1",
    guild_id: "guild_1",
    name: "researcher",
    guild_name: "research",
    org_id: "org_1",
    org_slug: "acme",
    config: { ...AGENT_CONFIG },
    ...AGENT_MACHINE,
  });
  const loop = makeLoop(db, notes, workspaceRoot, new FakeSandboxes());
  return { loop, db, notes, tmp };
}

export function fakeStream(
  db: { llm_histories: Array<Array<Record<string, unknown>>> },
  calls: Array<Record<string, unknown>>,
): (options: { messages: Array<Record<string, unknown>> }) => AsyncGenerator<["done", Completion]> {
  return async function* stream(options: { messages: Array<Record<string, unknown>> }) {
    db.llm_histories.push([...options.messages]);
    const payload =
      db.llm_histories.length === 1
        ? { role: "assistant", content: null, tool_calls: calls }
        : { role: "assistant", content: "done" };
    yield [
      "done",
      {
        payload,
        metadata: {
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
          latency_ms: 1,
          finish_reason: "tool_calls" in payload ? "tool_calls" : "stop",
          model: "test",
          response_id: "c1",
          provider_request_id: null,
          cost_usd: 0.0,
        },
      },
    ];
  };
}

export function completionReply(content = "done"): Completion {
  return {
    payload: { role: "assistant", content },
    metadata: {
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
      latency_ms: 1,
      finish_reason: "stop",
      model: "test",
      response_id: "c1",
      provider_request_id: null,
      cost_usd: 0.0,
    },
  };
}

/** A secret granted to agent a_1 of guild_1. */
export function liveSecret(name = "WALLET_PRIVATE_KEY"): Record<string, unknown> {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const [ciphertext, nonce] = encryptPayload(secretPayload("wallet-secret"));
  return {
    id: "sec_1",
    name,
    description: "signs sends",
    org_wide: false,
    grants: [{ guild_id: null, agent_id: "a_1", name: "researcher", in_guild_id: "guild_1" }],
    ciphertext,
    nonce,
  };
}

/** The runtime rule: organisation-wide, or granted to the agent's guild or the agent. */
export function secretReaches(
  secret: Record<string, unknown>,
  target: { guildId: string; agentId: string },
): boolean {
  if (secret.org_wide) {
    return true;
  }
  const grants = (secret.grants as Array<Record<string, unknown>> | undefined) ?? [];
  return grants.some((grant) => grant.guild_id === target.guildId || grant.agent_id === target.agentId);
}

export function guildDb(agentIds: string[]) {
  const db: {
    purged: string[];
    getGuild: (guildId: string) => Promise<Record<string, unknown> | null>;
    listAgents: (guildId: string) => Promise<Array<Record<string, unknown>>>;
    deleteGuild: (guildId: string) => Promise<void>;
    getAgent?: (agentId: string) => Promise<Record<string, unknown> | null>;
  } = {
    purged: [],
    async getGuild(guildId: string) {
      if (guildId !== "guild_1") {
        return null;
      }
      return { id: "guild_1", name: "research", org_slug: "acme" };
    },
    async listAgents(_guildId: string) {
      return agentIds.map((id) => ({ id }));
    },
    async getAgent(agentId: string) {
      const slot = agentIds.indexOf(agentId);
      return slot < 0 ? null : { id: agentId, ...AGENT_MACHINE, machine_slot: slot };
    },
    async deleteGuild(guildId: string) {
      db.purged.push(guildId);
    },
  };
  return db;
}

export function guildNotes() {
  const notes: {
    deleted: Array<[string, string]>;
    deleteGuild: (orgSlug: string, name: string) => Promise<void>;
    rejected?: { status: number; detail: string } | null;
  } = {
    deleted: [],
    async deleteGuild(orgSlug: string, name: string) {
      notes.deleted.push([orgSlug, name]);
    },
  };
  return notes;
}

export function hangForever(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export function abortableHang(): { promise: Promise<never>; abort: (reason?: Error) => void } {
  let abort!: (reason?: Error) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    abort = (reason) => reject(reason ?? new Error("execution interrupted"));
  });
  return { promise, abort };
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
