import type { Static, TObject } from "@sinclair/typebox";
import { DEFAULT_MAX_SCRIPTS } from "../agents/config.js";
import type { Harness, Effort, ReportedToolMetadata } from "../db/schema/index.js";
import { agentHome } from "../lib/agent-file.js";
import type { JsonObject } from "../lib/json.js";
import type { ArtifactActor } from "../artifacts/types.js";
import type { CdpTarget } from "../browse/bridge.js";
import type { RunScriptSnapshot } from "../db/schema/index.js";
import type { SandboxHandle } from "../sandbox/sdk.js";
import { ToolArgumentError } from "./errors.js";
import { identityOutput } from "./output.js";
import { decodeArguments, type FunctionTool } from "../lib/tool-schema.js";
import { toolFunctionSchema } from "./schema.js";
import type { ToolServices } from "./services.js";

export type GroupChat = {
  publish?(guildId: string, event: string, data: JsonObject): Promise<void>;
  postFromRun?(
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

/** The sandbox a run's commands go to, as the tools reach it: its commands and its files. */
export type RunSandbox = Pick<SandboxHandle, "commands" | "files"> & Partial<Pick<SandboxHandle, "id">>;

/** Saves values the agent produced as secrets of its organisation, granted to the agent. */
export type AgentSecretStore = {
  /** Reads the value from `file`, stores or rotates the secret, and removes the file. */
  store(input: { name: unknown; description: unknown; file: string }): Promise<{
    name: string;
    rotated: boolean;
    value: string;
  }>;
};

/** What a run's tools work with, the same for every call: whose run it is, where its commands run, and what it offers. */
export type ToolRun = {
  run_id: string;
  agent_id: string;
  guild_id: string;
  guild_name: string;
  agent_name: string;
  org_slug: string;
  run_kind: string;
  /** The agent's container on its machine, with the run's environment; null without one. */
  sandbox: RunSandbox | null;
  /** The values of the run's secrets, which its tool results are redacted with. */
  secrets: Record<string, string>;
  /** Names of the secrets in this generation's environment. */
  secret_names: string[];
  /** The run's secret aliases, from its snapshot: which secret each aliased variable reads. */
  secret_aliases: Record<string, string>;
  /** Who the run is in the artifact store; null when its agent has no organisation. */
  artifact_actor: ArtifactActor | null;
  /** The agent's home on the orchestrator's host, where the file tools read and write. */
  workspace_dir: string | null;
  /** The agent's home in its machine, where its commands run: `/home/<agent id>`. */
  agent_home: string;
  /** Chrome's DevTools port for the agent's browser, from its slot; null without one. */
  cdp_port: number | null;
  /** What a cancel of the run sets; null when nothing cancels the work. */
  cancel_event: CancelEvent | null;
  memory_replaced_by: string;
  run_scripts: RunScriptSnapshot[];
  /** How many scripts this agent may keep; `script_create` of a new name is refused past it. */
  max_scripts: number;
  connection_tool_names: string[];
  dynamic_tools: ToolsByName;
  /** When set, only these names plus `dynamic_tools` may run. `null` skips the check. */
  offered_tools: Set<string> | null;
  /** The run's coding harness, from its snapshot; null without one. */
  harness: Harness | null;
  /** The model the run's harness runs, from its snapshot; null for its subscription's default. */
  harness_model: string | null;
  /** The effort the run's harness runs its model at, from its snapshot; null for the harness's default. */
  harness_effort: Effort | null;
  /** The guild repositories a coding run works on, by their folder under `repos/`. */
  code_repositories: string[];
  /** Where a coding run's working directory starts, relative to the agent's home; empty for its root. */
  code_default_cwd: string;
};

/** The hooks the loop composes for one run, each bound to what the run record does not hold. */
export type ToolHooks = {
  /** Keeps the command the run waits on, so a cancel interrupts it; null when the run's commands are not tracked. */
  track_command: ((executionId: string | null) => void) | null;
  /** Starts the agent's Chrome when it is not up and keeps it from its idle stop; null without a browser. */
  ensure_browser: (() => Promise<void>) | null;
  /** Counts browser work under way as activity: the idle stops of the agent's Chrome and machine restart; null without a browser. */
  touch_browser: (() => void) | null;
  /** The upstream base and headers of the agent's DevTools relay; null without a browser. */
  cdp_target: (() => Promise<CdpTarget>) | null;
  /** Runs before each `shell` command and harness poll: replaces repository tokens close to expiry. */
  before_command: (() => Promise<void>) | null;
  /** Saves values the agent produced as secrets of its organisation; null where the run cannot. */
  secret_store: AgentSecretStore | null;
};

/** The run record of `partial`, every field it leaves out at its default. */
export function createToolRun(
  partial: Pick<ToolRun, "run_id" | "agent_id" | "guild_id" | "sandbox" | "secrets"> & Partial<ToolRun>,
): ToolRun {
  return {
    guild_name: "",
    agent_name: "",
    org_slug: "",
    run_kind: "direct",
    secret_names: [],
    secret_aliases: {},
    artifact_actor: null,
    workspace_dir: null,
    agent_home: agentHome(partial.agent_id),
    cdp_port: null,
    cancel_event: null,
    memory_replaced_by: "",
    run_scripts: [],
    max_scripts: DEFAULT_MAX_SCRIPTS,
    connection_tool_names: [],
    dynamic_tools: {},
    offered_tools: null,
    harness: null,
    harness_model: null,
    harness_effort: null,
    code_repositories: [],
    code_default_cwd: "",
    ...partial,
  };
}

/**
 * One call the model made to a tool: its id, its name, its arguments, and what its handler reports
 * of it. The arguments are the JSON object the model wrote, or `A` once the tool decoded them.
 */
export type ToolInvocation<A = JsonObject> = {
  /** The provider id of the call. */
  id: string;
  name: string;
  arguments: A;
  /** The exit code of the command the call ran; null when it ran none. */
  exit_code: number | null;
  /** Fields the handler reports for the call's metadata row (exit code, path, line counts). */
  metadata: ReportedToolMetadata | null;
};

/** The run's artifact actor as it makes `call`; null when the run has none. */
export function callActor(actor: ArtifactActor | null, call: ToolInvocation): ArtifactActor | null {
  return actor ? { ...actor, toolCall: { id: call.id, name: call.name } } : null;
}

/** Hooks that do nothing: the run's commands untracked, no browser to start or reach, nothing run first, no secret store. */
export function createToolHooks(partial: Partial<ToolHooks> = {}): ToolHooks {
  return {
    track_command: null,
    ensure_browser: null,
    touch_browser: null,
    cdp_target: null,
    before_command: null,
    secret_store: null,
    ...partial,
  };
}

/** A tool a run can call: what the model is offered, and the handler of a call's arguments as the model wrote them. */
export type Tool = {
  name: string;
  description: string;
  output_filter: (result: string) => string;
  filter_name: string;
  handler: (services: ToolServices, run: ToolRun, hooks: ToolHooks, call: ToolInvocation) => Promise<string>;
  schema: FunctionTool;
};

/** Tools by the name the model calls them by. */
export type ToolsByName = Record<string, Tool>;

/**
 * A native tool as it is written: its name, what it does as the tool list and its function schema
 * say it, the TypeBox schema of its parameters, and its handler of a call decoded against them.
 */
export type NativeTool<P extends TObject> = {
  name: string;
  description: string;
  /** What the function schema says the tool does; `description` when it is the same. */
  summary?: string;
  parameters: P;
  handler: (services: ToolServices, run: ToolRun, hooks: ToolHooks, call: ToolInvocation<Static<P>>) => Promise<string>;
};

/**
 * `args` decoded as `parameters` describe them. An optional argument sent as null is absent. A
 * required argument left out throws a ToolArgumentError naming it; arguments that do not match
 * throw one naming the first mismatch by its JSON pointer.
 */
export function decodeToolArguments<P extends TObject>(parameters: P, args: JsonObject): JsonObject & Static<P> {
  return decodeArguments(parameters, args, (problem) => new ToolArgumentError(problem));
}

/** Decodes `call`'s arguments in place, as `parameters` describe them, so the handler reads them typed. */
function assertDecoded<P extends TObject>(
  parameters: P,
  call: ToolInvocation,
): asserts call is ToolInvocation & ToolInvocation<Static<P>> {
  call.arguments = decodeToolArguments(parameters, call.arguments);
}

/**
 * The tool `definition` describes. The model is offered the JSON Schema of its parameters, and
 * each call's arguments are decoded against the same schema before the handler runs, so a call
 * that does not match them is refused with nothing done.
 */
export function nativeTool<P extends TObject>(definition: NativeTool<P>): Tool {
  const { name, description, summary, parameters, handler } = definition;
  return {
    name,
    description,
    output_filter: identityOutput,
    filter_name: "identity",
    schema: toolFunctionSchema(name, summary ?? description, parameters),
    handler: async (services, run, hooks, call) => {
      assertDecoded(parameters, call);
      return handler(services, run, hooks, call);
    },
  };
}
