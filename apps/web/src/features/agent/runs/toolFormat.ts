import type {
  StepMessage,
  StepMetadata,
  StudioToolArguments,
  ToolCall,
} from "../../../api/types/runs";
import {
  isBrowseArguments,
  isBrowserToolArguments,
  isBuilderToolArguments,
  isCodeSearchArguments,
  isCodeTaskArguments,
  isConnectorToolArguments,
  isFileReadArguments,
  isFileToolArguments,
  isJsonObject,
  isNamedToolArguments,
  isNoteToolArguments,
  isRecordToolArguments,
  isReportIssueArguments,
  isShellArguments,
  isShellStatusArguments,
  isString,
  isStudioToolArguments,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../../../api/wire";
import { formatCost } from "../../../app/format";
import { diffstat } from "../chat/changes";

/** A JSON value with structure, an object or an array: what shows as a tree. */
export type JsonTreeValue = JsonObject | JsonValue[];

/** A call's arguments ready to show: pretty JSON, the raw text, or an empty notice. */
export type ToolArgsInfo = {
  isEmpty: boolean;
  text: string;
  parsed: JsonTreeValue | null;
};

/** A call's result ready to show: pretty JSON when the body is a JSON object or array, the raw text otherwise. */
export type ReturnedDataInfo =
  | { isJson: true; isEmpty: false; text: string; raw: JsonTreeValue }
  | { isJson: false; isEmpty: boolean; text: string; raw: string };

const REMAINING_TOOL_CALLS_RE = /\n\nremaining_tool_calls: \d+\s*$/;

/** Removes the tool-budget stamp the orchestrator appends to the end of a tool result. */
export function stripRemainingToolCalls(content: string): string {
  return content.replace(REMAINING_TOOL_CALLS_RE, "");
}

/** Whether a JSON value has structure: an object or an array. */
function isJsonTree(value: JsonValue | undefined): value is JsonTreeValue {
  return Array.isArray(value) || isJsonObject(value);
}

/** A call's arguments, the JSON text the model wrote, as an object; empty when the text holds none. */
export function parseToolArgs(text: ToolCall["function"]["arguments"]): JsonObject {
  const value = parseJson(text);
  return isJsonObject(value) ? value : {};
}

const NO_ARGUMENTS: ToolArgsInfo = { isEmpty: true, text: "No arguments provided.", parsed: null };

/** Formats a call's arguments for display, noting when there are none. */
export function formatToolArgs(text: ToolCall["function"]["arguments"]): ToolArgsInfo {
  if (!text) return NO_ARGUMENTS;
  const value = parseJson(text);
  if (!isJsonTree(value)) return { isEmpty: false, text, parsed: null };
  if (Object.keys(value).length === 0) return { ...NO_ARGUMENTS, parsed: value };
  return { isEmpty: false, text: JSON.stringify(value, null, 2), parsed: value };
}

/** Formats a call's result for display, pretty-printing bodies that are JSON objects or arrays. */
export function formatReturnedData(content: string): ReturnedDataInfo {
  const trimmed = content.trim();
  if (!trimmed) {
    return { isJson: false, isEmpty: true, text: "(Empty response)", raw: content };
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    const parsed = parseJson(trimmed);
    if (isJsonTree(parsed)) {
      return { isJson: true, isEmpty: false, text: JSON.stringify(parsed, null, 2), raw: parsed };
    }
  }
  return { isJson: false, isEmpty: false, text: content, raw: content };
}

/** The error a recorded tool result carries: its `error` metadata, else the first line of an `ERROR:` body; null on success. */
export function toolResultError(resultMsg: StepMessage | null): string | null {
  if (!resultMsg) return null;
  if (resultMsg.metadata.error) return resultMsg.metadata.error;
  const body = stripRemainingToolCalls(resultMsg.payload.content).trim();
  if (body.startsWith("ERROR:")) {
    const firstLine = body.slice("ERROR:".length).trim().split("\n")[0];
    return firstLine || "error";
  }
  return null;
}

function friendlyNoteChange(args: StudioToolArguments): string {
  if (args.action === "create") return args.key ? `Propose note ${args.key}` : "Propose note";
  if (args.action === "delete") return "Propose deleting a note";
  return "Propose note edit";
}

function friendlyTableChange(args: StudioToolArguments): string {
  if (args.action === "create") return args.name ? `Propose table ${args.name}` : "Propose table";
  if (args.action === "delete") {
    return args.collection ? `Propose deleting ${args.collection}` : "Propose deleting a table";
  }
  return args.collection ? `Propose changes to ${args.collection}` : "Propose table changes";
}

function friendlyRoutineChange(args: StudioToolArguments): string {
  const handle = args.agent_id || args.agent_name;
  if (args.action === "create") return handle ? `Propose routine for ${handle}` : "Propose routine";
  if (args.action === "delete") return "Propose deleting a routine";
  return "Propose routine changes";
}

/** How one tool's calls read in a few words, from their arguments; empty when nothing useful fits. */
type CallSummary = (args: JsonObject) => string;

/**
 * A tool's summary, written from arguments of the shape the tool's schema gives them; arguments of
 * another shape read as nothing.
 */
function summaryOf<A extends JsonObject>(
  accepts: (args: JsonObject) => args is A,
  summarize: (args: A) => string,
): CallSummary {
  return (args) => (accepts(args) ? summarize(args) : "");
}

/** The agent a Studio call names: by id, by the target it addresses, or by name. */
function studioTarget(args: StudioToolArguments): string | undefined {
  return args.agent_id || args.target_agent_id || args.agent_name;
}

function friendlyTaskDraft(args: StudioToolArguments): string {
  const handle = studioTarget(args);
  return handle ? `Draft task for ${handle}` : "Propose task draft";
}

/** The agent a call names, by id or by name. */
function namedAgent(args: StudioToolArguments): string | undefined {
  return args.agent_id || args.agent_name;
}

const CALL_SUMMARIES: Readonly<Record<string, CallSummary>> = Object.freeze({
  studio_get_agent_context: summaryOf(isStudioToolArguments, (args) => {
    const handle = studioTarget(args);
    return handle ? `Inspect ${handle}` : "Inspect agent context";
  }),
  studio_create_task_draft: summaryOf(isStudioToolArguments, friendlyTaskDraft),
  studio_propose_draft: summaryOf(isStudioToolArguments, friendlyTaskDraft),
  studio_publish_draft: () => "Publish task draft",
  studio_get_guild: () => "Read guild description",
  studio_list_guilds: () => "Read other guilds",
  studio_edit_memory: summaryOf(isStudioToolArguments, (args) => {
    const handle = namedAgent(args);
    return handle ? `Propose Memory edit for ${handle}` : "Propose Memory edit";
  }),
  studio_edit_note: summaryOf(isStudioToolArguments, friendlyNoteChange),
  studio_edit_guild: () => "Propose guild description edit",
  studio_list_collections: () => "List tables",
  studio_get_collection: summaryOf(isStudioToolArguments, (args) =>
    args.collection ? `Read table ${args.collection}` : "Read table",
  ),
  studio_edit_collection: summaryOf(isStudioToolArguments, friendlyTableChange),
  studio_edit_routine: summaryOf(isStudioToolArguments, friendlyRoutineChange),
  studio_inspect_history: () => "Inspect run history",
  studio_get_script: summaryOf(isStudioToolArguments, (args) =>
    args.name ? `Read script ${args.name}` : "Read script",
  ),
  studio_get_agent_access: summaryOf(isStudioToolArguments, (args) => {
    const handle = namedAgent(args);
    return handle ? `Inspect access for ${handle}` : "Inspect agent access";
  }),
  studio_request_connection_access: () => "Request connection access",
  studio_call_connection_tool: summaryOf(isStudioToolArguments, (args) =>
    args.tool ? `Read via ${args.tool}` : "Read via connection",
  ),
  builder_list_capabilities: () => "List capabilities",
  builder_search_capabilities: summaryOf(isBuilderToolArguments, (args) =>
    args.query ? `Search capabilities ${args.query}` : "Search capabilities",
  ),
  builder_describe_server: summaryOf(isBuilderToolArguments, (args) =>
    args.server_ref ? `Describe ${args.server_ref}` : "Describe connector",
  ),
  builder_write_recipe: () => "Write recipe",
  builder_validate_recipe: () => "Validate recipe",
  artifact_find: summaryOf(isNoteToolArguments, (args) =>
    args.query ? `Find ${args.query}` : "Find artifacts",
  ),
  note_find: summaryOf(isNoteToolArguments, (args) =>
    args.query ? `Find notes ${args.query}` : "Find notes",
  ),
  record_search: summaryOf(isRecordToolArguments, (args) => {
    const scope = args.collection ? `Search ${args.collection}` : "Search records";
    return args.query ? `${scope} ${args.query}` : scope;
  }),
  record_list: summaryOf(isRecordToolArguments, (args) => `List ${args.collection || "records"}`),
  record_add: summaryOf(isRecordToolArguments, (args) => `Add to ${args.collection || "records"}`),
  record_update: summaryOf(isRecordToolArguments, (args) =>
    args.collection && args.id !== undefined
      ? `Update ${args.collection}/${args.id}`
      : "Update record",
  ),
  record_remove: summaryOf(isRecordToolArguments, (args) =>
    args.collection && args.id !== undefined
      ? `Remove ${args.collection}/${args.id}`
      : "Remove record",
  ),
  artifact_get: summaryOf(isNoteToolArguments, (args) =>
    args.path ? `Get ${args.path}` : "Get artifact",
  ),
  note_get: summaryOf(isNoteToolArguments, (args) => (args.path ? `Get ${args.path}` : "Get note")),
  note_write: summaryOf(isNoteToolArguments, (args) =>
    args.key ? `Wrote ${args.key}` : "Wrote note",
  ),
  artifact_delete: summaryOf(isNoteToolArguments, (args) =>
    args.path ? `Delete ${args.path}` : "Delete artifact",
  ),
  note_delete: summaryOf(isNoteToolArguments, (args) =>
    args.path ? `Delete ${args.path}` : "Delete note",
  ),
  file_find: summaryOf(isFileToolArguments, (args) => (args.query ? `Find files ` : "Find files")),
  file_fetch: summaryOf(isFileToolArguments, (args) => (args.path ? `Fetch ` : "Fetch file")),
  file_put: summaryOf(isFileToolArguments, (args) => (args.home_path ? `Shared ` : "Shared file")),
  file_delete: summaryOf(isFileToolArguments, (args) => (args.path ? `Delete ` : "Delete file")),
  note_read: summaryOf(isNoteToolArguments, (args) =>
    args.path ? `Read ${args.path}` : "Read note",
  ),
  note_list: summaryOf(isNoteToolArguments, (args) =>
    args.scope ? `List ${args.scope} notes` : "List notes",
  ),
  memory_write: () => "Write memory",
  secret_store: summaryOf(isNamedToolArguments, (args) =>
    args.name ? `Stored ${args.name}` : "Stored a secret",
  ),
  secret_request: summaryOf(isNamedToolArguments, (args) =>
    args.name ? `Asked for ${args.name}` : "Asked for a secret",
  ),
  group_post: () => "Post to group",
  report_issue: summaryOf(isReportIssueArguments, (args) =>
    args.summary ? `Report: ${args.summary}` : "Report issue",
  ),
  browse: summaryOf(isBrowseArguments, (args) =>
    args.start ? `Browse from ${args.start}` : "Browse",
  ),
  browser_navigate: summaryOf(isBrowserToolArguments, (args) =>
    args.url ? `Open ${args.url}` : "Open page",
  ),
  browser_snapshot: () => "Read page snapshot",
  browser_click: () => "Click element",
  browser_type: () => "Type text",
  browser_fill: () => "Fill form",
  browser_scroll: summaryOf(isBrowserToolArguments, (args) =>
    args.direction ? `Scroll ${args.direction}` : "Scroll page",
  ),
  browser_screenshot: () => "Take screenshot",
  browser_eval: () => "Run page script",
  shell: summaryOf(isShellArguments, (args) => {
    const command = firstCommandLine(args.command ?? "");
    return command ? `${args.background === true ? "Start" : "Run"} ${command}` : "Run command";
  }),
  code_task: summaryOf(isCodeTaskArguments, (args) => {
    const where = args.repo ? ` in ${args.repo}` : "";
    return `${args.session_id ? "Resume code task" : "Code task"}${where}`;
  }),
  shell_status: summaryOf(isShellStatusArguments, (args) => {
    if (!args.id) return "List background commands";
    return args.stop === true ? `Stop ${args.id}` : `Check ${args.id}`;
  }),
  file_read: summaryOf(isFileReadArguments, (args) => {
    if (!args.path) return "Read file";
    const from = args.offset ?? 0;
    return Number.isInteger(from) && from > 1
      ? `Read ${args.path} from line ${from}`
      : `Read ${args.path}`;
  }),
  code_search: summaryOf(isCodeSearchArguments, (args) => {
    const where = args.path ? ` in ${args.path}` : "";
    const how = args.mode === "content" ? "Search lines" : "Search files";
    return args.pattern ? `${how} "${args.pattern}"${where}` : how;
  }),
  script_run: summaryOf(isNamedToolArguments, (args) =>
    args.name ? `Run ${args.name}` : "Run script",
  ),
  script_create: summaryOf(isNamedToolArguments, (args) =>
    args.name ? `Write ${args.name}` : "Write script",
  ),
  tavily_search: summaryOf(isConnectorToolArguments, (args) =>
    args.query ? `Search: "${args.query}"` : "Search web",
  ),
  twitterapiio_search: summaryOf(isConnectorToolArguments, (args) =>
    args.query ? `Search X: "${args.query}"` : "Search X",
  ),
  twitterapiio_user: summaryOf(isConnectorToolArguments, (args) =>
    args.user ? `X profile ${args.user}` : "X profile",
  ),
  twitterapiio_posts: summaryOf(isConnectorToolArguments, (args) =>
    args.user ? `X posts ${args.user}` : "X posts",
  ),
  twitterapiio_post: summaryOf(isConnectorToolArguments, (args) =>
    args.id ? `X post ${args.id}` : "X post",
  ),
  twitterapiio_followers: summaryOf(isConnectorToolArguments, (args) =>
    args.user ? `X followers ${args.user}` : "X followers",
  ),
  twitterapiio_following: summaryOf(isConnectorToolArguments, (args) =>
    args.user ? `X following ${args.user}` : "X following",
  ),
  twitterapiio_mentions: summaryOf(isConnectorToolArguments, (args) =>
    args.user ? `X mentions ${args.user}` : "X mentions",
  ),
  twitterapiio_replies: summaryOf(isConnectorToolArguments, (args) =>
    args.id ? `X replies ${args.id}` : "X replies",
  ),
  twitterapiio_quotes: summaryOf(isConnectorToolArguments, (args) =>
    args.id ? `X quotes ${args.id}` : "X quotes",
  ),
  twitterapiio_trends: () => "X trends",
});

/** A call with one short text argument, as `key: value`; empty for any other call. */
function onlyArgumentSummary(args: JsonObject): string {
  const argKeys = Object.keys(args);
  const onlyKey = argKeys.length === 1 ? argKeys[0] : undefined;
  const onlyValue = onlyKey === undefined ? undefined : args[onlyKey];
  if (isString(onlyValue) && onlyValue.length < 40) {
    return `${onlyKey}: ${onlyValue}`;
  }
  return "";
}

/** A short human summary of a tool call, such as "Find notes thesis"; empty when nothing useful fits. */
export function friendlyToolCall(call: ToolCall): string {
  const name = call.function.name || "tool";
  const args = parseToolArgs(call.function.arguments);
  const summary = Object.hasOwn(CALL_SUMMARIES, name) ? CALL_SUMMARIES[name] : undefined;
  return summary ? summary(args) : onlyArgumentSummary(args);
}

function firstCommandLine(command: string): string {
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
export function summarizeCalls(calls: readonly ToolCall[]): string {
  const groups: CallGroup[] = [];
  for (const call of calls) {
    groupSummary(groups, friendlyToolCall(call) || call.function.name || "tool");
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
export function codeTaskStatus(status: StepMetadata["status"]): string {
  return status !== undefined && Object.hasOwn(CODE_TASK_STATUSES, status)
    ? (CODE_TASK_STATUSES[status] ?? "")
    : "";
}

/** A code task's diffstat from its metadata, such as "2 files · +14 −3"; empty before it has one. */
export function codeTaskChanges(metadata: StepMetadata): string {
  const { files_changed: files, insertions, deletions } = metadata;
  if (files === undefined) return "";
  return diffstat({ files_changed: files, insertions: insertions ?? 0, deletions: deletions ?? 0 });
}

/**
 * What a code tool's result metadata says at a glance: a command's non-zero exit code, the step
 * a repeated read points back to, or how a code task ended and what it changed; empty otherwise.
 */
export function toolOutcome(metadata: StepMetadata | undefined): string {
  if (!metadata) return "";
  if (metadata.tool_name === "browse") return browseOutcome(metadata);
  if (metadata.tool_name === "code_task") {
    const status = codeTaskStatus(metadata.status);
    return [status === "completed" ? "" : status, codeTaskChanges(metadata)]
      .filter(Boolean)
      .join(" · ");
  }
  if (metadata.repeat_of !== undefined) return `unchanged since step ${metadata.repeat_of}`;
  if (metadata.tool_name === "shell") {
    if (metadata.timed_out === true) return "timed out";
    const code = metadata.exit_code;
    if (code !== undefined && code !== null && code !== 0) return `exit ${code}`;
  }
  return "";
}

/** A browse call's status when it did not complete, and what it spent. */
function browseOutcome(metadata: StepMetadata): string {
  const status = metadata.status && metadata.status !== "complete" ? metadata.status : "";
  const usage = metadata.browser_usage;
  const cost = usage ? formatCost(usage.cost_usd) : "";
  return [status.replaceAll("_", " "), cost].filter(Boolean).join(" · ");
}

/** A compact duration: "9ms", "1.2s", "12s", "2m 05s"; empty for a negative or non-finite one. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** A compact token count: "950", "3.1k", "41k", "1.2M"; empty for a negative or non-finite one. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Text collapsed to one line and cut to `max` characters with an ellipsis. */
export function previewText(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}
