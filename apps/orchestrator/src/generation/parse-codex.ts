import { Type, type Static } from "typebox";
import type { TokenUsage } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, JsonObjectSchema } from "../lib/json.js";

// Codex's `exec --json` events, as its driver logs them in `runtime/guilds-harness`: each line one
// event about an item of the turn. A subscription agent's run keeps the items of two kinds as rows,
// a message of the agent's and a call of one of its tools, the call when it starts and again when it
// completes, and reads the tokens its thread spent from `turn.completed`; every other event and item
// is dropped.

const AgentMessageItem = Type.Object({ id: Type.String(), type: Type.Literal("agent_message"), text: Type.String() });

/** How Codex says an item it ran ended: `completed`, `failed`, or, for a command it did not run, `declined`. */
const ItemStatus = Type.Optional(Type.String());

const CommandItem = Type.Object({
  id: Type.String(),
  type: Type.Literal("command_execution"),
  command: Type.String(),
  aggregated_output: Type.Optional(Type.String()),
  exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  status: ItemStatus,
});

const FileChange = Type.Object({ path: Type.String(), kind: Type.Optional(Type.String()) });

const FileChangeItem = Type.Object({
  id: Type.String(),
  type: Type.Literal("file_change"),
  changes: Type.Array(FileChange),
  status: ItemStatus,
});

const WebSearchItem = Type.Object({ id: Type.String(), type: Type.Literal("web_search"), query: Type.String() });

const McpContent = Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) });

const McpCallItem = Type.Object({
  id: Type.String(),
  type: Type.Literal("mcp_tool_call"),
  server: Type.String(),
  tool: Type.String(),
  arguments: Type.Optional(JsonObjectSchema),
  result: Type.Optional(Type.Union([Type.Object({ content: Type.Array(McpContent) }), Type.Null()])),
  error: Type.Optional(Type.Union([Type.Object({ message: Type.String() }), Type.Null()])),
});

/** The tokens `turn.completed` reports: the thread's, over every turn of it, its input counting the cache's. */
const TurnUsage = Type.Object({
  input_tokens: Type.Number(),
  output_tokens: Type.Number(),
  cached_input_tokens: Type.Optional(Type.Number()),
  cache_write_input_tokens: Type.Optional(Type.Number()),
});

/** A shell command Codex ran, with what it printed, its exit code, and how it ended once it completed. */
export type CodexCommandItem = Static<typeof CommandItem>;

/** The files a patch of Codex's changed, each with how, and whether the patch applied once it completed. */
export type CodexFileChangeItem = Static<typeof FileChangeItem>;

/** A web search Codex made. */
export type CodexWebSearchItem = Static<typeof WebSearchItem>;

/** A call Codex made of a tool of an MCP server, with its result or error once it completed. */
export type CodexMcpCallItem = Static<typeof McpCallItem>;

/** A call of one of Codex's tools: the item that names it, by the item's own id. */
export type CodexToolItem = CodexCommandItem | CodexFileChangeItem | CodexWebSearchItem | CodexMcpCallItem;

/** A message Codex wrote to the user. */
export type CodexMessage = { type: "message"; text: string };

/** A call of one of Codex's tools as it starts, before its result. */
export type CodexToolStarted = { type: "tool_started"; item: CodexToolItem };

/** A call of one of Codex's tools once it completed, with its result. */
export type CodexToolCompleted = { type: "tool_completed"; item: CodexToolItem };

/** The end of a turn: the tokens its thread spent so far, over every turn of the thread. */
export type CodexThreadUsage = { type: "thread_usage"; usage: TokenUsage };

/** An event of Codex's that a run keeps as rows, or reads its turn's usage from. */
export type CodexEvent = CodexMessage | CodexToolStarted | CodexToolCompleted | CodexThreadUsage;

const TOOL_ITEMS = [CommandItem, FileChangeItem, WebSearchItem, McpCallItem];

/** The tool call an item of an event is; null for an item of another kind or shape. */
function toolItem(item: unknown): CodexToolItem | null {
  if (!isJsonObject(item)) {
    return null;
  }
  for (const schema of TOOL_ITEMS) {
    const kept = keepMatching(schema, item);
    if (kept !== null) {
      return kept;
    }
  }
  return null;
}

/** The tokens of a `turn.completed` event's `usage`; null when it reports none. */
function threadUsage(usage: unknown): CodexThreadUsage | null {
  const reported = isJsonObject(usage) ? keepMatching(TurnUsage, usage) : null;
  if (reported === null) {
    return null;
  }
  const written = reported.cache_write_input_tokens;
  return {
    type: "thread_usage",
    usage: {
      input_tokens: reported.input_tokens,
      output_tokens: reported.output_tokens,
      cache_read_tokens: reported.cached_input_tokens ?? 0,
      ...(written === undefined ? {} : { cache_write_tokens: written }),
    },
  };
}

/** The event one line of the log holds; null for a line that is not JSON or an event the run keeps no row of. */
function parseEvent(line: string): CodexEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (isJsonObject(event) && event.type === "turn.completed") {
    return threadUsage(event.usage);
  }
  if (!isJsonObject(event) || !isJsonObject(event.item)) {
    return null;
  }
  const message = keepMatching(AgentMessageItem, event.item);
  if (event.type === "item.completed" && message !== null) {
    return { type: "message", text: message.text };
  }
  const item = toolItem(event.item);
  if (item === null) {
    return null;
  }
  if (event.type === "item.started") {
    return { type: "tool_started", item };
  }
  return event.type === "item.completed" ? { type: "tool_completed", item } : null;
}

/** The events of Codex's `--json` lines in `raw` that a run keeps as rows or reads its usage from, in order. */
export function parseCodexEvents(raw: string): CodexEvent[] {
  return raw.split("\n").flatMap((line) => (line.trim() ? (parseEvent(line) ?? []) : []));
}
