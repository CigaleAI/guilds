import type {
  AssistantMessage,
  CompletionMetadata,
  Harness,
  HarnessMessageMetadata,
  TokenUsage,
  ToolCall,
  ToolMessage,
  ToolResultMetadata,
} from "../db/schema/index.js";
import { HARNESS_MCP_SERVER, HARNESS_MCP_TOOL_PREFIX } from "../coding/harnesses.js";
import type { JsonObject } from "../lib/json.js";
import { redact } from "../secrets/index.js";
import { identityOutput, processOutput, toolResultMaxBytes } from "../toolbox/index.js";
import { parseClaudeCodeEvents, type ClaudeCodeMessage } from "./parse-claude-code.js";
import { parseAntigravityEvents, type AntigravityText, type AntigravityToolUse } from "./parse-antigravity.js";
import { parseCodexEvents, type CodexToolItem } from "./parse-codex.js";
import { parseCursorEvents } from "./parse-cursor.js";
import { interruptionRecord } from "./tool-calls.js";

// The rows a subscription agent's run keeps of its harness's events: each message the harness
// writes, and each call of the harness's own tools with its result, in the shapes a model's
// messages and tool calls take, marked as the harness's, and the tokens its turn spent, kept on the
// turn's reply as a model call's are on its message. A call of a tool of the orchestrator's MCP
// server is kept as a tool call of the run where the server runs it, so its events make no row.
// A turn whose harness did not report its tokens at its end records those of the model calls it
// reported, or that it reported none.

/** What a result row holds when the harness's tool returned something other than text. */
export const NOT_TEXT_OUTPUT = "(the tool returned no text)";

/** A call of a harness's own tool's result, as the run keeps it: the message, and the call's metadata marked as the harness's. */
export type HarnessToolRecord = [ToolMessage, ToolResultMetadata & HarnessMessageMetadata];

/**
 * What one of a harness's own tools returned for the call `tool_use_id` names: its output, null when
 * it is not text; whether the harness's events say the call failed; and the exit code of the
 * command it ran, null when the events name none.
 */
export type HarnessToolResult = {
  harness: Harness;
  tool_use_id: string;
  output: string | null;
  failed: boolean;
  exit_code: number | null;
};

/** Why a call that failed with no other reason failed. */
export const FAILED_CALL_REASON = "the call failed";

/** The result of a call of a harness's own tool, with the call itself when the log did not announce it before its result. */
export type HarnessResultStep = { kind: "result"; result: HarnessToolResult; call: ToolCall | null };

/**
 * The tokens the harness reported at its turn's end: the turn's own, or its session's over every
 * turn of it, of which the turn's are what the run has not kept yet.
 */
export type HarnessUsageStep = { kind: "turn_usage"; usage: TokenUsage } | { kind: "session_usage"; usage: TokenUsage };

/**
 * The tokens one model call of the turn spent, by the harness's id of the call, which a later
 * report of the same call replaces.
 */
export type HarnessModelCallStep = { kind: "model_call_usage"; call: string; usage: TokenUsage };

/**
 * What an event of a harness's log makes of the run's rows: a message of the harness's, redacted,
 * whose calls of its own tools wait for their results; the result of such a call; the tokens its
 * turn spent; or those of one of its model calls.
 */
export type HarnessTurnStep =
  | { kind: "message"; payload: AssistantMessage }
  | HarnessResultStep
  | HarnessUsageStep
  | HarnessModelCallStep;

/**
 * What a turn's log reported of its tokens: the harness's report of the whole turn, the last when
 * there are several, null when there is none; and each model call's, by its last report.
 */
export type HarnessTurnTokens = { reported: HarnessUsageStep | null; model_calls: TokenUsage[] };

/** What the steps of a turn's log, `steps`, report of its tokens. */
export function harnessTurnTokens(steps: readonly HarnessTurnStep[]): HarnessTurnTokens {
  let reported: HarnessUsageStep | null = null;
  const calls = new Map<string, TokenUsage>();
  for (const step of steps) {
    if (step.kind === "turn_usage" || step.kind === "session_usage") {
      reported = step;
    } else if (step.kind === "model_call_usage") {
      calls.set(step.call, step.usage);
    }
  }
  return { reported, model_calls: [...calls.values()] };
}

/** What a harness turn's reply records of the tokens the turn spent, and how much of them. */
export type HarnessUsageRecord = Partial<Pick<CompletionMetadata, "usage" | "cost_usd" | "cost_source">> &
  Required<Pick<HarnessMessageMetadata, "usage_extent">>;

/**
 * Whether a harness that names the orchestrator's MCP server's tools under a prefix, `harness`,
 * called one of its own tools, named `name` to its model, rather than one of that server's.
 */
function isHarnessOwnTool(harness: Exclude<Harness, "cursor">, name: string): boolean {
  return !name.startsWith(HARNESS_MCP_TOOL_PREFIX[harness]);
}

/** A call of a harness's tool as a tool call of the run under `id`: its name, and its input redacted with `secrets`. */
function harnessToolCall(id: string, name: string, input: JsonObject, secrets: Record<string, string>): ToolCall {
  return { id, type: "function", function: { name, arguments: redact(JSON.stringify(input), secrets) } };
}

/**
 * The assistant message a message of Claude Code's makes: its text, redacted with `secrets`, and
 * its calls of its own tools; null for a message with neither. Its calls of the orchestrator's
 * MCP server's tools are left out.
 */
export function claudeCodeAssistantMessage(
  message: ClaudeCodeMessage,
  secrets: Record<string, string>,
): AssistantMessage | null {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  const calls = message.content.flatMap((block) =>
    block.type === "tool_use" && isHarnessOwnTool("claude-code", block.name) ? [harnessToolCall(block.id, block.name, block.input, secrets)] : [],
  );
  if (!text.trim() && !calls.length) {
    return null;
  }
  const payload: AssistantMessage = { role: "assistant", content: redact(text, secrets) };
  return calls.length ? { ...payload, tool_calls: calls } : payload;
}

/**
 * The steps Claude Code's `stream-json` lines in `raw` make, in order, redacted with `secrets`:
 * each message with text or calls of its own tools, the tokens of the model call that returned
 * it, each result its tools returned, and the tokens of its invocation, the turn's own. A result
 * names only its call, which its message announced.
 */
export function claudeCodeTurnSteps(raw: string, secrets: Record<string, string>): HarnessTurnStep[] {
  return parseClaudeCodeEvents(raw).flatMap((event): HarnessTurnStep[] => {
    if (event.type === "user") {
      return event.results.map(({ tool_use_id, output, is_error }) => ({
        kind: "result",
        result: { harness: "claude-code", tool_use_id, output, failed: is_error, exit_code: null },
        call: null,
      }));
    }
    if (event.type === "result") {
      return [{ kind: "turn_usage", usage: event.usage }];
    }
    const payload = claudeCodeAssistantMessage(event, secrets);
    const message: HarnessTurnStep[] = payload === null ? [] : [{ kind: "message", payload }];
    if (event.model_call === null || event.usage === null) {
      return message;
    }
    return [...message, { kind: "model_call_usage", call: event.model_call, usage: event.usage }];
  });
}

/** A call of one of Codex's tools as the run keeps it: the tool's name and the call's input. */
type CodexToolUse = { name: string; input: JsonObject };

/**
 * The call of one of Codex's tools its item reports: a shell command, a patch's changes, a web
 * search, or a call of an MCP server's tool under the name Codex gives its model,
 * `mcp__<server>__<tool>`.
 */
function codexToolUse(item: CodexToolItem): CodexToolUse {
  switch (item.type) {
    case "command_execution":
      return { name: item.type, input: { command: item.command } };
    case "file_change":
      return { name: item.type, input: { changes: item.changes } };
    case "web_search":
      return { name: item.type, input: { query: item.query } };
    case "mcp_tool_call":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
  }
}

/** What a call of one of Codex's tools returned, as its completed item reports it; null when it reports no text. */
function codexToolOutput(item: CodexToolItem): string | null {
  switch (item.type) {
    case "command_execution":
      return item.aggregated_output ?? null;
    case "file_change":
      return item.changes.map((change) => `${change.kind ?? "change"} ${change.path}`).join("\n");
    case "web_search":
      return null;
    case "mcp_tool_call":
      return item.error?.message ?? item.result?.content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n") ?? null;
  }
}

/** The statuses of an item Codex did not carry out: one that failed, or a command it declined to run. */
const CODEX_FAILED_STATUSES = new Set(["failed", "declined"]);

/**
 * Whether a call of one of Codex's tools failed, as its completed item reports it: a command that
 * exited otherwise than 0, or an item whose status says it failed or was declined, or an MCP
 * server's tool that returned an error.
 */
function codexToolFailed(item: CodexToolItem): boolean {
  switch (item.type) {
    case "command_execution":
      return CODEX_FAILED_STATUSES.has(item.status ?? "") || (item.exit_code ?? 0) !== 0;
    case "file_change":
      return CODEX_FAILED_STATUSES.has(item.status ?? "");
    case "web_search":
      return false;
    case "mcp_tool_call":
      return item.error !== undefined && item.error !== null;
  }
}

/**
 * The steps Codex's `--json` lines in `raw` make, in order, redacted with `secrets`: each message
 * with text, each call of one of its own tools, when it starts and with its result when it
 * completes, and the tokens of its thread, the session's. Codex numbers its items afresh on each
 * turn, so a call's id is the item's under `turnId`, the turn's call id.
 */
export function codexTurnSteps(raw: string, secrets: Record<string, string>, turnId: string): HarnessTurnStep[] {
  return parseCodexEvents(raw).flatMap((event): HarnessTurnStep[] => {
    if (event.type === "message") {
      return event.text.trim() ? [{ kind: "message", payload: { role: "assistant", content: redact(event.text, secrets) } }] : [];
    }
    if (event.type === "thread_usage") {
      return [{ kind: "session_usage", usage: event.usage }];
    }
    const use = codexToolUse(event.item);
    if (!isHarnessOwnTool("codex", use.name)) {
      return [];
    }
    const call = harnessToolCall(`${turnId}.${event.item.id}`, use.name, use.input, secrets);
    if (event.type === "tool_started") {
      return [{ kind: "message", payload: { role: "assistant", content: "", tool_calls: [call] } }];
    }
    const result: HarnessToolResult = {
      harness: "codex",
      tool_use_id: call.id,
      output: codexToolOutput(event.item),
      failed: codexToolFailed(event.item),
      exit_code: event.item.type === "command_execution" ? (event.item.exit_code ?? null) : null,
    };
    return [{ kind: "result", result, call }];
  });
}

/**
 * The steps Cursor's `stream-json` lines in `raw` make, in order, redacted with `secrets`: each
 * message with text, each call of one of its own tools, when it starts and with its result when it
 * completes, and the tokens of its invocation, the turn's own. A call's id is Cursor's under
 * `turnId`, the turn's call id, so a resumed chat's calls never share one.
 */
export function cursorTurnSteps(raw: string, secrets: Record<string, string>, turnId: string): HarnessTurnStep[] {
  return parseCursorEvents(raw).flatMap((event): HarnessTurnStep[] => {
    if (event.type === "message") {
      return event.text.trim() ? [{ kind: "message", payload: { role: "assistant", content: redact(event.text, secrets) } }] : [];
    }
    if (event.type === "turn_usage") {
      return [{ kind: "turn_usage", usage: event.usage }];
    }
    if (event.tool.server === HARNESS_MCP_SERVER) {
      return [];
    }
    const call = harnessToolCall(`${turnId}.${event.call_id}`, event.tool.name, event.tool.args, secrets);
    if (event.type === "tool_started") {
      return [{ kind: "message", payload: { role: "assistant", content: "", tool_calls: [call] } }];
    }
    const returned = event.tool.result ?? { output: null, failed: false, exit_code: null };
    return [{ kind: "result", result: { harness: "cursor", tool_use_id: call.id, ...returned }, call }];
  });
}

/** Whether Antigravity's call `tool` is of a tool of the orchestrator's MCP server, under its MCP prefix or through `call_mcp_tool`. */
function isAntigravityGuildsCall(tool: AntigravityToolUse): boolean {
  return tool.server === HARNESS_MCP_SERVER || !isHarnessOwnTool("antigravity", tool.name);
}

/**
 * The message a piece of Antigravity's response text makes: none until its step is done, the
 * pieces kept in `drafts` by step meanwhile; then the step's whole text, redacted with `secrets`,
 * when it holds any, and the tokens of the step's model call, when it reports them.
 */
function antigravityMessage(piece: AntigravityText, secrets: Record<string, string>, drafts: Map<number, string>): HarnessTurnStep[] {
  const text = (drafts.get(piece.step) ?? "") + piece.text;
  if (!piece.done) {
    drafts.set(piece.step, text);
    return [];
  }
  drafts.delete(piece.step);
  const message: HarnessTurnStep[] = text.trim()
    ? [{ kind: "message", payload: { role: "assistant", content: redact(text.trimEnd(), secrets) } }]
    : [];
  return piece.usage === null ? message : [...message, { kind: "model_call_usage", call: `step_${piece.step}`, usage: piece.usage }];
}

/**
 * The steps Antigravity's `stream-json` lines in `raw` make, in order, redacted with `secrets`:
 * each response with text once its step is done, its pieces kept in `drafts` until then, with the
 * tokens of its model call, each call
 * of one of its own tools, when it starts and with its output when it ends, and the tokens of its
 * conversation, the session's. A call's id is its step's under `turnId`, the turn's call id.
 */
export function antigravityTurnSteps(
  raw: string,
  secrets: Record<string, string>,
  turnId: string,
  drafts: Map<number, string>,
): HarnessTurnStep[] {
  return parseAntigravityEvents(raw).flatMap((event): HarnessTurnStep[] => {
    if (event.type === "text") {
      return antigravityMessage(event, secrets, drafts);
    }
    if (event.type === "session_usage") {
      return [{ kind: "session_usage", usage: event.usage }];
    }
    if (isAntigravityGuildsCall(event.tool)) {
      return [];
    }
    const call = harnessToolCall(`${turnId}.step_${event.step}`, event.tool.name, event.tool.parameters, secrets);
    if (event.type === "tool_started") {
      return [{ kind: "message", payload: { role: "assistant", content: "", tool_calls: [call] } }];
    }
    const result: HarnessToolResult = { harness: "antigravity", tool_use_id: call.id, output: event.output, failed: event.failed, exit_code: null };
    return [{ kind: "result", result, call }];
  });
}

/** What reads a turn's log as its polls bring it: the steps the raw lines in `raw` make, redacted with `secrets`. */
export type HarnessTurnReader = (raw: string, secrets: Record<string, string>) => HarnessTurnStep[];

/**
 * Each harness's reader of one turn's log, the turn named by its call id. Antigravity's keeps the
 * text of a response it streams over several polls until the response is done.
 */
export const HARNESS_TURN_STEPS: Record<Harness, (turnId: string) => HarnessTurnReader> = {
  "claude-code": () => claudeCodeTurnSteps,
  codex: (turnId) => (raw, secrets) => codexTurnSteps(raw, secrets, turnId),
  cursor: (turnId) => (raw, secrets) => cursorTurnSteps(raw, secrets, turnId),
  antigravity: (turnId) => {
    const drafts = new Map<number, string>();
    return (raw, secrets) => antigravityTurnSteps(raw, secrets, turnId, drafts);
  },
};

/** The tokens of `usages` together; cache writes only when one of them reports them. */
export function totalUsage(usages: readonly TokenUsage[]): TokenUsage {
  const total: TokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  for (const usage of usages) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.cache_read_tokens += usage.cache_read_tokens;
    if (usage.cache_write_tokens !== undefined) {
      total.cache_write_tokens = (total.cache_write_tokens ?? 0) + usage.cache_write_tokens;
    }
  }
  return total;
}

/**
 * The tokens of a session's latest turn: what its total `session` spent past the turns the run
 * kept, `kept`. A total below what the run kept is a new session's, all of it the turn's.
 */
export function sessionTurnUsage(session: TokenUsage, kept: readonly TokenUsage[]): TokenUsage {
  const before = totalUsage(kept);
  if (
    session.input_tokens < before.input_tokens ||
    session.output_tokens < before.output_tokens ||
    session.cache_read_tokens < before.cache_read_tokens
  ) {
    return session;
  }
  const turn: TokenUsage = {
    input_tokens: session.input_tokens - before.input_tokens,
    output_tokens: session.output_tokens - before.output_tokens,
    cache_read_tokens: session.cache_read_tokens - before.cache_read_tokens,
  };
  if (session.cache_write_tokens !== undefined) {
    turn.cache_write_tokens = Math.max(0, session.cache_write_tokens - (before.cache_write_tokens ?? 0));
  }
  return turn;
}

/**
 * What a harness turn's reply records of the tokens its harness reported for the whole turn, as a
 * model call's message does: the tokens, all of the turn's, and no price, since the turn ran on
 * the operator's subscription.
 */
export function subscriptionUsageRecord(usage: TokenUsage): HarnessUsageRecord {
  return { usage, cost_usd: 0, cost_source: "subscription", usage_extent: "complete" };
}

/**
 * What the reply of a turn that ended without its harness's report of the whole turn records: the
 * tokens of the model calls it reported, `calls`, with no price, which are part of the turn's;
 * or, when it reported none, that it records none.
 */
export function unreportedUsageRecord(calls: readonly TokenUsage[]): HarnessUsageRecord {
  if (!calls.length) {
    return { usage_extent: "none" };
  }
  return { usage: totalUsage(calls), cost_usd: 0, cost_source: "subscription", usage_extent: "partial" };
}

/**
 * Why a call its harness says failed failed, as a failed tool's row names it: the exit code of the
 * command it ran, else the first line of what it returned, else that it failed.
 */
function harnessToolFailure(result: HarnessToolResult): string {
  if (result.exit_code !== null && result.exit_code !== 0) {
    return `exited with code ${result.exit_code}`;
  }
  const line = (result.output ?? "").trim().split("\n")[0]?.trim() ?? "";
  return line || FAILED_CALL_REASON;
}

/**
 * The row of `result`, the result of `call`, a call of one of its harness's own tools that took
 * `durationMs`: its output redacted with `secrets` and capped as a tool's output is, the call's
 * failure, redacted too, as a failed tool's row records it, and its command's exit code.
 */
export function harnessToolRecord(
  result: HarnessToolResult,
  call: ToolCall,
  durationMs: number,
  secrets: Record<string, string>,
): HarnessToolRecord {
  const [content, output] = processOutput(
    result.output ?? NOT_TEXT_OUTPUT,
    identityOutput,
    secrets,
    toolResultMaxBytes(),
  );
  const failure = result.failed ? redact(harnessToolFailure(result), secrets) : null;
  return [
    { role: "tool", tool_call_id: call.id, content },
    {
      tool_name: call.function.name,
      tool_call_id: call.id,
      duration_ms: durationMs,
      output_filter: "identity",
      ...output,
      error: output.error ?? failure,
      ...(result.exit_code === null ? {} : { exit_code: result.exit_code }),
      from_harness: result.harness,
    },
  ];
}

/**
 * The result a call of `harness`'s own tool gets when the turn ended before the tool returned:
 * the interrupted result of generation `generation`, marked as the harness's.
 */
export function interruptedHarnessToolRecord(
  call: ToolCall,
  generation: number,
  harness: Harness,
): [ToolMessage, HarnessToolRecord[1] & { generation: number }] {
  const [payload, metadata] = interruptionRecord(call, generation);
  return [payload, { ...metadata, from_harness: harness }];
}
