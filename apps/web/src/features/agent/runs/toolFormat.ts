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

/** How one tool's calls read in a few words, from their arguments. */
type CallSummary = (args: ToolArguments) => string;

/** The agent a Studio call names: by id, by the target it addresses, or by name. */
function studioTarget(args: ToolArguments): JsonValue | undefined {
  return args.agent_id || args.target_agent_id || args.agent_name;
}

function friendlyTaskDraft(args: ToolArguments): string {
  const handle = studioTarget(args);
  return handle ? `Draft task for ${handle}` : "Propose task draft";
}

/** The agent a call names, by id or by name. */
function namedAgent(args: ToolArguments): JsonValue | undefined {
  return args.agent_id || args.agent_name;
}

const CALL_SUMMARIES: Readonly<Record<string, CallSummary>> = Object.freeze({
  studio_get_agent_context: (args) => {
    const handle = studioTarget(args);
    return handle ? `Inspect ${handle}` : "Inspect agent context";
  },
  studio_create_task_draft: friendlyTaskDraft,
  studio_propose_draft: friendlyTaskDraft,
  studio_publish_draft: () => "Publish task draft",
  studio_get_guild: () => "Read guild description",
  studio_list_guilds: () => "Read other guilds",
  studio_edit_memory: (args) => {
    const handle = namedAgent(args);
    return handle ? `Propose Memory edit for ${handle}` : "Propose Memory edit";
  },
  studio_edit_note: friendlyNoteChange,
  studio_edit_guild: () => "Propose guild description edit",
  studio_list_collections: () => "List tables",
  studio_get_collection: (args) =>
    args.collection ? `Read table ${args.collection}` : "Read table",
  studio_edit_collection: friendlyTableChange,
  studio_edit_routine: friendlyRoutineChange,
  studio_inspect_history: () => "Inspect run history",
  studio_get_script: (args) => (args.name ? `Read script ${args.name}` : "Read script"),
  studio_get_agent_access: (args) => {
    const handle = namedAgent(args);
    return handle ? `Inspect access for ${handle}` : "Inspect agent access";
  },
  studio_request_connection_access: () => "Request connection access",
  studio_call_connection_tool: (args) =>
    args.tool ? `Read via ${args.tool}` : "Read via connection",
  builder_list_capabilities: () => "List capabilities",
  builder_search_capabilities: (args) =>
    args.query ? `Search capabilities ${args.query}` : "Search capabilities",
  builder_describe_server: (args) =>
    args.server_ref ? `Describe ${args.server_ref}` : "Describe connector",
  builder_write_recipe: () => "Write recipe",
  builder_validate_recipe: () => "Validate recipe",
  artifact_find: (args) => (args.query ? `Find ${args.query}` : "Find artifacts"),
  note_find: (args) => (args.query ? `Find notes ${args.query}` : "Find notes"),
  record_search: (args) => {
    const scope = args.collection ? `Search ${args.collection}` : "Search records";
    return args.query ? `${scope} ${args.query}` : scope;
  },
  record_list: (args) => `List ${args.collection || "records"}`,
  record_add: (args) => `Add to ${args.collection || "records"}`,
  record_update: (args) =>
    args.collection && args.id !== undefined
      ? `Update ${args.collection}/${args.id}`
      : "Update record",
  record_remove: (args) =>
    args.collection && args.id !== undefined
      ? `Remove ${args.collection}/${args.id}`
      : "Remove record",
  artifact_get: (args) => (args.path ? `Get ${args.path}` : "Get artifact"),
  note_get: (args) => (args.path ? `Get ${args.path}` : "Get note"),
  note_write: (args) => (args.key ? `Wrote ${args.key}` : "Wrote note"),
  artifact_delete: (args) => (args.path ? `Delete ${args.path}` : "Delete artifact"),
  note_delete: (args) => (args.path ? `Delete ${args.path}` : "Delete note"),
  file_find: (args) => (args.query ? `Find files ` : "Find files"),
  file_fetch: (args) => (args.path ? `Fetch ` : "Fetch file"),
  file_put: (args) => (args.home_path ? `Shared ` : "Shared file"),
  file_delete: (args) => (args.path ? `Delete ` : "Delete file"),
  note_read: (args) => (args.path ? `Read ${args.path}` : "Read note"),
  note_list: (args) => (args.scope ? `List ${args.scope} notes` : "List notes"),
  memory_write: () => "Write memory",
  secret_store: (args) => (args.name ? `Stored ${args.name}` : "Stored a secret"),
  secret_request: (args) => (args.name ? `Asked for ${args.name}` : "Asked for a secret"),
  group_post: () => "Post to group",
  report_issue: (args) => (args.summary ? `Report: ${args.summary}` : "Report issue"),
  browse: (args) => (args.start ? `Browse from ${args.start}` : "Browse"),
  browser_navigate: (args) => (args.url ? `Open ${args.url}` : "Open page"),
  browser_snapshot: () => "Read page snapshot",
  browser_click: () => "Click element",
  browser_type: () => "Type text",
  browser_fill: () => "Fill form",
  browser_scroll: (args) => (args.direction ? `Scroll ${args.direction}` : "Scroll page"),
  browser_screenshot: () => "Take screenshot",
  browser_eval: () => "Run page script",
  shell: (args) => {
    const command = firstCommandLine(args.command);
    return command ? `${args.background === true ? "Start" : "Run"} ${command}` : "Run command";
  },
  code_task: (args) => {
    const where = typeof args.repo === "string" && args.repo ? ` in ${args.repo}` : "";
    return `${args.session_id ? "Resume code task" : "Code task"}${where}`;
  },
  shell_status: (args) => {
    if (typeof args.id !== "string" || !args.id) return "List background commands";
    return args.stop === true ? `Stop ${args.id}` : `Check ${args.id}`;
  },
  file_read: (args) => {
    if (!args.path) return "Read file";
    const from = Number(args.offset);
    return Number.isInteger(from) && from > 1
      ? `Read ${args.path} from line ${from}`
      : `Read ${args.path}`;
  },
  code_search: (args) => {
    const where = args.path ? ` in ${args.path}` : "";
    const how = args.mode === "content" ? "Search lines" : "Search files";
    return args.pattern ? `${how} "${args.pattern}"${where}` : how;
  },
  script_run: (args) => (args.name ? `Run ${args.name}` : "Run script"),
  script_create: (args) => (args.name ? `Write ${args.name}` : "Write script"),
  tavily_search: (args) => (args.query ? `Search: "${args.query}"` : "Search web"),
  twitterapiio_search: (args) => (args.query ? `Search X: "${args.query}"` : "Search X"),
  twitterapiio_user: (args) => (args.user ? `X profile ${args.user}` : "X profile"),
  twitterapiio_posts: (args) => (args.user ? `X posts ${args.user}` : "X posts"),
  twitterapiio_post: (args) => (args.id ? `X post ${args.id}` : "X post"),
  twitterapiio_followers: (args) => (args.user ? `X followers ${args.user}` : "X followers"),
  twitterapiio_following: (args) => (args.user ? `X following ${args.user}` : "X following"),
  twitterapiio_mentions: (args) => (args.user ? `X mentions ${args.user}` : "X mentions"),
  twitterapiio_replies: (args) => (args.id ? `X replies ${args.id}` : "X replies"),
  twitterapiio_quotes: (args) => (args.id ? `X quotes ${args.id}` : "X quotes"),
  twitterapiio_trends: () => "X trends",
});

/** A call with one short text argument, as `key: value`; empty for any other call. */
function onlyArgumentSummary(args: ToolArguments): string {
  const argKeys = Object.keys(args);
  const onlyKey = argKeys.length === 1 ? argKeys[0] : undefined;
  const onlyValue = onlyKey === undefined ? undefined : args[onlyKey];
  if (typeof onlyValue === "string" && onlyValue.length < 40) {
    return `${onlyKey}: ${onlyValue}`;
  }
  return "";
}

/** A short human summary of a tool call, such as "Find notes thesis"; empty when nothing useful fits. */
export function friendlyToolCall(call: ToolCallRequest | null | undefined): string {
  const name = call?.function?.name || "tool";
  const args = parseToolArgs(call?.function?.arguments);
  const summary =
    typeof name === "string" && Object.hasOwn(CALL_SUMMARIES, name)
      ? CALL_SUMMARIES[name]
      : undefined;
  return summary ? summary(args) : onlyArgumentSummary(args);
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
  const status =
    typeof metadata.status === "string" && metadata.status !== "complete" ? metadata.status : "";
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
