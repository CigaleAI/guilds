import { Type, type Static } from "typebox";
import type { TokenUsage } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, JsonObjectSchema, type JsonObject } from "../lib/json.js";

// Antigravity's `stream-json` events, as its driver logs them in `runtime/guilds-harness`: each line
// one event, its payload under the event's name. A subscription agent's run keeps two kinds of step
// as rows, the agent's response, whose text streams in pieces until the step is done, and a call of
// one of its tools, when it starts and again when it ends; it reads the tokens the conversation
// spent from `result`, and those of each model call from the response step it ended. Every other
// event and step is dropped.

const ToolInfo = Type.Object({
  name: Type.Optional(Type.String()),
  parameters: Type.Optional(JsonObjectSchema),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.Object({ message: Type.Optional(Type.String()) })),
});

/** The tokens `result` reports: the conversation's, over every turn of it; or a response step: its model call's. Input is apart from the cache's reads. */
const ReportedUsage = Type.Object({
  input_tokens: Type.Number(),
  output_tokens: Type.Number(),
  cache_read_tokens: Type.Optional(Type.Number()),
});

const StepUpdate = Type.Object({
  step_index: Type.Number(),
  state: Type.String(),
  step_type: Type.String(),
  text_delta: Type.Optional(Type.String()),
  tool_name: Type.Optional(Type.String()),
  tool_info: Type.Optional(ToolInfo),
  usage: Type.Optional(ReportedUsage),
});

/** The state of a step that failed. */
const FAILED_STATE = "ERROR";

/** The tool through which Antigravity's model calls a tool of an MCP server it names. */
const CALL_MCP_TOOL = "call_mcp_tool";

/**
 * A call of one of Antigravity's tools: the tool's name, the MCP server a `call_mcp_tool` call
 * names (null for any other call), and its parameters.
 */
export type AntigravityToolUse = { name: string; server: string | null; parameters: JsonObject };

/**
 * A piece of the text of the agent's response at step `step`; `done` on the step's last piece,
 * which carries the tokens the step's model call spent, null when it reports none.
 */
export type AntigravityText = { type: "text"; step: number; text: string; done: boolean; usage: TokenUsage | null };

/** A call of one of Antigravity's tools at step `step` as it starts. */
export type AntigravityToolStarted = { type: "tool_started"; step: number; tool: AntigravityToolUse };

/**
 * A call of one of Antigravity's tools at step `step` once it ended: its output or its error's
 * message, null when it reports neither, and whether it failed, its step in `ERROR` or carrying an error.
 */
export type AntigravityToolEnded = { type: "tool_ended"; step: number; tool: AntigravityToolUse; output: string | null; failed: boolean };

/** The end of an invocation: the tokens the conversation spent so far, over every turn of it. */
export type AntigravitySessionUsage = { type: "session_usage"; usage: TokenUsage };

/** An event of Antigravity's that a run keeps as rows, or reads its turn's usage from. */
export type AntigravityEvent = AntigravityText | AntigravityToolStarted | AntigravityToolEnded | AntigravitySessionUsage;

/** The call a tool step names, with the server of a `call_mcp_tool` call. */
function toolUse(name: string, parameters: JsonObject): AntigravityToolUse {
  const server = name === CALL_MCP_TOOL && typeof parameters.ServerName === "string" ? parameters.ServerName : null;
  return { name, server, parameters };
}

/** The call a tool step holds as it starts, or once it ended with its output or its error; null for a step that names no tool. */
function toolEvent(step: Static<typeof StepUpdate>): AntigravityToolStarted | AntigravityToolEnded | null {
  const info = step.tool_info ?? {};
  const name = info.name ?? step.tool_name;
  if (name === undefined) {
    return null;
  }
  const tool = toolUse(name, info.parameters ?? {});
  if (step.state === "ACTIVE") {
    return { type: "tool_started", step: step.step_index, tool };
  }
  return {
    type: "tool_ended",
    step: step.step_index,
    tool,
    output: info.output ?? info.error?.message ?? null,
    failed: step.state === FAILED_STATE || info.error !== undefined,
  };
}

/** The event a `step_update` holds; null for a step of another kind or shape. */
function stepEvent(body: JsonObject): AntigravityEvent | null {
  const step = keepMatching(StepUpdate, body);
  if (step === null) {
    return null;
  }
  if (step.step_type === "agent_response") {
    const usage = step.usage === undefined ? null : tokenUsage(step.usage);
    return { type: "text", step: step.step_index, text: step.text_delta ?? "", done: step.state !== "ACTIVE", usage };
  }
  return step.step_type === "tool" ? toolEvent(step) : null;
}

/** The tokens of a reported `usage`, its input counted with the cache's reads. */
function tokenUsage(reported: Static<typeof ReportedUsage>): TokenUsage {
  const read = reported.cache_read_tokens ?? 0;
  return { input_tokens: reported.input_tokens + read, output_tokens: reported.output_tokens, cache_read_tokens: read };
}

/** The tokens of a `result`'s `usage`; null when it reports none. */
function resultUsage(result: JsonObject): AntigravitySessionUsage | null {
  const reported = isJsonObject(result.usage) ? keepMatching(ReportedUsage, result.usage) : null;
  return reported === null ? null : { type: "session_usage", usage: tokenUsage(reported) };
}

/** The event one line of the log holds; null for a line that is not JSON or an event the run keeps no row of. */
function parseEvent(line: string): AntigravityEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isJsonObject(event)) {
    return null;
  }
  if (event.event === "step_update" && isJsonObject(event.step_update)) {
    return stepEvent(event.step_update);
  }
  return event.event === "result" && isJsonObject(event.result) ? resultUsage(event.result) : null;
}

/** The events of Antigravity's `stream-json` lines in `raw` that a run keeps as rows or reads its usage from, in order. */
export function parseAntigravityEvents(raw: string): AntigravityEvent[] {
  return raw.split("\n").flatMap((line) => (line.trim() ? (parseEvent(line) ?? []) : []));
}
