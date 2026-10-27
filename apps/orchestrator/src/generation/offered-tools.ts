import { enabledToolNames, resolvedTools } from "../access/index.js";
import { isPlainRecord } from "../db/json.js";
import type { RunScriptSnapshot } from "../scripts/snapshot.js";
import { REGISTRY } from "../toolbox/index.js";
import { offeredToolNames } from "../toolbox/offered.js";
import { firstClassScriptSchemas } from "../toolbox/script.js";

/**
 * The tools a generation offers: the run's snapshot, narrowed to what the agent's live bindings
 * still grant, and the connection tools it dispatches to an MCP server.
 */

export function toolSchemaName(tool: unknown): string {
  if (!isPlainRecord(tool)) {
    return "";
  }
  const fn = isPlainRecord(tool.function) ? tool.function : null;
  return (
    (fn && typeof fn.name === "string" ? fn.name : "") ||
    (typeof tool.name === "string" ? tool.name : "")
  );
}

export function snapshotOfferedNames(tools: unknown): Set<string> {
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

/** First-class script schemas follow `script_run`, not the frozen native/MCP list. */
export function withFirstClassScriptTools(
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

export function liveOfferedNames(
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
    if (!isPlainRecord(tool)) {
      continue;
    }
    const name = tool.name;
    const remote = tool.remote_name;
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
    if (!isPlainRecord(group) || typeof group.connection_id !== "string") {
      continue;
    }
    indexConnectionTools(index, group.connection_id, group.tools);
  }
  return index;
}
