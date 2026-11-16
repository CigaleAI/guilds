import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyToolProgress,
  dropToolProgress,
  progressLineCount,
  progressLinesKept,
  type CallProgress,
  type ToolProgress,
} from "./toolProgress";
import type { ToolProgressEvent } from "./types/runs";

/** A `tool.progress` event of run r1 for call `callId`. */
function event(callId: string, lines: string[]): ToolProgressEvent {
  return { run_id: "r1", tool_call_id: callId, lines };
}

/** The progress held for one call. */
function holding(callId: string, call: CallProgress): ToolProgress {
  return new Map([[callId, call]]);
}

test("applyToolProgress appends each event's new lines to its call", () => {
  const first = applyToolProgress(new Map(), event("c1", ["read a.py"]));
  assert.deepEqual(first, holding("c1", { lines: ["read a.py"] }));
  const second = applyToolProgress(first, event("c1", ["edit a.py", "run tests"]));
  assert.deepEqual(second.get("c1"), { lines: ["read a.py", "edit a.py", "run tests"] });
  const other = applyToolProgress(second, event("c2", ["start"]));
  assert.deepEqual([...other.keys()], ["c1", "c2"]);
  assert.equal(progressLineCount(other), 4);
});

test("applyToolProgress ignores an event that adds no line", () => {
  const known = holding("c1", { lines: ["a"] });
  assert.equal(applyToolProgress(known, event("c1", [])), known);
  assert.equal(applyToolProgress(new Map(), event("c1", [])).size, 0);
});

test("applyToolProgress ignores an event that names no call", () => {
  const known = holding("c1", { lines: ["a"] });
  assert.equal(applyToolProgress(known, event("", ["x"])), known);
});

test("applyToolProgress keeps only the latest lines", () => {
  const lines = Array.from({ length: progressLinesKept + 5 }, (_, index) => `line ${index}`);
  const progress = applyToolProgress(new Map(), event("c1", lines));
  assert.equal(progress.get("c1")?.lines.length, progressLinesKept);
  assert.equal(progress.get("c1")?.lines[0], "line 5");
});

test("dropToolProgress forgets only the finished call", () => {
  const progress: ToolProgress = new Map([
    ["c1", { lines: ["a"] }],
    ["c2", { lines: ["b"] }],
  ]);
  assert.deepEqual([...dropToolProgress(progress, "c1").keys()], ["c2"]);
  assert.equal(dropToolProgress(progress, "c3"), progress);
});
