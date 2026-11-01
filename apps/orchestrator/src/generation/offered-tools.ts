import { enabledToolNames, resolvedTools, type ResolvableBinding } from "../access/index.js";
import type { RunMcpConnection, RunScriptSnapshot } from "../db/schema/index.js";
import type { FunctionTool } from "../lib/tool-schema.js";
import { REGISTRY } from "../toolbox/index.js";
import { offeredToolNames } from "../toolbox/offered.js";
import { firstClassScriptSchemas } from "../toolbox/script.js";

/**
 * The tools a generation offers: the run's snapshot, narrowed to what the agent's live bindings
 * still grant, and the connection tools it dispatches to an MCP server.
 */

/** The name a tool is offered to the model under: its function's. */
export function toolSchemaName(tool: FunctionTool): string {
  return tool.function.name;
}

export function snapshotOfferedNames(tools: FunctionTool[]): Set<string> {
  return new Set(tools.map(toolSchemaName));
}

/** First-class script schemas follow `script_run`, not the frozen native/MCP list. */
export function withFirstClassScriptTools(
  tools: FunctionTool[],
  runScripts: RunScriptSnapshot[],
  scriptRunOffered: boolean,
): FunctionTool[] {
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
  /**
   * Whether the agent's config turns the agent-optimized browser on, whatever the System One key:
   * a snapshot that froze `browse` keeps it while this holds, and its calls answer that the key is
   * missing while it is.
   */
  browserOptimized: boolean;
  coding: boolean;
  scripting: boolean;
  memory: boolean;
  schedules: boolean;
  direct: boolean;
};

/**
 * The snapshot's tool names that the live bindings of `scope`, in `rows`, still grant under
 * `settings`; connection tools and names no native tool owns stay offered. While the browser is
 * on, the step-by-step browser tools a snapshot froze stay offered whatever the browser's mode;
 * `browse` stays offered only while the agent's config keeps the agent-optimized browser on.
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
  const granted = enabledToolNames(resolvedTools(rows, scope));
  const liveNative = new Set([
    ...offeredToolNames(granted, { ...settings, browserOptimized: false }),
    ...offeredToolNames(granted, settings),
  ]);
  const offered = new Set<string>();
  for (const name of snapshotNames) {
    if (name in REGISTRY && !liveNative.has(name)) {
      continue;
    }
    offered.add(name);
  }
  return offered;
}

/** Where a connection tool's calls go: the connection, and the tool's name on its server. */
export type ConnectionTarget = [connectionId: string, remoteName: string];

/**
 * A run snapshot's connection tools, each by the name the model calls it, to where its calls go.
 * A name the native registry owns is never a connection tool, whatever the snapshot lists:
 * native dispatch wins.
 */
export function mcpIndex(mcp: RunMcpConnection[]): Map<string, ConnectionTarget> {
  const index = new Map<string, ConnectionTarget>();
  for (const group of mcp) {
    for (const tool of group.tools) {
      if (!(tool.name in REGISTRY)) {
        index.set(tool.name, [group.connection_id, tool.remote_name]);
      }
    }
  }
  return index;
}
