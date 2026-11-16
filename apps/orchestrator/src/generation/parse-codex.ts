import { Type, type Static } from "typebox";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, JsonObjectSchema } from "../lib/json.js";

// Codex's `exec --json` events, as its driver logs them in `runtime/guilds-harness`: each line one
// event about an item of the turn. A subscription agent's run keeps the items of two kinds as rows,
// a message of the agent's and a call of one of its tools, the call when it starts and again when it
// completes; every other event and item is dropped.

const AgentMessageItem = Type.Object({ id: Type.String(), type: Type.Literal("agent_message"), text: Type.String() });

const CommandItem = Type.Object({
  id: Type.String(),
  type: Type.Literal("command_execution"),
  command: Type.String(),
  aggregated_output: Type.Optional(Type.String()),
});

const FileChange = Type.Object({ path: Type.String(), kind: Type.Optional(Type.String()) });

const FileChangeItem = Type.Object({
  id: Type.String(),
  type: Type.Literal("file_change"),
  changes: Type.Array(FileChange),
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

/** A shell command Codex ran, with what it printed once it completed. */
export type CodexCommandItem = Static<typeof CommandItem>;

/** The files a patch of Codex's changed, each with how. */
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

/** An event of Codex's that a run keeps as rows. */
export type CodexEvent = CodexMessage | CodexToolStarted | CodexToolCompleted;

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

/** The event one line of the log holds; null for a line that is not JSON or an event the run keeps no row of. */
function parseEvent(line: string): CodexEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
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

/** The events of Codex's `--json` lines in `raw` that a run keeps as rows, in order. */
export function parseCodexEvents(raw: string): CodexEvent[] {
  return raw.split("\n").flatMap((line) => (line.trim() ? (parseEvent(line) ?? []) : []));
}
