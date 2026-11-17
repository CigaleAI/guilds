import type { ToolKind, ToolLevel } from "@guildsrun/ui";
import type { Harness } from "../../../api/types/agents";
import type { RunConfigSnapshot, StepMessage, ToolCall } from "../../../api/types/runs";
import {
  isAntigravityToolArguments,
  isNoteToolArguments,
  type JsonObject,
} from "../../../api/wire";
import { parseToolArgs } from "./toolFormat";

/**
 * How a recorded tool call reads in the run view: its effect, where what it touched lives, the
 * connected server that served it, and the harness that called it, of its own tools or of an MCP
 * server it loaded itself; null for a tool the guild offers the agent.
 */
export type ToolCallInfo = {
  name: string;
  kind: ToolKind;
  level: ToolLevel | null;
  server: string | null;
  harness: Harness | null;
};

/** The parts of a run that say which tools it offered and which connected servers served them. */
export type RunWithTools = { config_snapshot: Pick<RunConfigSnapshot, "tools" | "mcp"> };

/** `mutates` marks a tool that changes tracked state: a note, memory, record, collection, script or source code. */
type ToolEntry = { kind: ToolKind; level?: ToolLevel; mutates?: true };

/** Every tool kind, in the order breakdowns list them. */
export const TOOL_KINDS: readonly ToolKind[] = Object.freeze([
  "memory",
  "read",
  "write",
  "execute",
  "act",
  "post",
  "connected",
  "unknown",
]);

// `level` says where what a tool touches lives: the agent's own (scripts,
// schedules, its shell), its guild (the group chat), or the organisation
// (tables, secrets). A note or file tool has none: who reaches a note or a
// file is its access list, not where it lives.
const TABLE: Readonly<Record<string, ToolEntry>> = Object.freeze({
  note_find: { kind: "read" },
  note_get: { kind: "read" },
  note_write: { kind: "write", mutates: true },
  note_delete: { kind: "write", mutates: true },
  record_search: { kind: "read", level: "org" },
  record_list: { kind: "read", level: "org" },
  record_add: { kind: "write", level: "org", mutates: true },
  record_update: { kind: "write", level: "org", mutates: true },
  record_remove: { kind: "write", level: "org", mutates: true },
  file_find: { kind: "read" },
  file_fetch: { kind: "read" },
  file_put: { kind: "write", mutates: true },
  file_delete: { kind: "write", mutates: true },
  memory_write: { kind: "memory", level: "local", mutates: true },
  group_post: { kind: "post", level: "guild" },
  report_issue: { kind: "write", level: "guild" },
  script_create: { kind: "write", level: "local", mutates: true },
  script_list: { kind: "read", level: "local" },
  script_read: { kind: "read", level: "local" },
  script_run: { kind: "execute", level: "local" },
  script_delete: { kind: "write", level: "local", mutates: true },
  schedule_create_cron: { kind: "write", level: "local" },
  schedule_create_window: { kind: "write", level: "local" },
  schedule_list: { kind: "read", level: "local" },
  schedule_update: { kind: "write", level: "local" },
  schedule_pause: { kind: "write", level: "local" },
  schedule_resume: { kind: "write", level: "local" },
  schedule_delete: { kind: "write", level: "local" },
  wake_after: { kind: "write", level: "local" },
  wake_cancel: { kind: "write", level: "local" },
  browse: { kind: "act" },
  browser_navigate: { kind: "act" },
  browser_snapshot: { kind: "read" },
  browser_click: { kind: "act" },
  browser_type: { kind: "act" },
  browser_fill: { kind: "act" },
  browser_scroll: { kind: "act" },
  browser_screenshot: { kind: "read" },
  browser_eval: { kind: "act" },
  secret_store: { kind: "write", level: "org" },
  secret_request: { kind: "post", level: "local" },
  studio_get_guidelines: { kind: "read" },
  studio_get_agent_context: { kind: "read" },
  studio_list_routines: { kind: "read" },
  studio_list_runs: { kind: "read" },
  studio_get_run: { kind: "read" },
  studio_list_group_messages: { kind: "read" },
  studio_list_task_revisions: { kind: "read" },
  studio_list_memory_revisions: { kind: "memory", level: "local" },
  studio_find_artifacts: { kind: "read" },
  studio_get_artifact: { kind: "read" },
  studio_get_script: { kind: "read", level: "local" },
  studio_get_agent_access: { kind: "read" },
  studio_request_connection_access: { kind: "write" },
  studio_call_connection_tool: { kind: "connected" },
  studio_create_task_draft: { kind: "write", level: "local" },
  studio_get_guild: { kind: "read" },
  studio_list_guilds: { kind: "read", level: "org" },
  studio_edit_memory: { kind: "memory", level: "local", mutates: true },
  studio_edit_note: { kind: "write", mutates: true },
  studio_edit_guild: { kind: "write" },
  studio_list_collections: { kind: "read", level: "org" },
  studio_get_collection: { kind: "read", level: "org" },
  studio_edit_collection: { kind: "write", level: "org", mutates: true },
  studio_edit_routine: { kind: "write" },
  builder_list_capabilities: { kind: "read" },
  builder_search_capabilities: { kind: "read" },
  builder_describe_server: { kind: "read" },
  builder_write_recipe: { kind: "write" },
  builder_validate_recipe: { kind: "read" },
  builder_search_connected: { kind: "connected" },
  builder_ask_org_connection: { kind: "post" },
  builder_ask_connection: { kind: "post" },
  builder_ask_question: { kind: "post" },
});

// Each harness's own tools, by the name its rows give them: Claude Code's by their names, Codex's
// by the items its log reports them as, Cursor's by its event's tool kind without `ToolCall`, and
// Antigravity's by their names. They touch the agent's own home, or the web. A table applies only
// to the rows of its harness, so a tool the guild offers never reads as a harness's that shares
// its name, nor the other way round.
const HARNESS_TOOLS: Readonly<Record<Harness, Readonly<Record<string, ToolEntry>>>> = Object.freeze(
  {
    "claude-code": Object.freeze<Record<string, ToolEntry>>({
      Bash: { kind: "execute", level: "local" },
      Read: { kind: "read", level: "local" },
      Glob: { kind: "read", level: "local" },
      Grep: { kind: "read", level: "local" },
      LS: { kind: "read", level: "local" },
      Write: { kind: "write", level: "local" },
      Edit: { kind: "write", level: "local" },
      MultiEdit: { kind: "write", level: "local" },
      NotebookEdit: { kind: "write", level: "local" },
      TodoWrite: { kind: "write", level: "local" },
      Task: { kind: "execute", level: "local" },
      WebFetch: { kind: "read" },
      WebSearch: { kind: "read" },
    }),
    codex: Object.freeze<Record<string, ToolEntry>>({
      command_execution: { kind: "execute", level: "local" },
      file_change: { kind: "write", level: "local" },
      web_search: { kind: "read" },
    }),
    cursor: Object.freeze<Record<string, ToolEntry>>({
      shell: { kind: "execute", level: "local" },
      await: { kind: "execute", level: "local" },
      read: { kind: "read", level: "local" },
      grep: { kind: "read", level: "local" },
      glob: { kind: "read", level: "local" },
      ls: { kind: "read", level: "local" },
      write: { kind: "write", level: "local" },
      edit: { kind: "write", level: "local" },
      delete: { kind: "write", level: "local" },
      todo: { kind: "write", level: "local" },
      getMcpTools: { kind: "read" },
    }),
    antigravity: Object.freeze<Record<string, ToolEntry>>({
      run_command: { kind: "execute", level: "local" },
      send_command_input: { kind: "execute", level: "local" },
      command_status: { kind: "read", level: "local" },
      view_file: { kind: "read", level: "local" },
      list_dir: { kind: "read", level: "local" },
      find_by_name: { kind: "read", level: "local" },
      grep_search: { kind: "read", level: "local" },
      write_to_file: { kind: "write", level: "local" },
      replace_file_content: { kind: "write", level: "local" },
      multi_replace_file_content: { kind: "write", level: "local" },
      search_web: { kind: "read" },
      read_url_content: { kind: "read" },
      call_mcp_tool: { kind: "connected" },
    }),
  },
);

/**
 * How each harness names a call of a tool of an MCP server other than the guild's, with the
 * server in the first group where the name carries it: Claude Code and Codex `mcp__<server>__<tool>`,
 * Antigravity `mcp_<server>_<tool>`, whose server cannot be told from a server name holding `_`.
 * Cursor's rows name such a call by the tool's own name alone.
 */
const HARNESS_MCP_NAMES: Readonly<Record<Harness, RegExp | null>> = Object.freeze({
  "claude-code": /^mcp__(.+?)__./,
  codex: /^mcp__(.+?)__./,
  cursor: null,
  antigravity: /^mcp_./,
});

/** An agent's Memory, `org/<org>/agents/<agent>/memory.md`. */
const MEMORY_PATH_RE = /^org\/[^/]+\/agents\/[^/]+\/memory\.md$/;

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The connected server slug for each tool a run's connected servers contributed, by tool name. */
export function connectedToolServers(run: RunWithTools | null | undefined): Map<string, string> {
  const servers = new Map<string, string>();
  for (const entry of run?.config_snapshot.mcp ?? []) {
    for (const tool of entry.tools) {
      if (tool.name) servers.set(tool.name, entry.slug);
    }
  }
  return servers;
}

/** The names of every tool the run offered the model. */
export function offeredToolNames(run: RunWithTools | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const tool of run?.config_snapshot.tools ?? []) {
    const name = tool.function?.name || tool.name;
    if (name) names.add(name);
  }
  return names;
}

/** Whether a call names an agent's Memory by its display path. */
function touchesMemory(args: JsonObject): boolean {
  return isNoteToolArguments(args) && MEMORY_PATH_RE.test(args.path ?? "");
}

/** How a call of a tool the app knows reads: its kind and level, a read of an agent's Memory counting as memory of its own. */
function knownToolInfo(name: string, entry: ToolEntry, args: JsonObject): ToolCallInfo {
  const memory = entry.kind === "read" && touchesMemory(args);
  const kind = memory ? "memory" : entry.kind;
  const level = memory ? "local" : (entry.level ?? null);
  return { name, kind, level, server: null, harness: null };
}

/** The MCP server a harness's call names in its arguments, as Antigravity's `call_mcp_tool` does; null when it names none. */
function argumentServer(args: JsonObject): string | null {
  return isAntigravityToolArguments(args) ? (args.ServerName ?? null) : null;
}

/**
 * How a call `harness` made reads: of an MCP server's tool as connected, with its server when the
 * call names it; of one of the harness's own tools by its table; any other by its name alone.
 */
function harnessToolInfo(harness: Harness, name: string, args: JsonObject): ToolCallInfo {
  const mcp = HARNESS_MCP_NAMES[harness]?.exec(name);
  if (mcp) return { name, kind: "connected", level: null, server: mcp[1] ?? null, harness };
  const entry = lookup(HARNESS_TOOLS[harness], name);
  if (!entry) return { name, kind: "unknown", level: null, server: null, harness };
  const server = entry.kind === "connected" ? argumentServer(args) : null;
  return { name, kind: entry.kind, level: entry.level ?? null, server, harness };
}

/** The tool a recorded call names: its request's, else its result's; empty when neither names one. */
function calledToolName(call: ToolCall, resultMsg: StepMessage | null | undefined): string {
  return call.function.name || resultMsg?.metadata.tool_name || "";
}

/**
 * Classifies a recorded tool call by effect, level, and serving connected server, using the tool
 * name its result records: a call `harness` made by that harness's tools, a call with no harness
 * by the tools the platform and the run's snapshot offer.
 */
export function classifyToolCall(
  call: ToolCall,
  harness: Harness | null,
  resultMsg?: StepMessage | null,
  run?: RunWithTools | null,
): ToolCallInfo {
  const name = calledToolName(call, resultMsg);
  const args = parseToolArgs(call.function.arguments);
  if (harness !== null) return harnessToolInfo(harness, name, args);
  const entry = lookup(TABLE, name);
  if (entry) return knownToolInfo(name, entry, args);
  const servers = connectedToolServers(run);
  if (servers.has(name)) {
    return {
      name,
      kind: "connected",
      level: null,
      server: servers.get(name) || null,
      harness: null,
    };
  }
  if (offeredToolNames(run).has(name)) {
    return { name, kind: "execute", level: "local", server: null, harness: null };
  }
  return { name, kind: "unknown", level: null, server: null, harness: null };
}

/** Whether a call changes tracked state: a note, memory, record, collection, script or source code. */
export function isMutation(info: ToolCallInfo): boolean {
  return info.harness === null && lookup(TABLE, info.name)?.mutates === true;
}

/** Whether a call runs one of the agent's scripts. */
export function isScriptRun(info: ToolCallInfo): boolean {
  return info.harness === null && info.name === "script_run";
}

/** A one-line summary of the kinds of calls made, in kind order with counts, such as "memory · read × 2 · write". */
export function kindBreakdown(infos: readonly ToolCallInfo[]): string {
  const counts = new Map<ToolKind, number>();
  for (const info of infos) {
    counts.set(info.kind, (counts.get(info.kind) || 0) + 1);
  }
  return TOOL_KINDS.filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0;
      return count > 1 ? `${kind} × ${count}` : kind;
    })
    .join(" · ");
}
