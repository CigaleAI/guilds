import { diffstat } from "../chat/changes";

/** A recorded run message: the API's message row, every field optional so partial rows fit too. */
export type RunMessage = {
  id?: unknown;
  seq?: unknown;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

/** One tool call as the model requested it in an assistant message's `tool_calls`. */
export type ToolCallRequest = {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

/** A value JSON carries: a string, number, boolean or null, or an array or object of them. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/**
 * A JSON object: the shape a call's arguments and a result's metadata take on the wire. A field
 * held as `undefined` is one JSON leaves out.
 */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * A tool call's arguments: the parameters the app reads by name, and the rest of the tool's own
 * schema, which differs from tool to tool.
 */
export type ToolArguments = {
  action?: JsonValue;
  agent_id?: JsonValue;
  agent_name?: JsonValue;
  background?: JsonValue;
  brief?: JsonValue;
  collection?: JsonValue;
  command?: JsonValue;
  direction?: JsonValue;
  home_path?: JsonValue;
  id?: JsonValue;
  key?: JsonValue;
  mode?: JsonValue;
  name?: JsonValue;
  offset?: JsonValue;
  path?: JsonValue;
  path_prefix?: JsonValue;
  pattern?: JsonValue;
  query?: JsonValue;
  repo?: JsonValue;
  scope?: JsonValue;
  server_ref?: JsonValue;
  session_id?: JsonValue;
  start?: JsonValue;
  stop?: JsonValue;
  summary?: JsonValue;
  target_agent_id?: JsonValue;
  tool?: JsonValue;
  url?: JsonValue;
  user?: JsonValue;
  [parameter: string]: JsonValue | undefined;
};

/**
 * What the orchestrator records about a tool result: the facts the app reads by name, and the
 * rest a tool adds of its own.
 */
export type ToolResultMetadata = {
  browser_usage?: JsonValue;
  cwd?: JsonValue;
  deletions?: JsonValue;
  duration_ms?: JsonValue;
  end_sha?: JsonValue;
  error?: JsonValue;
  exit_code?: JsonValue;
  files_changed?: JsonValue;
  harness?: JsonValue;
  insertions?: JsonValue;
  log_path?: JsonValue;
  original_bytes?: JsonValue;
  output_filter?: JsonValue;
  path?: JsonValue;
  range?: JsonValue;
  remaining_tool_calls?: JsonValue;
  repeat_of?: JsonValue;
  repository?: JsonValue;
  session_id?: JsonValue;
  start_sha?: JsonValue;
  status?: JsonValue;
  stored_bytes?: JsonValue;
  timed_out?: JsonValue;
  tool_name?: JsonValue;
  truncated?: JsonValue;
  [fact: string]: JsonValue | undefined;
};

/** A call's arguments ready to show: pretty JSON, the raw text, or an empty notice. */
export type ToolArgsInfo = {
  isEmpty: boolean;
  text: string;
  parsed: JsonValue | null;
};

/** A call's result ready to show: pretty JSON when the body parses, the raw text otherwise. */
export type ReturnedDataInfo = { isJson: boolean; isEmpty: boolean; text: string; raw: unknown };

const REMAINING_TOOL_CALLS_RE = /\n\nremaining_tool_calls: \d+\s*$/;

const JSON_SCALARS: readonly string[] = ["string", "number", "boolean"];

/** Whether a value is one JSON carries, every element and field of it included. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || JSON_SCALARS.includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

/** Whether a value is a JSON object: a plain object, every field of it a JSON value or left out. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((field) => field === undefined || isJsonValue(field));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Removes the tool-budget stamp the orchestrator appends to the end of a tool result. */
export function stripRemainingToolCalls(content: string): string {
  return content.replace(REMAINING_TOOL_CALLS_RE, "");
}

/** Reads a call's arguments, given as a JSON string or an object, as an object; empty when unreadable. */
export function parseToolArgs(raw: unknown): ToolArguments {
  const value = typeof raw === "string" && raw ? parseJson(raw) : raw;
  return isJsonObject(value) ? value : {};
}

/** Formats a call's arguments for display, noting when there are none. */
export function formatToolArgs(raw: unknown): ToolArgsInfo {
  if (!raw) return { isEmpty: true, text: "No arguments provided.", parsed: null };
  const value = typeof raw === "object" ? raw : parseJson(String(raw));
  if (!value || typeof value !== "object") {
    return { isEmpty: false, text: String(raw), parsed: null };
  }
  const parsed = isJsonValue(value) ? value : null;
  if (Object.keys(value).length === 0) {
    return { isEmpty: true, text: "No arguments provided.", parsed };
  }
  return { isEmpty: false, text: JSON.stringify(value, null, 2), parsed };
}

/** Formats a call's result for display, pretty-printing bodies that are JSON objects or arrays. */
export function formatReturnedData(content: unknown): ReturnedDataInfo {
  if (content === null || content === undefined) {
    return { isJson: false, isEmpty: true, text: "No output returned.", raw: "" };
  }
  if (typeof content === "object") {
    return { isJson: true, isEmpty: false, text: JSON.stringify(content, null, 2), raw: content };
  }
  const str = String(content);
  const trimmed = str.trim();
  if (!trimmed) {
    return { isJson: false, isEmpty: true, text: "(Empty response)", raw: str };
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    const parsed = parseJson(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return { isJson: true, isEmpty: false, text: JSON.stringify(parsed, null, 2), raw: parsed };
    }
  }
  return { isJson: false, isEmpty: false, text: str, raw: str };
}

/** The text of a message payload, joining the text parts of multi-part content. */
export function messageContentText(payload: RunMessage["payload"] | null | undefined): string {
  if (!payload) return "";
  const { content } = payload;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        const text: unknown =
          part !== null && typeof part === "object" && "text" in part ? part.text : undefined;
        return text || "";
      })
      .join("");
  }
  return "";
}

/** The error a recorded tool result carries: its `error` metadata, else the first line of an `ERROR:` body; null on success. */
export function toolResultError(resultMsg: RunMessage | null | undefined): string | null {
  if (!resultMsg) return null;
  const metadata = resultMsg.metadata || {};
  if (typeof metadata.error === "string" && metadata.error) return metadata.error;
  const content = resultMsg.payload?.content;
  if (typeof content !== "string") return null;
  const body = stripRemainingToolCalls(content).trim();
  if (body.startsWith("ERROR:")) {
    const firstLine = body.slice("ERROR:".length).trim().split("\n")[0];
    return firstLine || "error";
  }
  return null;
}

function friendlyNoteChange(args: ToolArguments): string {
  if (args.action === "create") return args.key ? `Propose note ${args.key}` : "Propose note";
  if (args.action === "delete") return "Propose deleting a note";
  return "Propose note edit";
}

function friendlyTableChange(args: ToolArguments): string {
  if (args.action === "create") return args.name ? `Propose table ${args.name}` : "Propose table";
  if (args.action === "delete") {
    return args.collection ? `Propose deleting ${args.collection}` : "Propose deleting a table";
  }
  return args.collection ? `Propose changes to ${args.collection}` : "Propose table changes";
}

function friendlyRoutineChange(args: ToolArguments): string {
  const handle = args.agent_id || args.agent_name;
  if (args.action === "create") return handle ? `Propose routine for ${handle}` : "Propose routine";
  if (args.action === "delete") return "Propose deleting a routine";
  return "Propose routine changes";
}

/** A short human summary of a tool call, such as "Find notes thesis"; empty when nothing useful fits. */
export function friendlyToolCall(call: ToolCallRequest | null | undefined): string {
  const name = call?.function?.name || "tool";
  const args = parseToolArgs(call?.function?.arguments);
  if (name === "studio_get_agent_context") {
    const handle = args.agent_id || args.target_agent_id || args.agent_name;
    return handle ? `Inspect ${handle}` : "Inspect agent context";
  }
  if (name === "studio_create_task_draft" || name === "studio_propose_draft") {
    const handle = args.agent_id || args.target_agent_id || args.agent_name;
    return handle ? `Draft task for ${handle}` : "Propose task draft";
  }
  if (name === "studio_publish_draft") return "Publish task draft";
  if (name === "studio_get_guild") return "Read guild description";
  if (name === "studio_list_guilds") return "Read other guilds";
  if (name === "studio_edit_memory") {
    const handle = args.agent_id || args.agent_name;
    return handle ? `Propose Memory edit for ${handle}` : "Propose Memory edit";
  }
  if (name === "studio_edit_note") return friendlyNoteChange(args);
  if (name === "studio_edit_guild") return "Propose guild description edit";
  if (name === "studio_list_collections") return "List tables";
  if (name === "studio_get_collection") {
    return args.collection ? `Read table ${args.collection}` : "Read table";
  }
  if (name === "studio_edit_collection") return friendlyTableChange(args);
  if (name === "studio_edit_routine") return friendlyRoutineChange(args);
  if (name === "studio_inspect_history") return "Inspect run history";
  if (name === "studio_get_script") {
    return args.name ? `Read script ${args.name}` : "Read script";
  }
  if (name === "studio_get_agent_access") {
    const handle = args.agent_id || args.agent_name;
    return handle ? `Inspect access for ${handle}` : "Inspect agent access";
  }
  if (name === "studio_request_connection_access") return "Request connection access";
  if (name === "studio_call_connection_tool") {
    return args.tool ? `Read via ${args.tool}` : "Read via connection";
  }
  if (name === "builder_list_capabilities") return "List capabilities";
  if (name === "builder_search_capabilities") {
    return args.query ? `Search capabilities ${args.query}` : "Search capabilities";
  }
  if (name === "builder_describe_server") {
    return args.server_ref ? `Describe ${args.server_ref}` : "Describe connector";
  }
  if (name === "builder_write_recipe") return "Write recipe";
  if (name === "builder_validate_recipe") return "Validate recipe";
  if (name === "artifact_find") {
    return args.query ? `Find ${args.query}` : "Find artifacts";
  }
  if (name === "note_find") {
    return args.query ? `Find notes ${args.query}` : "Find notes";
  }
  if (name === "record_search") {
    const scope = args.collection ? `Search ${args.collection}` : "Search records";
    return args.query ? `${scope} ${args.query}` : scope;
  }
  if (name === "record_list") {
    return `List ${args.collection || "records"}`;
  }
  if (name === "record_add") {
    return `Add to ${args.collection || "records"}`;
  }
  if (name === "record_update") {
    return args.collection && args.id !== undefined
      ? `Update ${args.collection}/${args.id}`
      : "Update record";
  }
  if (name === "record_remove") {
    return args.collection && args.id !== undefined
      ? `Remove ${args.collection}/${args.id}`
      : "Remove record";
  }
  if (name === "artifact_get") {
    return args.path ? `Get ${args.path}` : "Get artifact";
  }
  if (name === "note_get") {
    return args.path ? `Get ${args.path}` : "Get note";
  }
  if (name === "note_write") {
    return args.key ? `Wrote ${args.key}` : "Wrote note";
  }
  if (name === "artifact_delete") {
    return args.path ? `Delete ${args.path}` : "Delete artifact";
  }
  if (name === "note_delete") {
    return args.path ? `Delete ${args.path}` : "Delete note";
  }
  if (name === "file_find") {
    return args.query ? `Find files ` : "Find files";
  }
  if (name === "file_fetch") {
    return args.path ? `Fetch ` : "Fetch file";
  }
  if (name === "file_put") {
    return args.home_path ? `Shared ` : "Shared file";
  }
  if (name === "file_delete") {
    return args.path ? `Delete ` : "Delete file";
  }
  if (name === "note_read") {
    return args.path ? `Read ${args.path}` : "Read note";
  }
  if (name === "note_list") {
    return args.scope ? `List ${args.scope} notes` : "List notes";
  }
  if (name === "memory_write") return "Write memory";
  if (name === "secret_store") {
    return args.name ? `Stored ${args.name}` : "Stored a secret";
  }
  if (name === "secret_request") {
    return args.name ? `Asked for ${args.name}` : "Asked for a secret";
  }
  if (name === "group_post") return "Post to group";
  if (name === "report_issue") {
    return args.summary ? `Report: ${args.summary}` : "Report issue";
  }
  if (name === "browse") {
    return args.start ? `Browse from ${args.start}` : "Browse";
  }
  if (name === "browser_navigate") {
    return args.url ? `Open ${args.url}` : "Open page";
  }
  if (name === "browser_snapshot") return "Read page snapshot";
  if (name === "browser_click") return "Click element";
  if (name === "browser_type") return "Type text";
  if (name === "browser_fill") return "Fill form";
  if (name === "browser_scroll") {
    return args.direction ? `Scroll ${args.direction}` : "Scroll page";
  }
  if (name === "browser_screenshot") return "Take screenshot";
  if (name === "browser_eval") return "Run page script";
  if (name === "shell") {
    const command = firstCommandLine(args.command);
    return command ? `${args.background === true ? "Start" : "Run"} ${command}` : "Run command";
  }
  if (name === "code_task") {
    const where = typeof args.repo === "string" && args.repo ? ` in ${args.repo}` : "";
    return `${args.session_id ? "Resume code task" : "Code task"}${where}`;
  }
  if (name === "shell_status") {
    if (typeof args.id !== "string" || !args.id) return "List background commands";
    return args.stop === true ? `Stop ${args.id}` : `Check ${args.id}`;
  }
  if (name === "file_read") {
    if (!args.path) return "Read file";
    const from = Number(args.offset);
    return Number.isInteger(from) && from > 1
      ? `Read ${args.path} from line ${from}`
      : `Read ${args.path}`;
  }
  if (name === "code_search") {
    const where = args.path ? ` in ${args.path}` : "";
    const how = args.mode === "content" ? "Search lines" : "Search files";
    return args.pattern ? `${how} "${args.pattern}"${where}` : how;
  }
  if (name === "script_run") {
    return args.name ? `Run ${args.name}` : "Run script";
  }
  if (name === "script_create") {
    return args.name ? `Write ${args.name}` : "Write script";
  }
  if (name === "tavily_search") {
    return args.query ? `Search: "${args.query}"` : "Search web";
  }
  if (name === "twitterapiio_search") {
    return args.query ? `Search X: "${args.query}"` : "Search X";
  }
  if (name === "twitterapiio_user") {
    return args.user ? `X profile ${args.user}` : "X profile";
  }
  if (name === "twitterapiio_posts") {
    return args.user ? `X posts ${args.user}` : "X posts";
  }
  if (name === "twitterapiio_post") {
    return args.id ? `X post ${args.id}` : "X post";
  }
  if (name === "twitterapiio_followers") {
    return args.user ? `X followers ${args.user}` : "X followers";
  }
  if (name === "twitterapiio_following") {
    return args.user ? `X following ${args.user}` : "X following";
  }
  if (name === "twitterapiio_mentions") {
    return args.user ? `X mentions ${args.user}` : "X mentions";
  }
  if (name === "twitterapiio_replies") {
    return args.id ? `X replies ${args.id}` : "X replies";
  }
  if (name === "twitterapiio_quotes") {
    return args.id ? `X quotes ${args.id}` : "X quotes";
  }
  if (name === "twitterapiio_trends") {
    return "X trends";
  }
  const argKeys = Object.keys(args);
  const onlyKey = argKeys.length === 1 ? argKeys[0] : undefined;
  const onlyValue = onlyKey === undefined ? undefined : args[onlyKey];
  if (typeof onlyValue === "string" && onlyValue.length < 40) {
    return `${onlyKey}: ${onlyValue}`;
  }
  return "";
}

function firstCommandLine(command: unknown): string {
  if (typeof command !== "string") return "";
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Calls that share a leading verb, such as "Read" over two paths. */
type CallGroup = { verb: string; objects: string[] };

/** Adds a call's summary to the last group when it opens with the same verb, else starts a group. */
function groupSummary(groups: CallGroup[], summary: string): void {
  const [verb = "", ...rest] = summary.split(" ");
  const object = rest.join(" ");
  const last = groups.at(-1);
  if (last?.verb !== verb) {
    groups.push({ verb, objects: object ? [object] : [] });
    return;
  }
  if (object && !last.objects.includes(object)) last.objects.push(object);
}

/** What a batch of calls did, in one line, such as "Read a.md, b.md · Run ls"; a call with no friendly summary reads as its tool name. */
export function summarizeCalls(calls: readonly (ToolCallRequest | null | undefined)[]): string {
  const groups: CallGroup[] = [];
  for (const call of calls) {
    groupSummary(groups, friendlyToolCall(call) || String(call?.function?.name || "tool"));
  }
  return groups
    .map(({ verb, objects }) => [verb, objects.join(", ")].filter(Boolean).join(" "))
    .join(" · ");
}

const CODE_TASK_STATUSES: Readonly<Record<string, string>> = Object.freeze({
  completed: "completed",
  failed: "failed",
  timed_out: "timed out",
  cancelled: "cancelled",
  interrupted: "interrupted",
});

/** A code task's status in words, such as "timed out"; empty for anything else. */
export function codeTaskStatus(status: unknown): string {
  return typeof status === "string" && Object.hasOwn(CODE_TASK_STATUSES, status)
    ? (CODE_TASK_STATUSES[status] ?? "")
    : "";
}

/** A code task's diffstat from its metadata, such as "2 files · +14 −3"; empty before it has one. */
export function codeTaskChanges(metadata: Record<string, unknown>): string {
  const { files_changed: files, insertions, deletions } = metadata;
  if (typeof files !== "number") return "";
  return diffstat({
    files_changed: files,
    insertions: typeof insertions === "number" ? insertions : 0,
    deletions: typeof deletions === "number" ? deletions : 0,
  });
}

/**
 * What a code tool's result metadata says at a glance: a command's non-zero exit code, the step
 * a repeated read points back to, or how a code task ended and what it changed; empty otherwise.
 */
export function toolOutcome(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata) return "";
  if (metadata.tool_name === "browse") return browseOutcome(metadata);
  if (metadata.tool_name === "code_task") {
    const status = codeTaskStatus(metadata.status);
    return [status === "completed" ? "" : status, codeTaskChanges(metadata)]
      .filter(Boolean)
      .join(" · ");
  }
  if (typeof metadata.repeat_of === "number") return `unchanged since step ${metadata.repeat_of}`;
  if (metadata.tool_name === "shell") {
    if (metadata.timed_out === true) return "timed out";
    const code = metadata.exit_code;
    if (typeof code === "number" && code !== 0) return `exit ${code}`;
  }
  return "";
}

/** A browse call's status when it did not complete, and what it spent. */
function browseOutcome(metadata: Record<string, unknown>): string {
  const status = typeof metadata.status === "string" && metadata.status !== "complete" ? metadata.status : "";
  const usage = metadata.browser_usage;
  const cost =
    usage && typeof usage === "object" && "cost_usd" in usage ? formatCost(usage.cost_usd) : "";
  return [status.replaceAll("_", " "), cost].filter(Boolean).join(" · ");
}

/** A compact duration: "9ms", "1.2s", "12s", "2m 05s"; empty for negative or non-numeric input. */
export function formatDuration(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** A compact token count: "950", "3.1k", "41k", "1.2M"; empty for negative or non-numeric input. */
export function formatTokens(count: unknown): string {
  const value = Number(count);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** A dollar cost: "$0", four decimals under a cent, two otherwise; empty for non-numeric input. */
export function formatCost(usd: unknown): string {
  const value = Number(usd);
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Text collapsed to one line and cut to `max` characters with an ellipsis. */
export function previewText(text: unknown, max = 120): string {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}
