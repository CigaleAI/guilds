import { DEFAULT_MAX_SCRIPTS } from "../agents/config.js";
import type { Harness, Effort, ReportedToolMetadata } from "../db/schema/index.js";
import { agentHome } from "../lib/agent-file.js";
import type { ArtifactActor } from "../artifacts/types.js";
import type { ArtifactFiles } from "../artifacts/files.js";
import type { NotesStore } from "../notes/store.js";
import type { Issues } from "../issues/index.js";
import type { Schedules } from "../schedules/service.js";
import type { Scripts } from "../scripts/catalog.js";
import type { RunScriptSnapshot } from "../db/schema/index.js";
import type { ToolArtifacts } from "./artifacts.js";
import type { ToolboxDatabase, ToolEvents } from "./services.js";

export type GroupChat = {
  publish?(guildId: string, event: string, data: Record<string, unknown>): Promise<void>;
  postFromRun?(
    runId: string,
    agentId: string,
    guildId: string,
    agentName: string,
    content: string,
  ): Promise<string>;
  post_from_run?(
    runId: string,
    agentId: string,
    guildId: string,
    agentName: string,
    content: string,
  ): Promise<string>;
};

export class CancelEvent {
  aborted = false;
  private waiters: Array<() => void> = [];

  set(): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.aborted) {
      return Promise.resolve();
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("wait aborted"));
    }
    return new Promise((resolve, reject) => {
      const wrapped = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("wait aborted"));
      };
      const cleanup = () => {
        this.waiters = this.waiters.filter((item) => item !== wrapped);
        signal?.removeEventListener("abort", onAbort);
      };
      this.waiters.push(wrapped);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export type CommandResult = {
  id?: string;
  exit_code?: number | null;
  exitCode?: number | null;
  logs?: {
    stdout?: Array<{ text?: string }>;
    stderr?: Array<{ text?: string }>;
  };
};

export type SandboxCommands = {
  run(
    command: string,
    opts?: Record<string, unknown>,
    handlers?: { onInit?: (init: { id?: string }) => Promise<void> | void; on_init?: (init: { id?: string }) => Promise<void> | void },
  ): Promise<CommandResult>;
  interrupt?(executionId: string): Promise<void>;
};

export type SandboxFiles = {
  writeFiles(entries: Array<{ path: string; data: string }>): Promise<void>;
  moveFiles(entries: Array<{ src: string; dest: string }>): Promise<void>;
  listDirectory?(entry: { path: string; depth?: number }): Promise<Array<{ path: string; type?: string }>>;
  deleteFiles(paths: string[]): Promise<void>;
};

export type SandboxHandle = {
  id?: string;
  commands: SandboxCommands;
  files?: SandboxFiles;
};

/** Saves values the agent produced as secrets of its organisation, granted to the agent. */
export type AgentSecretStore = {
  /** Reads the value from `file`, stores or rotates the secret, and removes the file. */
  store(input: { name: unknown; description: unknown; file: string }): Promise<{
    name: string;
    rotated: boolean;
    value: string;
  }>;
};

export type ToolContext = {
  run_id: string;
  agent_id: string;
  guild_id: string;
  sandbox: SandboxHandle | null;
  secrets: Record<string, string>;
  exit_code: number | null;
  notes: NotesStore | null;
  artifacts: ToolArtifacts | null;
  artifact_actor: ArtifactActor | null;
  /** The shared files, reached with `artifact_actor`. */
  files: ArtifactFiles | null;
  /** The agent's home on the orchestrator's host, where the file tools read and write. */
  workspace_dir: string | null;
  guild_name: string;
  agent_name: string;
  org_slug: string;
  cancel_event: CancelEvent | null;
  track_command: ((executionId: string | null) => void) | null;
  group_chat: GroupChat | null;
  issues: Issues | null;
  schedules: Schedules | null;
  scripts: Scripts | null;
  run_kind: string;
  /** Names of the secrets in this generation's environment. */
  secret_names: string[];
  secret_store: AgentSecretStore | null;
  memory_replaced_by: string;
  run_scripts: RunScriptSnapshot[];
  /** How many scripts this agent may keep; `script_create` of a new name is refused past it. */
  max_scripts: number;
  connection_tool_names: string[];
  dynamic_tools: Record<string, Tool>;
  /** When set, only these names plus `dynamic_tools` may run. `null` skips the check. */
  offered_tools: Set<string> | null;
  /** The provider id of the call being invoked. */
  tool_call_id: string;
  /** Fields a handler reports for the call's metadata row (exit code, path, line counts). */
  tool_metadata: ReportedToolMetadata | null;
  /** The agent's home in its machine, where its commands run: `/home/<agent id>`. */
  agent_home: string;
  /** Chrome's DevTools port for the agent's browser, from its slot; null without one. */
  cdp_port: number | null;
  /** Starts the agent's Chrome when it is not up and keeps it from its idle stop; null without a browser. */
  ensure_browser: (() => Promise<void>) | null;
  /** Where a coding run's working directory starts, relative to the agent's home; empty for its root. */
  code_default_cwd: string;
  /** Runs before each `shell` command and harness poll: replaces repository tokens close to expiry. */
  before_command: (() => Promise<void>) | null;
  /** The run's coding harness, from its snapshot; null without one. */
  harness: Harness | null;
  /** The model the run's harness runs, from its snapshot; null for its subscription's default. */
  harness_model: string | null;
  /** The effort the run's harness runs its model at, from its snapshot; null for the harness's default. */
  harness_effort: Effort | null;
  /** The run's secret aliases, from its snapshot: which secret each aliased variable reads. */
  secret_aliases: Record<string, string>;
  /** The guild repositories a coding run works on, by their folder under `repos/`. */
  code_repositories: string[];
  /** Where the tools keep the run's state: its pinned scripts, its harness task, and the agent's harness logins. */
  db: ToolboxDatabase | null;
  /** The run's stream, where a running tool call publishes its progress. */
  events: ToolEvents | null;
};

export function createToolContext(
  partial: Pick<ToolContext, "run_id" | "agent_id" | "guild_id" | "sandbox" | "secrets"> &
    Partial<ToolContext>,
): ToolContext {
  return {
    exit_code: null,
    notes: null,
    artifacts: null,
    artifact_actor: null,
    files: null,
    workspace_dir: null,
    guild_name: "",
    agent_name: "",
    org_slug: "",
    cancel_event: null,
    track_command: null,
    group_chat: null,
    issues: null,
    schedules: null,
    scripts: null,
    run_kind: "direct",
    secret_names: [],
    secret_store: null,
    memory_replaced_by: "",
    run_scripts: [],
    max_scripts: DEFAULT_MAX_SCRIPTS,
    connection_tool_names: [],
    dynamic_tools: {},
    offered_tools: null,
    tool_call_id: "",
    tool_metadata: null,
    agent_home: agentHome(partial.agent_id),
    cdp_port: null,
    ensure_browser: null,
    code_default_cwd: "",
    before_command: null,
    harness: null,
    harness_model: null,
    harness_effort: null,
    secret_aliases: {},
    code_repositories: [],
    db: null,
    events: null,
    ...partial,
  };
}

export type Tool = {
  name: string;
  description: string;
  output_filter: (result: string) => string;
  filter_name: string;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>;
  schema: Record<string, unknown>;
};
