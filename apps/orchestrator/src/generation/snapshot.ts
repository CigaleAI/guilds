import type { RuntimeAccess } from "../access/runtime.js";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_TOOL_CALLS,
  browserLanguageOf,
  keepToolResultGenerationsOf,
  memoryOf,
  secretAliasesOf,
  type AgentConfig,
} from "../agents/validation.js";
import { harnessEffortOf } from "../coding/harness-models.js";
import { harnessModelOf, harnessOf } from "../coding/harnesses.js";
import { RUN_PROJECTION_POLICY_VERSION } from "../conversation/projection.js";
import { isPlainRecord } from "../db/json.js";
import type { RunRow } from "../db/runs.js";
import { promptHash } from "../prompts/index.js";
import type { RunScriptSnapshot } from "../scripts/snapshot.js";
import { schemasFor } from "../toolbox/index.js";
import { offeredToolNames } from "../toolbox/offered.js";
import { firstClassScriptSchemas } from "../toolbox/script.js";

/**
 * The config a run is created with. A run reads its model, limits, tools and secrets from this
 * snapshot for its whole life, whatever the agent's settings become.
 */

export function positiveInt(value: unknown, fallback: number): number {
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

function schemasFromMcpTool(tool: unknown): Array<Record<string, unknown>> {
  if (!isPlainRecord(tool)) {
    return [];
  }
  return isPlainRecord(tool.schema) ? [tool.schema] : [];
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
  return tools.flatMap((tool) => (isPlainRecord(tool) ? [{ name: tool.name, remote_name: tool.remote_name }] : []));
}

/** A run's kind: opened by an operator, delivered from the group chat, or woken by a schedule. */
export type RunKind = RunRow["kind"];

/** A run snapshot's config, with the tools the agent's access offers to a run of `kind`. */
export function configSnapshot(
  config: AgentConfig | Record<string, unknown>,
  access: RuntimeAccess,
  kind: RunKind,
  scripts?: RunScriptSnapshot[],
): Record<string, unknown> {
  const native = schemasFor(
    offeredToolNames(access.tools, {
      browser: Boolean(config.browser),
      coding: Boolean(config.coding),
      scripting: config.scripting !== false,
      memory: memoryOf(config),
      schedules: kind !== "schedule",
      direct: kind === "direct",
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
    tools: [...native, ...schemasFromMcpGroups(access.mcp), ...firstClassScriptSchemas(scripts ?? [])],
    mcp: access.mcp.map((group) => ({
      connection_id: group.connection_id,
      server_id: group.server_id,
      slug: group.slug,
      tools: mcpToolNamePairs(group.tools),
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
  agent: Record<string, unknown>;
  config: AgentConfig;
  access: RuntimeAccess;
  members: Array<Record<string, unknown>>;
  historyRows: Array<Record<string, unknown>>;
  standing: string;
  system: string;
  task: string;
  memory: string;
  scripts: RunScriptSnapshot[];
  taskSource: Record<string, unknown> | null;
  typesafe: Record<string, unknown> | null;
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
export function preparedSnapshot(prepared: PreparedRun, kind: RunKind): Record<string, unknown> {
  return configSnapshot(prepared.config, prepared.access, kind, prepared.scripts);
}

/** The metadata a prepared run is created with: its task source and the typesafe decisions, when any. */
export function preparedRunMetadata(
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
