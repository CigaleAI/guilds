import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowCall } from "../runs/runFlowModel";
import {
  callArguments,
  callHarness,
  callMetadata,
  hasTaskDiff,
  hasTaskLog,
  openingView,
  returnedData,
  toolCallFacts,
} from "./callDetail";

function flowCall(
  name: string,
  metadata: Record<string, unknown> | null,
  patch: Partial<FlowCall> = {},
): FlowCall {
  return {
    id: "call_1",
    call: { function: { name, arguments: '{"path":"a.py"}' } },
    result: metadata ? { metadata, created_at: "2026-05-01T12:00:00Z" } : null,
    position: 0,
    info: { name, kind: "execute", level: null, server: null },
    error: null,
    ...patch,
  };
}

const codeTask = {
  tool_name: "code_task",
  status: "completed",
  harness: "codex",
  repository: "guilds/web",
  session_id: "sess_1",
  files_changed: 2,
  insertions: 14,
  deletions: 3,
  start_sha: "1111111aaaa",
  end_sha: "2222222bbbb",
  log_path: "runs/r1/harness.log",
};

test("a call opens on its result once it failed", () => {
  assert.equal(openingView(flowCall("shell", null, { error: "boom" }), undefined), "result");
});

test("a call opens on its result once it reported progress", () => {
  const progress = { lines: ["read a.py"], session_id: null };
  assert.equal(openingView(flowCall("code_task", null), progress), "result");
});

test("a call opens on its arguments before it fails or reports anything", () => {
  const progress = { lines: [], session_id: null };
  assert.equal(openingView(flowCall("code_task", null), progress), "arguments");
  assert.equal(openingView(flowCall("code_task", null), undefined), "arguments");
});

test("a code task of a known run with an end checkpoint has a diff", () => {
  assert.equal(hasTaskDiff(flowCall("code_task", codeTask), "run_1"), true);
});

test("a call has no diff without a run, an end checkpoint, or a code task", () => {
  assert.equal(hasTaskDiff(flowCall("code_task", codeTask), undefined), false);
  assert.equal(hasTaskDiff(flowCall("code_task", { ...codeTask, end_sha: "" }), "run_1"), false);
  assert.equal(hasTaskDiff(flowCall("code_task", null), "run_1"), false);
  assert.equal(hasTaskDiff(flowCall("shell", codeTask), "run_1"), false);
});

test("a code task lists its status, harness, repository, session, changes and checkpoints", () => {
  assert.deepEqual(toolCallFacts(flowCall("code_task", codeTask), null), [
    ["Call", "call_1"],
    ["Tool", "code_task"],
    ["Status", "completed"],
    ["Harness", "Codex"],
    ["Repository", "guilds/web"],
    ["Session", "sess_1"],
    ["Changes", "2 files · +14 −3"],
    ["Checkpoints", "1111111 → 2222222"],
    ["Harness log", "runs/r1/harness.log"],
    ["Committed", "2026-05-01T12:00:00Z"],
  ]);
});

test("a running code task takes its session from its progress", () => {
  const facts = toolCallFacts(flowCall("code_task", null), "sess_live");
  assert.deepEqual(facts, [
    ["Call", "call_1"],
    ["Tool", "code_task"],
    ["Session", "sess_live"],
  ]);
});

test("a code task shows no checkpoints without both shas", () => {
  const facts = toolCallFacts(flowCall("code_task", { ...codeTask, end_sha: null }), null);
  assert.equal(
    facts.some(([label]) => label === "Checkpoints"),
    false,
  );
});

test("another tool lists how it ran, without code task facts", () => {
  const metadata = {
    duration_ms: 1200,
    output_filter: "tail",
    exit_code: 0,
    log_path: "runs/r1/out.log",
    cwd: "/home/agent",
    path: "a.py",
    range: [3, 9],
    repeat_of: 2,
    original_bytes: 9000,
    stored_bytes: 4000,
    remaining_tool_calls: 12,
  };
  assert.deepEqual(toolCallFacts(flowCall("shell", metadata, { id: "" }), "sess_live"), [
    ["Call", "—"],
    ["Tool", "shell"],
    ["Duration", "1.2s"],
    ["Output filter", "tail"],
    ["Exit code", "0"],
    ["Full output", "runs/r1/out.log"],
    ["Working directory", "/home/agent"],
    ["File", "a.py"],
    ["Lines", "3–9"],
    ["Same as step", "2"],
    ["Bytes", "9000 → 4000 stored"],
    ["Tool calls left", "12"],
    ["Committed", "2026-05-01T12:00:00Z"],
  ]);
});

test("a call's metadata is empty before its result, or when it is not an object", () => {
  assert.deepEqual(callMetadata(flowCall("shell", null)), {});
  const listed = flowCall("shell", null, {
    result: { metadata: [] as unknown as Record<string, unknown> },
  });
  assert.deepEqual(callMetadata(listed), {});
});

test("a call's arguments come from its function call", () => {
  assert.deepEqual(callArguments(flowCall("read", null)).parsed, { path: "a.py" });
  assert.equal(callArguments(flowCall("read", null, { call: {} })).isEmpty, true);
});

test("a result's returned data leaves out the remaining tool calls line", () => {
  const returned = returnedData({ payload: { content: "done\n\nremaining_tool_calls: 4" } });
  assert.equal(returned.text, "done");
});

test("a code task's returned data leaves out its closing log line", () => {
  const returned = returnedData({
    payload: { content: "completed · codex\n\nDone.\n\nlog: .runs/r1/c1.harness.jsonl" },
    metadata: { tool_name: "code_task" },
  });
  assert.equal(returned.text, "completed · codex\n\nDone.");
});

test("another tool's returned data keeps a log line", () => {
  const returned = returnedData({ payload: { content: "ok\nlog: kept" } });
  assert.equal(returned.text, "ok\nlog: kept");
});

test("a code task runs on the harness its result names, else the run's", () => {
  assert.equal(callHarness(flowCall("code_task", codeTask), "cursor"), "codex");
  assert.equal(callHarness(flowCall("code_task", null), "cursor"), "cursor");
  assert.equal(callHarness(flowCall("code_task", null), null), null);
  assert.equal(callHarness(flowCall("shell", null), "cursor"), null);
});

test("a code task naming its log has a Log view, given its run", () => {
  assert.equal(hasTaskLog(flowCall("code_task", codeTask), "r1"), true);
  assert.equal(hasTaskLog(flowCall("code_task", codeTask), undefined), false);
  assert.equal(hasTaskLog(flowCall("code_task", { ...codeTask, log_path: null }), "r1"), false);
  assert.equal(hasTaskLog(flowCall("shell", { log_path: "/tmp/out.log" }), "r1"), false);
});
