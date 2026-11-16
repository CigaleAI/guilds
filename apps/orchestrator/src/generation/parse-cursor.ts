import { Type, type Static } from "typebox";
import type { TokenUsage } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, JsonObjectSchema, type JsonObject } from "../lib/json.js";

// Cursor's `stream-json` events, as its driver logs them in `runtime/guilds-harness`: each line one
// event. A subscription agent's run keeps two kinds as rows, an assistant message and a call of one
// of its tools, the call when it starts and again when it completes, and reads the tokens the
// invocation spent from its `result`; every other event is dropped.

const TextBlock = Type.Object({ type: Type.Literal("text"), text: Type.String() });

/**
 * What a tool call event's `tool_call` holds under the tool's kind (`shellToolCall`): its arguments
 * and, once it completed, its result. The event's own fields lie beside the kind, none an object.
 */
const ToolCallBody = Type.Object({ args: Type.Optional(JsonObjectSchema), result: Type.Optional(JsonObjectSchema) });

const ToolCallEvent = Type.Object({
  type: Type.Literal("tool_call"),
  subtype: Type.Union([Type.Literal("started"), Type.Literal("completed")]),
  call_id: Type.String(),
  tool_call: JsonObjectSchema,
});

/** The arguments of a call of an MCP server's tool: the server, and the tool's own name and arguments. */
const McpArgs = Type.Object({ providerIdentifier: Type.String(), toolName: Type.String(), args: Type.Optional(JsonObjectSchema) });

/** The tokens a `result` event reports, its input apart from the cache's reads and writes. */
const ResultUsage = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Optional(Type.Number()),
  cacheWriteTokens: Type.Optional(Type.Number()),
});

/** The suffix of a tool kind Cursor's events name, which the run's name of the tool leaves out. */
const TOOL_KIND_SUFFIX = "ToolCall";

/** The kind of a call of an MCP server's tool. */
const MCP_KIND = "mcpToolCall";

/**
 * A call of one of Cursor's tools: the tool (`shell`, `read`, or an MCP server's tool by its own
 * name), the MCP server it belongs to (null for Cursor's own), its arguments, and what it
 * returned once it completed, null while it runs or when it returned no text.
 */
export type CursorToolUse = { name: string; server: string | null; args: JsonObject; output: string | null };

/** A message Cursor wrote. */
export type CursorMessage = { type: "message"; text: string };

/** A call of one of Cursor's tools as it starts, or once it completed, by Cursor's id of the call. */
export type CursorToolEvent = { type: "tool_started" | "tool_completed"; call_id: string; tool: CursorToolUse };

/** The end of a Cursor invocation: the tokens it spent, over every model call it made. */
export type CursorTurnUsage = { type: "turn_usage"; usage: TokenUsage };

/** An event of Cursor's that a run keeps as rows, or reads its turn's usage from. */
export type CursorEvent = CursorMessage | CursorToolEvent | CursorTurnUsage;

/** The text of a message's content blocks, joined; empty when it carries none. */
function messageText(event: JsonObject): string {
  const message = event.message;
  const content = isJsonObject(message) ? message.content : undefined;
  const blocks = Array.isArray(content) ? content : [];
  return blocks.flatMap((block) => (isJsonObject(block) ? [keepMatching(TextBlock, block)?.text ?? ""] : [])).join("");
}

/** The text a tool's result holds: a command's output, a file's content, an edit's diff, an error, or the result itself as JSON. */
function resultText(result: JsonObject): string {
  const success = isJsonObject(result.success) ? result.success : null;
  const error = isJsonObject(result.error) ? result.error : null;
  if (success !== null && (typeof success.stdout === "string" || typeof success.stderr === "string")) {
    return [success.stdout, success.stderr].filter((part) => typeof part === "string" && part.length > 0).join("\n");
  }
  if (success !== null && typeof success.content === "string") {
    return success.content;
  }
  if (success !== null && typeof success.diffString === "string") {
    return success.diffString;
  }
  if (error !== null && typeof error.error === "string") {
    return error.error;
  }
  return JSON.stringify(result);
}

/** The tool's kind and what it holds, in a tool call event's `tool_call`: its first field that is an object; null when it has none. */
function toolBody(toolCall: JsonObject): [string, Static<typeof ToolCallBody>] | null {
  for (const [kind, value] of Object.entries(toolCall)) {
    const body = isJsonObject(value) ? keepMatching(ToolCallBody, value) : null;
    if (body !== null) {
      return [kind, body];
    }
  }
  return null;
}

/** The call a tool call event's body names; null for a body that names no tool. */
function toolUse(event: Static<typeof ToolCallEvent>): CursorToolUse | null {
  const found = toolBody(event.tool_call);
  if (found === null) {
    return null;
  }
  const [kind, body] = found;
  const output = body.result === undefined ? null : resultText(body.result);
  const mcp = kind === MCP_KIND ? keepMatching(McpArgs, body.args ?? {}) : null;
  if (mcp !== null) {
    return { name: mcp.toolName, server: mcp.providerIdentifier, args: mcp.args ?? {}, output };
  }
  return { name: kind.endsWith(TOOL_KIND_SUFFIX) ? kind.slice(0, -TOOL_KIND_SUFFIX.length) : kind, server: null, args: body.args ?? {}, output };
}

/** The tokens of a `result` event's `usage`, its input counted with the cache's reads and writes; null when it reports none. */
function resultUsage(usage: unknown): CursorTurnUsage | null {
  const reported = isJsonObject(usage) ? keepMatching(ResultUsage, usage) : null;
  if (reported === null) {
    return null;
  }
  const read = reported.cacheReadTokens ?? 0;
  const written = reported.cacheWriteTokens;
  return {
    type: "turn_usage",
    usage: {
      input_tokens: reported.inputTokens + read + (written ?? 0),
      output_tokens: reported.outputTokens,
      cache_read_tokens: read,
      ...(written === undefined ? {} : { cache_write_tokens: written }),
    },
  };
}

/** The event one line of the log holds; null for a line that is not JSON or an event the run keeps no row of. */
function parseEvent(line: string): CursorEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isJsonObject(event)) {
    return null;
  }
  if (event.type === "assistant") {
    return { type: "message", text: messageText(event) };
  }
  if (event.type === "result") {
    return resultUsage(event.usage);
  }
  const call = keepMatching(ToolCallEvent, event);
  const tool = call === null ? null : toolUse(call);
  if (call === null || tool === null) {
    return null;
  }
  return { type: call.subtype === "started" ? "tool_started" : "tool_completed", call_id: call.call_id, tool };
}

/** The events of Cursor's `stream-json` lines in `raw` that a run keeps as rows or reads its usage from, in order. */
export function parseCursorEvents(raw: string): CursorEvent[] {
  return raw.split("\n").flatMap((line) => (line.trim() ? (parseEvent(line) ?? []) : []));
}
