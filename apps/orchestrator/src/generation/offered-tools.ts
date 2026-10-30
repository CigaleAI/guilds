import { enabledToolNames, resolvedTools, type ResolvableBinding } from "../access/index.js";
import { isPlainRecord } from "../db/json.js";
import type { RunMcpConnection, RunScriptSnapshot } from "../db/schema/index.js";
import { REGISTRY } from "../toolbox/index.js";
import { offeredToolNames } from "../toolbox/offered.js";
import { firstClassScriptSchemas } from "../toolbox/script.js";

/**
 * The tools a generation offers: the run's snapshot, narrowed to what the agent's live bindings
 * still grant, and the connection tools it dispatches to an MCP server.
 */

/** The name a tool schema offers its tool under: its function's name, else its own. */
export function toolSchemaName(tool: Record<string, unknown>): string {
  const fn = isPlainRecord(tool.function) ? tool.function : null;
  return (
    (fn && typeof fn.name === "string" ? fn.name : "") ||
    (typeof tool.name === "string" ? tool.name : "")
  );
}

export function snapshotOfferedNames(tools: Array<Record<string, unknown>>): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = toolSchemaName(tool);
    if (name) {
      names.add(name);
    }
  }
  return names;
}

/** First-class script schemas follow `script_run`, not the frozen native/MCP list. */
export function withFirstClassScriptTools(
  tools: Array<Record<string, unknown>>,
  runScripts: RunScriptSnapshot[],
  scriptRunOffered: boolean,
): Array<Record<string, unknown>> {
  const firstClass = new Set(
    runScripts.filter((row) => row.parameters !== null).map((row) => row.name),
  );
  const kept = tools.filter((tool) => !firstClass.has(toolSchemaName(tool)));
  if (!scriptRunOffered) {
    return kept;
  }
  return [...kept, ...firstClassScriptSchemas(runScripts)];
}

/** The organisation, guild, and agent whose bindings decide which tools a generation offers. */
export type ToolBindingScope = {
  orgId?: string | null;
  guildId?: string | null;
  agentId?: string | null;
};

/**
 * What decides a generation's offer beside its bindings: the agent's live settings, whether its
 * run may set schedules, and whether it is a direct run.
 */
export type OfferedToolSettings = {
  browser: boolean;
  coding: boolean;
  scripting: boolean;
  memory: boolean;
  schedules: boolean;
  direct: boolean;
};

/**
 * The snapshot's tool names that the live bindings of `scope`, in `rows`, still grant under
 * `settings`; connection tools and names no native tool owns stay offered.
 */
export function liveOfferedNames(
  snapshotNames: Set<string>,
  rows: ResolvableBinding[],
  scope: ToolBindingScope,
  settings: OfferedToolSettings,
): Set<string> {
  const nativeRows = rows.filter((row) => row.catalog_kind === "native_tool");
  if (!nativeRows.length) {
    return snapshotNames;
  }
  const liveNative = new Set(offeredToolNames(enabledToolNames(resolvedTools(rows, scope)), settings));
  const offered = new Set<string>();
  for (const name of snapshotNames) {
    if (name in REGISTRY && !liveNative.has(name)) {
      continue;
    }
    offered.add(name);
  }
  return offered;
}

// Maps a run snapshot's connection tools to `[connection_id, remote_name]`.
// A name the native registry owns is never a connection tool, whatever the
// snapshot lists: native dispatch wins.
export function mcpIndex(mcp: RunMcpConnection[]): Record<string, [string, string]> {
  const index: Record<string, [string, string]> = {};
  for (const group of mcp) {
    for (const tool of group.tools) {
      if (!(tool.name in REGISTRY)) {
        index[tool.name] = [group.connection_id, tool.remote_name];
      }
    }
  }
  return index;
}
