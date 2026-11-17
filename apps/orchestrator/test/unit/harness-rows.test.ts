import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  antigravityTurnSteps,
  claudeCodeAssistantMessage,
  claudeCodeTurnSteps,
  codexTurnSteps,
  cursorTurnSteps,
  HARNESS_TURN_STEPS,
  harnessToolRecord,
  interruptedHarnessToolRecord,
  FAILED_CALL_REASON,
  NOT_TEXT_OUTPUT,
  sessionTurnUsage,
  subscriptionUsageRecord,
} from "../../src/generation/harness-rows.js";
import { parseAntigravityEvents } from "../../src/generation/parse-antigravity.js";
import { parseCodexEvents } from "../../src/generation/parse-codex.js";
import { parseCursorEvents } from "../../src/generation/parse-cursor.js";
import type { JsonObject } from "../../src/lib/json.js";
import { parseClaudeCodeEvents, type ClaudeCodeMessage } from "../../src/generation/parse-claude-code.js";
import { INTERRUPTED_CONTENT } from "../../src/generation/tool-calls.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = readFileSync(path.join(HERE, "../helpers/harness/claude-code.jsonl"), "utf8");
const RECORDED_CODEX = readFileSync(path.join(HERE, "../helpers/harness/codex.jsonl"), "utf8");
const RECORDED_CURSOR = readFileSync(path.join(HERE, "../helpers/harness/cursor.jsonl"), "utf8");
const RECORDED_ANTIGRAVITY = readFileSync(path.join(HERE, "../helpers/harness/antigravity.jsonl"), "utf8");

test("a recorded Claude Code turn parses into its messages and its tools' results, in order", () => {
  const events = parseClaudeCodeEvents(RECORDED);
  assert.deepEqual(
    events.map((event) => event.type),
    ["assistant", "user", "assistant", "user", "assistant", "user", "assistant", "result"],
    "the init event makes no row",
  );
  assert.deepEqual(events.at(-1), { type: "result", usage: { input_tokens: 12, output_tokens: 140, cache_read_tokens: 0 } });
  assert.deepEqual(events[0], {
    type: "assistant",
    content: [
      { type: "text", text: "I'll look at the greeting first." },
      { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/home/a_1/repos/app/greet.py" } },
    ],
  });
  assert.deepEqual(events[1], { type: "user", results: [{ tool_use_id: "toolu_01", output: "1\tprint('hello')\n", is_error: false }] });
});

test("a line that is not JSON, an event of another kind, and a block of another shape are dropped", () => {
  const events = parseClaudeCodeEvents(
    [
      "not json",
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: "ls" }] } }),
      JSON.stringify({ type: "user", message: { content: "a prompt" } }),
      "",
    ].join("\n"),
  );
  assert.deepEqual(events, [
    { type: "assistant", content: [{ type: "text", text: "hi" }] },
    { type: "assistant", content: [] },
    { type: "user", results: [] },
  ]);
});

test("a tool result whose content is not text parses with no output", () => {
  const [event] = parseClaudeCodeEvents(
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image" }] }] } }),
  );
  assert.deepEqual(event, { type: "user", results: [{ tool_use_id: "t", output: null, is_error: false }] });
});

test("a call of a tool of the orchestrator's MCP server makes no tool call of the message", () => {
  const message: ClaudeCodeMessage = {
    type: "assistant",
    content: [
      { type: "text", text: "Writing the note." },
      { type: "tool_use", id: "toolu_mcp", name: "mcp__guilds__note_write", input: { path: "a.md" } },
      { type: "tool_use", id: "toolu_own", name: "Bash", input: { command: "ls" } },
    ],
  };
  const payload = claudeCodeAssistantMessage(message, {});
  assert.deepEqual(
    payload?.tool_calls?.map((call) => call.id),
    ["toolu_own"],
    "the server keeps that call as the run's own",
  );
  assert.equal(payload?.content, "Writing the note.");
});

test("a message holding only a call of the orchestrator's MCP server makes no row", () => {
  const message: ClaudeCodeMessage = {
    type: "assistant",
    content: [{ type: "tool_use", id: "toolu_mcp", name: "mcp__guilds__group_post", input: { content: "hi" } }],
  };
  assert.equal(claudeCodeAssistantMessage(message, {}), null);
});

test("a call of another MCP server's tool stays a call of the harness's own", () => {
  const message: ClaudeCodeMessage = {
    type: "assistant",
    content: [{ type: "tool_use", id: "toolu_other", name: "mcp__guildsx__note_write", input: {} }],
  };
  assert.deepEqual(claudeCodeAssistantMessage(message, {})?.tool_calls?.map((call) => call.function.name), [
    "mcp__guildsx__note_write",
  ]);
});

test("a message's text becomes an assistant row, and its tool uses its tool calls, both redacted", () => {
  const message: ClaudeCodeMessage = {
    type: "assistant",
    content: [
      { type: "text", text: "Using tok-123." },
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "echo tok-123" } },
    ],
  };
  assert.deepEqual(claudeCodeAssistantMessage(message, { TOKEN: "tok-123" }), {
    role: "assistant",
    content: "Using [REDACTED:TOKEN].",
    tool_calls: [
      { id: "toolu_01", type: "function", function: { name: "Bash", arguments: '{"command":"echo [REDACTED:TOKEN]"}' } },
    ],
  });
  assert.deepEqual(claudeCodeAssistantMessage({ type: "assistant", content: [{ type: "text", text: "Done." }] }, {}), {
    role: "assistant",
    content: "Done.",
  });
  assert.equal(claudeCodeAssistantMessage({ type: "assistant", content: [{ type: "text", text: "  " }] }, {}), null);
});

test("a tool's result becomes a tool row marked as the harness's, redacted and capped as a tool's output", () => {
  const call = { id: "toolu_03", type: "function", function: { name: "Bash", arguments: "{}" } };
  const ran = (output: string | null) => ({ harness: "claude-code" as const, tool_use_id: "toolu_03", output, failed: false, exit_code: null });
  const [payload, metadata] = harnessToolRecord(ran("token tok-123"), call, 1200, { TOKEN: "tok-123" });
  assert.deepEqual(payload, { role: "tool", tool_call_id: "toolu_03", content: "token [REDACTED:TOKEN]" });
  assert.equal(metadata.tool_name, "Bash");
  assert.equal(metadata.tool_call_id, "toolu_03");
  assert.equal(metadata.duration_ms, 1200);
  assert.equal(metadata.from_harness, "claude-code");
  assert.equal(metadata.truncated, false);
  assert.equal(metadata.error, null);
  const previous = process.env.TOOL_RESULT_MAX_BYTES;
  process.env.TOOL_RESULT_MAX_BYTES = "1024";
  try {
    const [long, cut] = harnessToolRecord(ran("x".repeat(5000)), call, 0, {});
    assert.equal(cut.truncated, true);
    assert.equal(cut.original_bytes, 5000);
    assert.ok(Buffer.byteLength(long.content) <= 1024 + 200);
  } finally {
    if (previous === undefined) {
      delete process.env.TOOL_RESULT_MAX_BYTES;
    } else {
      process.env.TOOL_RESULT_MAX_BYTES = previous;
    }
  }
  assert.equal(harnessToolRecord(ran(null), call, 0, {})[0].content, NOT_TEXT_OUTPUT);
  assert.equal("exit_code" in metadata, false, "a call whose events name no exit code records none");
});

test("a call its harness says failed records its failure as a failed tool's row does: its exit code, else its first line, redacted", () => {
  const call = { id: "turn_1.tool_4", type: "function", function: { name: "shell", arguments: "{}" } };
  const failed = (output: string | null, exitCode: number | null) =>
    harnessToolRecord({ harness: "cursor", tool_use_id: call.id, output, failed: true, exit_code: exitCode }, call, 0, { TOKEN: "tok-123" });
  const [payload, command] = failed("fatal: no tok-123 here\n", 128);
  assert.equal(payload.content, "fatal: no [REDACTED:TOKEN] here\n", "the row keeps what the command printed");
  assert.equal(command.error, "exited with code 128");
  assert.equal(command.exit_code, 128);
  assert.equal(failed("\n  File not found: tok-123\nmore", null)[1].error, "File not found: [REDACTED:TOKEN]");
  assert.equal(failed(null, null)[1].error, FAILED_CALL_REASON);
  assert.equal(failed("", 0)[1].error, FAILED_CALL_REASON, "a failed call whose command exited 0 is named by no code");
  const succeeded = harnessToolRecord({ harness: "codex", tool_use_id: call.id, output: "ok", failed: false, exit_code: 0 }, call, 0, {});
  assert.equal(succeeded[1].error, null);
  assert.equal(succeeded[1].exit_code, 0, "a command that succeeded records its exit code too");
});

test("a tool the turn ended inside gets the interrupted result, marked as the harness's", () => {
  const call = { id: "toolu_09", type: "function", function: { name: "Bash", arguments: "{}" } };
  const [payload, metadata] = interruptedHarnessToolRecord(call, 2, "claude-code");
  assert.deepEqual(payload, { role: "tool", tool_call_id: "toolu_09", content: INTERRUPTED_CONTENT });
  assert.equal(metadata.generation, 2);
  assert.equal(metadata.error, "execution interrupted");
  assert.equal(metadata.from_harness, "claude-code");
});

test("a recorded Claude Code turn makes its messages and its tools' results, each result naming only its call", () => {
  const steps = claudeCodeTurnSteps(RECORDED, {});
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["message", "result", "message", "result", "message", "result", "message", "turn_usage"],
  );
  assert.deepEqual(steps[1], {
    kind: "result",
    result: { harness: "claude-code", tool_use_id: "toolu_01", output: "1\tprint('hello')\n", failed: false, exit_code: null },
    call: null,
  });
  assert.equal(claudeCodeTurnSteps(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: " " }] } }), {}).length, 0);
});

test("a recorded Codex turn parses into its tools' calls as they start and complete, and its message", () => {
  const events = parseCodexEvents(RECORDED_CODEX);
  assert.deepEqual(
    events.map((event) => [event.type, "item" in event ? event.item.type : null]),
    [
      ["tool_started", "command_execution"],
      ["tool_completed", "command_execution"],
      ["tool_completed", "file_change"],
      ["tool_started", "command_execution"],
      ["tool_completed", "command_execution"],
      ["message", null],
      ["thread_usage", null],
    ],
    "the thread, turn start, and reasoning events make no row",
  );
  assert.deepEqual(events.at(-1), {
    type: "thread_usage",
    usage: { input_tokens: 9120, output_tokens: 212, cache_read_tokens: 4096 },
  });
  assert.deepEqual(events[1], {
    type: "tool_completed",
    item: { id: "item_1", type: "command_execution", command: "bash -lc 'cat greet.py'", aggregated_output: "print('hello')\n", exit_code: 0, status: "completed" },
  });
});

test("a line that is not JSON, an item of another kind, and an item of another shape are dropped from Codex's events", () => {
  const events = parseCodexEvents(
    [
      "not json",
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "hm" } }),
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: ["ls"] } }),
      JSON.stringify({ type: "item.updated", item: { id: "i2", type: "web_search", query: "guilds" } }),
      JSON.stringify({ type: "item.started", item: { id: "i3", type: "agent_message", text: "partial" } }),
      JSON.stringify({ type: "item.completed", item: { id: "i4", type: "agent_message", text: "Done." } }),
      "",
    ].join("\n"),
  );
  assert.deepEqual(events, [{ type: "message", text: "Done." }]);
});

test("a Codex turn's calls are rows under the turn's id, announced as they start, each result carrying its call", () => {
  const steps = codexTurnSteps(RECORDED_CODEX, { TOKEN: "guild" }, "turn_1");
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["message", "result", "result", "message", "result", "message", "session_usage"],
  );
  assert.deepEqual(steps[0], {
    kind: "message",
    payload: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "turn_1.item_1", type: "function", function: { name: "command_execution", arguments: '{"command":"bash -lc \'cat greet.py\'"}' } }],
    },
  });
  const patch = steps[2];
  assert.equal(patch?.kind, "result");
  assert.deepEqual(patch?.kind === "result" ? [patch.result, patch.call?.function.name] : null, [
    { harness: "codex", tool_use_id: "turn_1.item_2", output: "update /home/a_1/repos/app/greet.py", failed: false, exit_code: null },
    "file_change",
  ]);
  const reply = steps.at(-2);
  assert.match(reply?.kind === "message" ? reply.payload.content : "", /\[REDACTED:TOKEN\]/, "a message is redacted");
});

test("a Codex call of the orchestrator's MCP server makes no row; another server's tool, a search, and a failure do", () => {
  const item = (type: string, fields: Record<string, unknown>) => JSON.stringify({ type, item: { id: "item_5", ...fields } });
  const mcp = { type: "mcp_tool_call", tool: "note_write", arguments: { key: "a.md" } };
  const steps = codexTurnSteps(
    [
      item("item.started", { ...mcp, server: "guilds" }),
      item("item.completed", { ...mcp, server: "guilds", result: { content: [{ type: "text", text: "kept" }] } }),
      item("item.completed", { ...mcp, server: "docs", result: null, error: { message: "refused" } }),
      item("item.completed", { ...mcp, server: "docs", result: { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] } }),
      item("item.completed", { type: "web_search", query: "guilds run" }),
    ].join("\n"),
    {},
    "turn_2",
  );
  assert.deepEqual(
    steps.map((step) => (step.kind === "result" ? [step.call?.function.name, step.result.output] : step.kind)),
    [
      ["mcp__docs__note_write", "refused"],
      ["mcp__docs__note_write", "a\nb"],
      ["web_search", null],
    ],
  );
  assert.equal(codexTurnSteps(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: " " } }), {}, "t").length, 0);
});

test("Claude Code's usage counts its cache reads and writes in its input; Codex's already does", () => {
  const [claude] = parseClaudeCodeEvents(
    JSON.stringify({
      type: "result",
      usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 },
    }),
  );
  assert.deepEqual(claude, {
    type: "result",
    usage: { input_tokens: 360, output_tokens: 40, cache_read_tokens: 300, cache_write_tokens: 50 },
  });
  assert.deepEqual(parseClaudeCodeEvents(JSON.stringify({ type: "result", subtype: "success" })), [], "a result without usage reads as nothing");
  const [codex] = parseCodexEvents(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 3006, cached_input_tokens: 900, cache_write_input_tokens: 0, output_tokens: 156, reasoning_output_tokens: 21 },
    }),
  );
  assert.deepEqual(codex, {
    type: "thread_usage",
    usage: { input_tokens: 3006, output_tokens: 156, cache_read_tokens: 900, cache_write_tokens: 0 },
  });
  assert.deepEqual(parseCodexEvents(JSON.stringify({ type: "turn.completed", usage: { input_tokens: "many" } })), []);
});

test("a session's turn spent what its total holds past the turns the run kept, or all of it in a new session", () => {
  const first = { input_tokens: 3006, output_tokens: 156, cache_read_tokens: 900, cache_write_tokens: 10 };
  const total = { input_tokens: 6021, output_tokens: 321, cache_read_tokens: 1800, cache_write_tokens: 25 };
  assert.deepEqual(sessionTurnUsage(total, [first]), {
    input_tokens: 3015,
    output_tokens: 165,
    cache_read_tokens: 900,
    cache_write_tokens: 15,
  });
  assert.deepEqual(sessionTurnUsage(first, []), first, "a session's first turn spent its whole total");
  assert.deepEqual(sessionTurnUsage(first, [total]), first, "a total below what the run kept is a new session's");
  assert.deepEqual(
    sessionTurnUsage({ input_tokens: 20, output_tokens: 2, cache_read_tokens: 0 }, [{ input_tokens: 5, output_tokens: 1, cache_read_tokens: 0 }]),
    { input_tokens: 15, output_tokens: 1, cache_read_tokens: 0 },
    "no cache writes when the total reports none",
  );
});

test("a harness turn's usage is recorded with no price, from the subscription", () => {
  const usage = { input_tokens: 12, output_tokens: 140, cache_read_tokens: 0 };
  assert.deepEqual(subscriptionUsageRecord(usage), { usage, cost_usd: 0, cost_source: "subscription" });
});

test("a recorded Cursor chat parses into its messages and its tools' calls as they start and complete", () => {
  const events = parseCursorEvents(RECORDED_CURSOR);
  assert.deepEqual(
    events.map((event) => [event.type, event.type === "tool_started" || event.type === "tool_completed" ? event.tool.name : null]),
    [
      ["tool_started", "read"],
      ["tool_completed", "read"],
      ["message", null],
      ["tool_started", "write"],
      ["tool_completed", "write"],
      ["tool_started", "shell"],
      ["tool_completed", "shell"],
      ["message", null],
    ],
    "the init, the prompt, and a result without usage make no row",
  );
  assert.deepEqual(events[6], {
    type: "tool_completed",
    call_id: "tool_3",
    tool: { name: "shell", server: null, args: { command: "python3 greet.py" }, result: { output: "hello, guild\n", failed: false, exit_code: 0 } },
  });
  assert.equal(events[0]?.type === "tool_started" ? events[0].tool.result : undefined, null, "a call that starts has no result yet");
  assert.deepEqual(events[1]?.type === "tool_completed" ? events[1].tool.result?.output : null, "…", "a read's output is the file's content");
  const write = events[4];
  assert.deepEqual(
    write?.type === "tool_completed" ? JSON.parse(String(write.tool.result?.output)) : null,
    { success: { path: "/home/a_1/repos/app/greet.py", linesCreated: 1, fileSize: 22 } },
    "a result without text is kept as its JSON",
  );
});

test("a Cursor chat's calls are rows under the turn's id; a call of the orchestrator's MCP server makes none; its result's usage counts the cache in the input", () => {
  const mcp = (subtype: string, server: string) =>
    JSON.stringify({
      type: "tool_call",
      subtype,
      call_id: `tool_${server}`,
      tool_call: { mcpToolCall: { args: { name: "note_find", args: { query: "a" }, providerIdentifier: server, toolName: "note_find" } } },
    });
  const failed = JSON.stringify({
    type: "tool_call",
    subtype: "completed",
    call_id: "tool_9",
    tool_call: { shellToolCall: { args: { command: "false" }, result: { error: { error: "exit 1" } } } },
  });
  const usage = JSON.stringify({ type: "result", subtype: "success", usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 20 } });
  const steps = cursorTurnSteps([RECORDED_CURSOR, mcp("started", "guilds"), mcp("completed", "guilds"), mcp("started", "docs"), failed, usage].join("\n"), { TOKEN: "guild" }, "turn_1");
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["message", "result", "message", "message", "result", "message", "result", "message", "message", "result", "turn_usage"],
  );
  assert.deepEqual(steps[0], {
    kind: "message",
    payload: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "turn_1.tool_1", type: "function", function: { name: "read", arguments: '{"path":"/home/a_1/.runs/r_harness/call_task.prompt.md"}' } }],
    },
  });
  const other = steps[8];
  assert.deepEqual(other?.kind === "message" ? other.payload.tool_calls?.[0]?.function.name : null, "note_find", "another server's tool is the harness's own");
  assert.deepEqual(steps[9]?.kind === "result" ? steps[9].result : null, { harness: "cursor", tool_use_id: "turn_1.tool_9", output: "exit 1", failed: true, exit_code: null });
  assert.deepEqual(steps.at(-1), { kind: "turn_usage", usage: { input_tokens: 1020, output_tokens: 40, cache_read_tokens: 900, cache_write_tokens: 20 } });
  assert.match(steps[7]?.kind === "message" ? steps[7].payload.content : "", /\[REDACTED:TOKEN\]/, "a message is redacted");
});

test("a Cursor tool call event that carries its own fields beside the tool's kind is still the tool's call", () => {
  const beside = { hookAdditionalContexts: [], toolCallId: "call-1\nfc_1", startedAtMs: "1794864576842" };
  const event = (subtype: "started" | "completed", toolCall: JsonObject): string =>
    JSON.stringify({ type: "tool_call", subtype, call_id: "call-1\nfc_1", tool_call: { ...toolCall, ...beside }, timestamp_ms: 1794864576852 });
  const shell = { command: "echo hi", toolCallId: "call-1\nfc_1" };
  const ran = { success: { command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "" }, isBackground: false };
  const edited = { success: { path: "/home/a_1/b.txt", linesAdded: 1, diffString: "--- /dev/null\n+++ b/b.txt\n@@ -1,0 +1 @@\n+x" } };
  const guilds = { name: "guilds-note_find", args: { query: "a" }, providerIdentifier: "guilds", toolName: "note_find", serverIdentifier: "guilds" };
  const steps = cursorTurnSteps(
    [
      event("started", { shellToolCall: { args: shell } }),
      event("completed", { shellToolCall: { args: shell, result: ran } }),
      event("completed", { editToolCall: { args: { path: "/home/a_1/b.txt" }, result: edited } }),
      event("started", { mcpToolCall: { args: guilds, description: "Search notes" } }),
      event("started", { hookAdditionalContexts: [] }),
    ].join("\n"),
    {},
    "turn_1",
  );
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["message", "result", "result"],
    "a call of the orchestrator's server's tool and an event that names no tool make no row",
  );
  const started = steps[0];
  assert.deepEqual(started?.kind === "message" ? started.payload.tool_calls?.[0]?.function.name : null, "shell");
  assert.deepEqual(steps[1]?.kind === "result" ? steps[1].result.output : null, "hi\n");
  assert.deepEqual(steps[2]?.kind === "result" ? steps[2].result.output : null, "--- /dev/null\n+++ b/b.txt\n@@ -1,0 +1 @@\n+x");
});

test("a Cursor command that exited otherwise than 0, a failed read, a read the event does not carry, and a waited-for command each say what they returned", () => {
  const completed = (kind: string, result: JsonObject) =>
    JSON.stringify({ type: "tool_call", subtype: "completed", call_id: `tool_${kind}`, tool_call: { [kind]: { args: {}, result } } });
  const failure = { command: "make", exitCode: 2, signal: "", stdout: "building\n", stderr: "make: *** [all] Error 2\n", aborted: false };
  const results = parseCursorEvents(
    [
      completed("shellToolCall", { failure, isBackground: false }),
      completed("shellToolCall", { failure: { ...failure, interleavedOutput: "make: *** [all] Error 2\nbuilding\n" } }),
      completed("readToolCall", { error: { errorMessage: "File not found" } }),
      completed("readToolCall", { success: { path: "/home/a_1/big.ts", isEmpty: false, exceededLimit: false, totalLines: 640, fileSize: 21000, contentBlobId: "blob", readRange: { startLine: 1, endLine: 640 } } }),
      completed("readToolCall", { success: { path: "/home/a_1/shot.png", isEmpty: false, exceededLimit: false, totalLines: 0, fileSize: 137000, dataBlobId: "blob" } }),
      completed("awaitToolCall", { success: { complete: { taskId: "", runtimeMs: "240000", outputFilePath: "", outputLength: "0", regexRequested: false } } }),
      completed("lsToolCall", { success: { entries: [] } }),
    ].join("\n"),
  ).map((event) => (event.type === "tool_completed" ? event.tool.result : null));
  assert.deepEqual(results, [
    { output: "building\n\nmake: *** [all] Error 2\n", failed: true, exit_code: 2 },
    { output: "make: *** [all] Error 2\nbuilding\n", failed: true, exit_code: 2 },
    { output: "File not found", failed: true, exit_code: null },
    { output: "Read lines 1-640 of /home/a_1/big.ts (640 lines, 21000 bytes); Cursor's event does not carry the content.", failed: false, exit_code: null },
    { output: "Read /home/a_1/shot.png (137000 bytes); Cursor's event does not carry the content.", failed: false, exit_code: null },
    { output: "The command completed after 240 s; output length 0.", failed: false, exit_code: null },
    { output: JSON.stringify({ success: { entries: [] } }), failed: false, exit_code: null },
  ]);
});

test("each harness's failed call is a result its row records as failed; a call that succeeded is not", () => {
  const claude = claudeCodeTurnSteps(
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_7", content: "Exit code 1\nnope", is_error: true }] } }),
    {},
  );
  const codexItem = (fields: Record<string, unknown>) => JSON.stringify({ type: "item.completed", item: { id: "item_9", ...fields } });
  const codex = codexTurnSteps(
    [
      codexItem({ type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" }),
      codexItem({ type: "command_execution", command: "rm -rf /", aggregated_output: "", exit_code: null, status: "declined" }),
      codexItem({ type: "file_change", changes: [{ path: "/home/a_1/a.txt", kind: "update" }], status: "failed" }),
      codexItem({ type: "command_execution", command: "true", aggregated_output: "", exit_code: 0, status: "completed" }),
    ].join("\n"),
    {},
    "turn_1",
  );
  const antigravity = antigravityTurnSteps(
    JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: {} } } }),
    {},
    "turn_1",
    new Map(),
  );
  const outcomes = (steps: ReturnType<typeof codexTurnSteps>) =>
    steps.flatMap((step) => (step.kind === "result" ? [[step.result.failed, step.result.exit_code]] : []));
  assert.deepEqual(outcomes(claude), [[true, null]]);
  assert.deepEqual(outcomes(codex), [[true, 1], [true, null], [true, null], [false, 0]]);
  assert.deepEqual(outcomes(antigravity), [[true, null]]);
});

test("a recorded Antigravity turn parses into its responses' pieces, its tools' calls as they start and end, and the conversation's usage", () => {
  const events = parseAntigravityEvents(RECORDED_ANTIGRAVITY);
  assert.deepEqual(
    events.map((event) => (event.type === "text" ? `text ${event.step}${event.done ? " done" : ""}` : `${event.type}${"tool" in event ? ` ${event.tool.name}` : ""}`)),
    [
      "text 1",
      "text 1",
      "text 1",
      "text 1 done",
      "tool_started run_command",
      "tool_ended run_command",
      "text 3 done",
      "tool_started write_to_file",
      "tool_ended write_to_file",
      "text 5 done",
      "tool_started run_command",
      "tool_ended run_command",
      "text 7",
      "text 7",
      "text 7",
      "text 7",
      "text 7",
      "text 7",
      "text 7 done",
      "session_usage",
    ],
    "the init and the user's input make no row",
  );
  assert.deepEqual(events.at(-1), { type: "session_usage", usage: { input_tokens: 4806, output_tokens: 140, cache_read_tokens: 400 } });
  assert.deepEqual(events[11], {
    type: "tool_ended",
    step: 6,
    tool: { name: "run_command", server: null, parameters: { CommandLine: "python3 greet.py" } },
    output: "hello, guild\n",
    failed: false,
  });
});

test("an Antigravity turn's responses are messages once done, its calls rows under the turn's id, and its usage the session's", () => {
  const steps = antigravityTurnSteps(RECORDED_ANTIGRAVITY, { TOKEN: "guild" }, "turn_1", new Map());
  assert.deepEqual(
    steps.map((step) => (step.kind === "message" ? `message ${step.payload.tool_calls?.[0]?.function.name ?? step.payload.content}` : step.kind)),
    [
      "message I'll look at the greeting first.",
      "message run_command",
      "result",
      "message write_to_file",
      "result",
      "message run_command",
      "result",
      'message Changed the greeting in greet.py to "hello, [REDACTED:TOKEN]" and ran it.\n\nShould the greeting also name the agent?',
      "session_usage",
    ],
    "a response without text makes no row",
  );
  assert.deepEqual(steps[1]?.kind === "message" ? steps[1].payload.tool_calls?.[0] : null, {
    id: "turn_1.step_2",
    type: "function",
    function: { name: "run_command", arguments: '{"CommandLine":"cat greet.py"}' },
  });
  assert.deepEqual(steps[4]?.kind === "result" ? steps[4].result : null, { harness: "antigravity", tool_use_id: "turn_1.step_4", output: null, failed: false, exit_code: null });
});

test("a response Antigravity streams over several polls becomes one message once its step is done", () => {
  const read = HARNESS_TURN_STEPS.antigravity("turn_1");
  const lines = RECORDED_ANTIGRAVITY.split("\n");
  const cut = lines.findIndex((line) => line.includes('"text_delta":"greet.py to "'));
  const replies = (steps: ReturnType<typeof read>) =>
    steps.flatMap((step) => (step.kind === "message" && step.payload.content.startsWith("Changed") ? [step.payload.content] : []));
  assert.deepEqual(replies(read(lines.slice(0, cut).join("\n"), {})), [], "no message while its step streams");
  assert.deepEqual(replies(read(lines.slice(cut).join("\n"), {})), [
    'Changed the greeting in greet.py to "hello, guild" and ran it.\n\nShould the greeting also name the agent?',
  ]);
});

test("an Antigravity call of the orchestrator's MCP server, under its prefix or through call_mcp_tool, makes no row; a failed call's error is its output", () => {
  const tool = (state: string, name: string, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ event: "step_update", step_update: { step_index: 4, state, step_type: "tool", tool_name: name, tool_info: { name, parameters, ...extra } } });
  const steps = antigravityTurnSteps(
    [
      tool("ACTIVE", "mcp_guilds_note_find", { query: "a" }),
      tool("DONE", "mcp_guilds_note_find", { query: "a" }, { output: "found" }),
      tool("DONE", "call_mcp_tool", { ServerName: "guilds", ToolName: "note_find", Arguments: {} }, { output: "found" }),
      tool("ERROR", "call_mcp_tool", { ServerName: "docs", ToolName: "search", Arguments: {} }, { error: { type: "TOOL_ERROR", message: "unknown tool" } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 5, state: "DONE", step_type: "user_input" } }),
      "not json",
    ].join("\n"),
    {},
    "turn_2",
    new Map(),
  );
  assert.deepEqual(
    steps.map((step) => (step.kind === "result" ? [step.call?.function.name, step.result.output] : step.kind)),
    [["call_mcp_tool", "unknown tool"]],
  );
  assert.deepEqual(parseAntigravityEvents(JSON.stringify({ event: "result", result: { status: "SUCCESS" } })), [], "a result without usage reads as nothing");
});
