import type { RuntimeAccess } from "../access/runtime.js";
import { RUN_PROJECTION_POLICY_VERSION } from "../conversation/projection.js";
import type { GroupMessageRow } from "../db/group-chat.js";
import type { AgentRow } from "../db/agents.js";
import type { RunRow } from "../db/runs.js";
import type {
  AgentConfig,
  RunConfigSnapshot,
  RunMetadata,
  RunScriptSnapshot,
  RunTaskSource,
  RunTypesafe,
} from "../db/schema/index.js";
import { promptHash } from "../prompts/index.js";
import { schemasFor } from "../toolbox/index.js";
import { offeredToolNames } from "../toolbox/offered.js";
import { firstClassScriptSchemas } from "../toolbox/script.js";

// The config a run is created with. A run reads its model, limits, tools and secrets from this
// snapshot for its whole life, whatever the agent's settings become.

/** A run's kind: opened by an operator, delivered from the group chat, or woken by a schedule. */
export type RunKind = RunRow["kind"];

/** A run snapshot's config, with the tools the agent's access offers to a run of `kind`. */
export function configSnapshot(
  config: AgentConfig,
  access: RuntimeAccess,
  kind: RunKind,
  scripts?: RunScriptSnapshot[],
): RunConfigSnapshot {
  const native = schemasFor(
    offeredToolNames(access.tools, {
      browser: config.browser,
      coding: config.coding,
      scripting: config.scripting,
      memory: config.memory,
      schedules: kind !== "schedule",
      direct: kind === "direct",
    }),
  );
  const { max_scripts: _maxScripts, max_workspace_mib: _maxWorkspaceMib, ...settings } = config;
  const snapshot: RunConfigSnapshot = {
    ...settings,
    projection_policy_version: RUN_PROJECTION_POLICY_VERSION,
    database: false,
    tools: [
      ...native,
      ...access.mcp.flatMap((group) => group.tools.map((tool) => tool.schema)),
      ...firstClassScriptSchemas(scripts ?? []),
    ],
    mcp: access.mcp.map((group) => ({
      connection_id: group.connection_id,
      server_id: group.server_id,
      slug: group.slug,
      tools: group.tools.map((tool) => ({ name: tool.name, remote_name: tool.remote_name })),
    })),
    secrets: [...access.secrets],
  };
  if (scripts) {
    snapshot.scripts = scripts;
  }
  return snapshot;
}

/** A run about to be created: its agent, its config and access, and the prompts composed for it. */
export type PreparedRun = {
  agent: AgentRow;
  config: AgentConfig;
  access: RuntimeAccess;
  members: Array<Record<string, unknown>>;
  historyRows: GroupMessageRow[];
  standing: string;
  system: string;
  task: string;
  memory: string;
  scripts: RunScriptSnapshot[];
  taskSource: RunTaskSource | null;
  typesafe: RunTypesafe | null;
};

/** The hashes of the prompts a prepared run starts from, as the run row keeps them. */
export function preparedPromptHashes(prepared: PreparedRun): {
  systemPromptHash: string;
  taskPromptHash: string;
  memoryPromptHash: string;
} {
  return {
    systemPromptHash: promptHash(prepared.standing),
    taskPromptHash: promptHash(prepared.task),
    memoryPromptHash: promptHash(prepared.memory),
  };
}

/** The config snapshot a prepared run of `kind` is created with. */
export function preparedSnapshot(prepared: PreparedRun, kind: RunKind): RunConfigSnapshot {
  return configSnapshot(prepared.config, prepared.access, kind, prepared.scripts);
}

/** The metadata a prepared run is created with: its task source and the typesafe decisions, when any. */
export function preparedRunMetadata(prepared: PreparedRun, extra?: RunTypesafe | null): RunMetadata | undefined {
  const metadata: RunMetadata = {};
  if (prepared.taskSource) {
    metadata.task_source = prepared.taskSource;
  }
  if (prepared.typesafe || extra) {
    metadata.typesafe = { ...prepared.typesafe, ...extra };
  }
  return Object.keys(metadata).length ? metadata : undefined;
}
