import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { claudeCodeAssistantMessage, claudeCodeTurnSteps, codexTurnSteps, harnessToolRecord, interruptedHarnessToolRecord, NOT_TEXT_OUTPUT } from "../../src/generation/harness-rows.js";
import { parseCodexEvents } from "../../src/generation/parse-codex.js";
import { parseClaudeCodeEvents, type ClaudeCodeMessage } from "../../src/generation/parse-claude-code.js";
import { INTERRUPTED_CONTENT } from "../../src/generation/tool-calls.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = readFileSync(path.join(HERE, "../helpers/harness/claude-code.jsonl"), "utf8");
const RECORDED_CODEX = readFileSync(path.join(HERE, "../helpers/harness/codex.jsonl"), "utf8");

test("a recorded Claude Code turn parses into its messages and its tools' results, in order", () => {
  const events = parseClaudeCodeEvents(RECORDED);
  assert.deepEqual(
    events.map((event) => event.type),
    ["assistant", "user", "assistant", "user", "assistant", "user", "assistant"],
    "the init and result events make no row",
  );
  assert.deepEqual(events[0], {
    type: "assistant",
    content: [
      { type: "text", text: "I'll look at the greeting first." },
      { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/home/a_1/repos/app/greet.py" } },
    ],
  });
  assert.deepEqual(events[1], { type: "user", results: [{ tool_use_id: "toolu_01", output: "1\tprint('hello')\n" }] });
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
  assert.deepEqual(event, { type: "user", results: [{ tool_use_id: "t", output: null }] });
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
  const [payload, metadata] = harnessToolRecord({ harness: "claude-code", tool_use_id: "toolu_03", output: "token tok-123" }, call, 1200, { TOKEN: "tok-123" });
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
    const [long, cut] = harnessToolRecord({ harness: "claude-code", tool_use_id: "toolu_03", output: "x".repeat(5000) }, call, 0, {});
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
  assert.equal(harnessToolRecord({ harness: "claude-code", tool_use_id: "toolu_03", output: null }, call, 0, {})[0].content, NOT_TEXT_OUTPUT);
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
    ["message", "result", "message", "result", "message", "result", "message"],
  );
  assert.deepEqual(steps[1], {
    kind: "result",
    result: { harness: "claude-code", tool_use_id: "toolu_01", output: "1\tprint('hello')\n" },
    call: null,
  });
  assert.equal(claudeCodeTurnSteps(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: " " }] } }), {}).length, 0);
});

test("a recorded Codex turn parses into its tools' calls as they start and complete, and its message", () => {
  const events = parseCodexEvents(RECORDED_CODEX);
  assert.deepEqual(
    events.map((event) => [event.type, event.type === "message" ? null : event.item.type]),
    [
      ["tool_started", "command_execution"],
      ["tool_completed", "command_execution"],
      ["tool_completed", "file_change"],
      ["tool_started", "command_execution"],
      ["tool_completed", "command_execution"],
      ["message", null],
    ],
    "the thread, turn, reasoning and usage events make no row",
  );
  assert.deepEqual(events[1], {
    type: "tool_completed",
    item: { id: "item_1", type: "command_execution", command: "bash -lc 'cat greet.py'", aggregated_output: "print('hello')\n" },
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
    ["message", "result", "result", "message", "result", "message"],
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
    { harness: "codex", tool_use_id: "turn_1.item_2", output: "update /home/a_1/repos/app/greet.py" },
    "file_change",
  ]);
  const reply = steps.at(-1);
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
