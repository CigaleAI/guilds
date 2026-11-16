import { Type, type Static } from "typebox";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, JsonObjectSchema } from "../lib/json.js";

// Claude Code's `stream-json` events, as its driver logs them in `runtime/guilds-harness`: each
// line one event. A subscription agent's run keeps two kinds as rows, an assistant message and
// the results of its tools; every other event, and every block of another shape, is dropped.

const TextBlock = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ToolUseBlock = Type.Object({
  type: Type.Literal("tool_use"),
  id: Type.String(),
  name: Type.String(),
  input: JsonObjectSchema,
});
const ToolResultBlock = Type.Object({
  type: Type.Literal("tool_result"),
  tool_use_id: Type.String(),
  content: Type.Optional(Type.Unknown()),
});

/** A piece of text in a message of Claude Code's. */
export type ClaudeCodeText = Static<typeof TextBlock>;

/** A call Claude Code made of one of its own tools: its id, the tool, and its input. */
export type ClaudeCodeToolUse = Static<typeof ToolUseBlock>;

/** What one of Claude Code's tools returned for the call `tool_use_id` names; `output` is null when it is not text. */
export type ClaudeCodeToolResult = { tool_use_id: string; output: string | null };

/** A message Claude Code wrote: its text and its calls of its own tools, in order. */
export type ClaudeCodeMessage = {
  type: "assistant";
  content: Array<ClaudeCodeText | ClaudeCodeToolUse>;
};

/** The results of Claude Code's tools, which it hands back to its model as a user turn. */
export type ClaudeCodeToolResults = { type: "user"; results: ClaudeCodeToolResult[] };

/** An event of Claude Code's that a run keeps as rows. */
export type ClaudeCodeEvent = ClaudeCodeMessage | ClaudeCodeToolResults;

/** The blocks of an event's `message.content`; none when the event carries no list there. */
function contentBlocks(event: unknown): unknown[] {
  const message = isJsonObject(event) ? event.message : undefined;
  const content = isJsonObject(message) ? message.content : undefined;
  return Array.isArray(content) ? content : [];
}

function messageBlock(block: unknown): ClaudeCodeText | ClaudeCodeToolUse | null {
  if (!isJsonObject(block)) {
    return null;
  }
  return keepMatching(TextBlock, block) ?? keepMatching(ToolUseBlock, block);
}

function toolResult(block: unknown): ClaudeCodeToolResult | null {
  const result = isJsonObject(block) ? keepMatching(ToolResultBlock, block) : null;
  if (result === null) {
    return null;
  }
  return {
    tool_use_id: result.tool_use_id,
    output: typeof result.content === "string" ? result.content : null,
  };
}

/** The event one line of the log holds; null for a line that is not JSON or an event the run keeps no row of. */
function parseEvent(line: string): ClaudeCodeEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const kind = isJsonObject(event) ? event.type : undefined;
  if (kind === "assistant") {
    return {
      type: "assistant",
      content: contentBlocks(event).flatMap((block) => messageBlock(block) ?? []),
    };
  }
  if (kind === "user") {
    return {
      type: "user",
      results: contentBlocks(event).flatMap((block) => toolResult(block) ?? []),
    };
  }
  return null;
}

/** The events of Claude Code's `stream-json` lines in `raw` that a run keeps as rows, in order. */
export function parseClaudeCodeEvents(raw: string): ClaudeCodeEvent[] {
  return raw.split("\n").flatMap((line) => (line.trim() ? (parseEvent(line) ?? []) : []));
}
