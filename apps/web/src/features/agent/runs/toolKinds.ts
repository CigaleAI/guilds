import type { ToolKind, ToolLevel } from "@guildsrun/ui";
import { parseToolArgs, type RunMessage, type ToolCallRequest } from "./toolFormat";

/** How a recorded tool call reads in the run view: its effect, the level it touched, and the connected server that served it. */
export type ToolCallInfo = {
  name: string;
  kind: ToolKind;
  level: ToolLevel | null;
  server: string | null;
};

/** A tool the run offered the model, as its config snapshot lists it. */
export type OfferedTool = { name?: string; function?: { name?: string } };

/** A connected server in the run's config snapshot, with the tools it contributed. */
export type ConnectedServer = { slug?: string; tools?: readonly { name?: string }[] };

/** The parts of a run that say which tools it offered and which connected servers served them. */
export type RunWithTools = {
  config_snapshot?: {
    tools?: readonly OfferedTool[];
    mcp?: readonly ConnectedServer[];
  } | null;
};

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

const LEVEL_BY_ARGUMENT: Readonly<Record<string, ToolLevel>> = Object.freeze({
  agent: "local",
  local: "local",
  guild: "guild",
  org: "org",
});

const LEVEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  local: "local",
  guild: "guild",
  org: "org",
  all: "all levels",
});

// `level` pins a fixed level: collections are organisation tables, so every
// record tool is `org`. Without it the level comes from the call's `level`
// argument, a display path in its arguments, or the result's first line.
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
  browse: { kind: "act" },
  browser_navigate: { kind: "act" },
  browser_snapshot: { kind: "read" },
  browser_click: { kind: "act" },
  browser_type: { kind: "act" },
  browser_fill: { kind: "act" },
  browser_scroll: { kind: "act" },
  browser_screenshot: { kind: "read" },
  browser_eval: { kind: "act" },
  shell: { kind: "execute", level: "local" },
  shell_status: { kind: "read", level: "local" },
  code_task: { kind: "execute", level: "local", mutates: true },
  file_read: { kind: "read", level: "local" },
  code_search: { kind: "read", level: "local" },
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

const DISPLAY_PATH_RE = /^org\/[^/]+\/(?:(agents|guilds)\/[^/]+\/)?/;
const MEMORY_PATH_RE = /\/memory\.md$/;

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The level a display path such as `org/o1/guilds/g1/plan.md` belongs to; null when it is not one. */
export function levelFromDisplayPath(path: unknown): ToolLevel | null {
  if (typeof path !== "string") return null;
  const match = DISPLAY_PATH_RE.exec(path.trim());
  if (!match) return null;
  if (match[1] === "agents") return "local";
  if (match[1] === "guilds") return "guild";
  return "org";
}

/** The connected server slug for each tool a run's connected servers contributed, by tool name. */
export function connectedToolServers(run: RunWithTools | null | undefined): Map<string, string> {
  const servers = new Map<string, string>();
  const list = run?.config_snapshot?.mcp;
  if (!Array.isArray(list)) return servers;
  for (const entry of list) {
    const tools = entry?.tools;
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (tool?.name) servers.set(String(tool.name), String(entry.slug || ""));
    }
  }
  return servers;
}

/** The names of every tool the run offered the model. */
export function offeredToolNames(run: RunWithTools | null | undefined): Set<string> {
  const names = new Set<string>();
  const tools = run?.config_snapshot?.tools;
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    const name = tool?.function?.name || tool?.name;
    if (name) names.add(String(name));
  }
  return names;
}

function firstLine(content: unknown): string {
  if (typeof content !== "string") return "";
  const end = content.indexOf("\n");
  return end === -1 ? content : content.slice(0, end);
}

function derivedLevel(
  name: string,
  args: Record<string, unknown>,
  resultMsg: RunMessage | null | undefined,
): ToolLevel | null {
  const explicit = lookup(LEVEL_BY_ARGUMENT, String(args.level || "").toLowerCase());
  if (explicit) return explicit;
  const fromArgs = levelFromDisplayPath(args.path) || levelFromDisplayPath(args.path_prefix);
  if (fromArgs) return fromArgs;
  const fromResult = levelFromDisplayPath(firstLine(resultMsg?.payload?.content));
  if (fromResult) return fromResult;
  return name.includes("_find") ? "all" : null;
}

function touchesMemory(args: Record<string, unknown>): boolean {
  return MEMORY_PATH_RE.test(String(args.path || ""));
}

/** Classifies a recorded tool call by effect, level, and serving connected server, using its result and the run's snapshot. */
export function classifyToolCall(
  call: ToolCallRequest | null | undefined,
  resultMsg?: RunMessage | null,
  run?: RunWithTools | null,
): ToolCallInfo {
  const name = String(call?.function?.name || resultMsg?.metadata?.tool_name || "");
  const args = parseToolArgs(call?.function?.arguments);
  const entry = lookup(TABLE, name);
  if (entry) {
    const memory = entry.kind === "read" && touchesMemory(args);
    const kind = memory ? "memory" : entry.kind;
    const level = memory ? "local" : (entry.level ?? derivedLevel(name, args, resultMsg));
    return { name, kind, level, server: null };
  }
  const servers = connectedToolServers(run);
  if (servers.has(name)) {
    return { name, kind: "connected", level: null, server: servers.get(name) || null };
  }
  if (offeredToolNames(run).has(name)) {
    return { name, kind: "execute", level: "local", server: null };
  }
  return { name, kind: "unknown", level: null, server: null };
}

/** Whether a call changes tracked state: a note, memory, record, collection, script or source code. */
export function isMutation(info: ToolCallInfo): boolean {
  return lookup(TABLE, info.name)?.mutates === true;
}

/** Whether a call runs one of the agent's scripts. */
export function isScriptRun(info: ToolCallInfo): boolean {
  return info.name === "script_run";
}

function isToolKind(value: unknown): value is ToolKind {
  return (TOOL_KINDS as readonly unknown[]).includes(value);
}

/** The kind to show for any value: itself when it is a known kind, `unknown` otherwise. */
export function kindLabel(kind: unknown): ToolKind {
  return isToolKind(kind) ? kind : "unknown";
}

/** The label for a level ("all levels" for a search across every level); empty for no level. */
export function levelLabel(level: unknown): string {
  return lookup(LEVEL_LABELS, String(level)) || "";
}

/** A one-line summary of the kinds of calls made, in kind order with counts, such as "memory · read × 2 · write". */
export function kindBreakdown(infos: readonly ToolCallInfo[]): string {
  const counts = new Map<ToolKind, number>();
  for (const info of infos) {
    const kind = kindLabel(info.kind);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return TOOL_KINDS.filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind) ?? 0;
      return count > 1 ? `${kind} × ${count}` : kind;
    })
    .join(" · ");
}
