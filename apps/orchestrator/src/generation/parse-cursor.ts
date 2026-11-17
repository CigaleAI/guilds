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

/**
 * What a shell command's result holds, whether it exited 0 (under `success`) or not (under
 * `failure`): its exit code, and its output, apart and interleaved.
 */
const CommandResult = Type.Object({
  exitCode: Type.Optional(Type.Number()),
  stdout: Type.Optional(Type.String()),
  stderr: Type.Optional(Type.String()),
  interleavedOutput: Type.Optional(Type.String()),
});

/** What a failed call's `error` holds: its message, under either name Cursor's tools give it. */
const ErrorResult = Type.Object({ error: Type.Optional(Type.String()), errorMessage: Type.Optional(Type.String()) });

/** A read's file content, or an edit's diff. */
const ReadContent = Type.Object({ content: Type.String() });
const EditDiff = Type.Object({ diffString: Type.String() });

/** A read whose content the event leaves out, kept by Cursor apart: the file, its size, its lines, and the lines read. */
const UnreadContent = Type.Object({
  path: Type.String(),
  fileSize: Type.Number(),
  totalLines: Type.Number(),
  readRange: Type.Optional(Type.Object({ startLine: Type.Number(), endLine: Type.Number() })),
});

/** A background command that completed while a call waited for it: how long it ran, and the length and file of its output. */
const CompletedJob = Type.Object({
  complete: Type.Object({
    runtimeMs: Type.Union([Type.String(), Type.Number()]),
    outputLength: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    outputFilePath: Type.Optional(Type.String()),
  }),
});

/** The suffix of a tool kind Cursor's events name, which the run's name of the tool leaves out. */
const TOOL_KIND_SUFFIX = "ToolCall";

/** The kind of a call of an MCP server's tool. */
const MCP_KIND = "mcpToolCall";

/**
 * What a call of one of Cursor's tools returned once it completed: its text, whether Cursor reports
 * it failed, and the exit code of the command it ran, null when it names none.
 */
export type CursorToolResult = { output: string; failed: boolean; exit_code: number | null };

/**
 * A call of one of Cursor's tools: the tool (`shell`, `read`, or an MCP server's tool by its own
 * name), the MCP server it belongs to (null for Cursor's own), its arguments, and what it
 * returned once it completed, null while it runs.
 */
export type CursorToolUse = { name: string; server: string | null; args: JsonObject; result: CursorToolResult | null };

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

/** A command's output: its interleaved output when Cursor kept one, else its stdout and stderr, each when not empty. */
function commandText(command: Static<typeof CommandResult>): string {
  if (command.interleavedOutput) {
    return command.interleavedOutput;
  }
  return [command.stdout, command.stderr].filter((part) => part !== undefined && part.length > 0).join("\n");
}

/** What a read whose content the event leaves out read, in words: the lines, the file, and its size. */
function unreadContentText(read: Static<typeof UnreadContent>): string {
  const range = read.readRange === undefined ? "" : `lines ${read.readRange.startLine}-${read.readRange.endLine} of `;
  const lines = read.totalLines > 0 ? `${read.totalLines} lines, ` : "";
  return `Read ${range}${read.path} (${lines}${read.fileSize} bytes); Cursor's event does not carry the content.`;
}

/** A background command's completion, in words: how long it ran, and the length and file of its output. */
function completedJobText(job: Static<typeof CompletedJob>): string {
  const { runtimeMs, outputLength, outputFilePath } = job.complete;
  const length = outputLength === undefined ? "" : `; output length ${outputLength}`;
  const file = outputFilePath ? ` in ${outputFilePath}` : "";
  return `The command completed after ${Number(runtimeMs) / 1000} s${length}${file}.`;
}

/**
 * The text of a successful call's `success`, by its shape: a command's output, a file's content, an
 * edit's diff, a read whose content the event leaves out, or a waited-for command's completion;
 * null for a shape of another tool.
 */
function successText(success: JsonObject): string | null {
  const command = keepMatching(CommandResult, success);
  if (command !== null && (command.stdout ?? command.stderr ?? command.interleavedOutput) !== undefined) {
    return commandText(command);
  }
  const content = keepMatching(ReadContent, success)?.content ?? keepMatching(EditDiff, success)?.diffString;
  if (content !== undefined) {
    return content;
  }
  const unread = keepMatching(UnreadContent, success);
  if (unread !== null) {
    return unreadContentText(unread);
  }
  const job = keepMatching(CompletedJob, success);
  return job === null ? null : completedJobText(job);
}

/**
 * What the result of a call that failed says: a command that exited otherwise than 0 (`failure`)
 * its output and exit code, any other call (`error`) its message; null for a result of neither.
 */
function failedResult(result: JsonObject): CursorToolResult | null {
  const failure = isJsonObject(result.failure) ? keepMatching(CommandResult, result.failure) : null;
  if (failure !== null) {
    return { output: commandText(failure), failed: true, exit_code: failure.exitCode ?? null };
  }
  const error = isJsonObject(result.error) ? keepMatching(ErrorResult, result.error) : null;
  if (error === null) {
    return null;
  }
  return { output: error.errorMessage ?? error.error ?? JSON.stringify(result), failed: true, exit_code: null };
}

/**
 * What a tool's result says: a failed call's, else the text of its `success`, a command's with its
 * exit code; any other result is kept as its JSON.
 */
function toolResult(result: JsonObject): CursorToolResult {
  const failed = failedResult(result);
  if (failed !== null) {
    return failed;
  }
  const success = isJsonObject(result.success) ? result.success : {};
  const exitCode = keepMatching(CommandResult, success)?.exitCode ?? null;
  return { output: successText(success) ?? JSON.stringify(result), failed: false, exit_code: exitCode };
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
  const result = body.result === undefined ? null : toolResult(body.result);
  const mcp = kind === MCP_KIND ? keepMatching(McpArgs, body.args ?? {}) : null;
  if (mcp !== null) {
    return { name: mcp.toolName, server: mcp.providerIdentifier, args: mcp.args ?? {}, result };
  }
  return { name: kind.endsWith(TOOL_KIND_SUFFIX) ? kind.slice(0, -TOOL_KIND_SUFFIX.length) : kind, server: null, args: body.args ?? {}, result };
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
