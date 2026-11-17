import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageMetadata, RunMessage, ToolCall } from "../../../api/types/runs";
import type { FlowCall } from "../runs/runFlowModel";
import {
  callArguments,
  callMetadata,
  openingView,
  returnedData,
  toolCallFacts,
} from "./callDetail";

function toolCall(name: string, args: string): ToolCall {
  return { id: "call_1", type: "function", function: { name, arguments: args } };
}

/** A committed tool result with its body and metadata. */
function result(content: string, metadata: MessageMetadata = {}): RunMessage {
  return {
    id: 1,
    seq: 1,
    payload: { role: "tool", tool_call_id: "call_1", content },
    metadata,
    created_at: "2026-05-01T12:00:00Z",
    cost_usd: null,
  };
}

function flowCall(
  name: string,
  metadata: MessageMetadata | null,
  patch: Partial<FlowCall> = {},
): FlowCall {
  return {
    id: "call_1",
    call: toolCall(name, '{"path":"a.py"}'),
    result: metadata ? result("", metadata) : null,
    position: 0,
    info: { name, kind: "execute", level: null, server: null, harness: null },
    error: null,
    ...patch,
  };
}

const codeTask: MessageMetadata = { tool_name: "code_task", duration_ms: 64_000 };

test("a call opens on its result once it failed", () => {
  assert.equal(openingView(flowCall("shell", null, { error: "boom" }), undefined), "result");
});

test("a call opens on its result once it reported progress", () => {
  const progress = { lines: ["read a.py"] };
  assert.equal(openingView(flowCall("code_task", null), progress), "result");
});

test("a call opens on its arguments before it fails or reports anything", () => {
  const progress = { lines: [] };
  assert.equal(openingView(flowCall("code_task", null), progress), "arguments");
  assert.equal(openingView(flowCall("code_task", null), undefined), "arguments");
});

test("an old code_task call lists only the facts any tool call has", () => {
  assert.deepEqual(toolCallFacts(flowCall("code_task", codeTask)), [
    ["Call", "call_1"],
    ["Tool", "code_task"],
    ["Duration", "1m 04s"],
    ["Committed", "2026-05-01T12:00:00Z"],
  ]);
});

test("a tool lists how it ran", () => {
  const metadata: MessageMetadata = {
    duration_ms: 1200,
    output_filter: "tail",
    exit_code: 0,
    original_bytes: 9000,
    stored_bytes: 4000,
    remaining_tool_calls: 12,
  };
  assert.deepEqual(toolCallFacts(flowCall("script_run", metadata, { id: "" })), [
    ["Call", "—"],
    ["Tool", "script_run"],
    ["Duration", "1.2s"],
    ["Output filter", "tail"],
    ["Exit code", "0"],
    ["Bytes", "9000 → 4000 stored"],
    ["Tool calls left", "12"],
    ["Committed", "2026-05-01T12:00:00Z"],
  ]);
});

test("a call's metadata is empty before its result", () => {
  assert.deepEqual(callMetadata(flowCall("shell", null)), {});
  assert.deepEqual(callMetadata(flowCall("shell", { exit_code: 0 })), { exit_code: 0 });
});

test("a call's arguments come from its function call", () => {
  assert.deepEqual(callArguments(flowCall("read", null)).parsed, { path: "a.py" });
  assert.equal(callArguments(flowCall("read", null, { call: toolCall("read", "") })).isEmpty, true);
});

test("a result's returned data leaves out the remaining tool calls line", () => {
  const returned = returnedData(result("done\n\nremaining_tool_calls: 4"));
  assert.equal(returned.text, "done");
});

test("another tool's returned data keeps a log line", () => {
  const returned = returnedData(result("ok\nlog: kept"));
  assert.equal(returned.text, "ok\nlog: kept");
});

test("a call of a harness's own tool names the harness that called it", () => {
  const facts = toolCallFacts(
    flowCall("Bash", { tool_name: "Bash", from_harness: "claude-code", duration_ms: 1200 }),
  );
  assert.deepEqual(facts.slice(0, 3), [
    ["Call", "call_1"],
    ["Tool", "Bash"],
    ["Called by", "Claude Code"],
  ]);
});
