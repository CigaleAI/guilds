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
function event(callId: string, lines: string[], session?: string | null): ToolProgressEvent {
  return {
    run_id: "r1",
    tool_call_id: callId,
    lines,
    ...(session === undefined ? {} : { session_id: session }),
  };
}

/** The progress held for one call. */
function holding(callId: string, call: CallProgress): ToolProgress {
  return new Map([[callId, call]]);
}

test("applyToolProgress appends each event's new lines to its call", () => {
  const first = applyToolProgress(new Map(), event("c1", ["read a.py"], null));
  assert.deepEqual(first, holding("c1", { lines: ["read a.py"], session_id: null }));
  const second = applyToolProgress(first, event("c1", ["edit a.py", "run tests"], "s1"));
  assert.deepEqual(second.get("c1"), {
    lines: ["read a.py", "edit a.py", "run tests"],
    session_id: "s1",
  });
  const other = applyToolProgress(second, event("c2", ["start"]));
  assert.deepEqual([...other.keys()], ["c1", "c2"]);
  assert.equal(progressLineCount(other), 4);
});

test("applyToolProgress keeps a known session and ignores an event that adds nothing", () => {
  const known = holding("c1", { lines: ["a"], session_id: "s1" });
  assert.equal(applyToolProgress(known, event("c1", [], null)), known);
  assert.equal(applyToolProgress(known, event("c1", ["b"], null)).get("c1")?.session_id, "s1");
});

test("applyToolProgress ignores an event that names no call", () => {
  const known = holding("c1", { lines: ["a"], session_id: null });
  assert.equal(applyToolProgress(known, event("", ["x"])), known);
});

test("applyToolProgress records a new call even before it reports a line", () => {
  assert.deepEqual(
    applyToolProgress(new Map(), event("c1", [], "s1")),
    holding("c1", { lines: [], session_id: "s1" }),
  );
});

test("applyToolProgress takes a new session from an event without lines", () => {
  const known = holding("c1", { lines: ["a"], session_id: "s1" });
  assert.deepEqual(applyToolProgress(known, event("c1", [], "s2")).get("c1"), {
    lines: ["a"],
    session_id: "s2",
  });
});

test("applyToolProgress treats an empty session as none", () => {
  const known = holding("c1", { lines: ["a"], session_id: "s1" });
  assert.equal(applyToolProgress(known, event("c1", [], "")), known);
  assert.equal(applyToolProgress(known, event("c1", ["b"], "")).get("c1")?.session_id, "s1");
});

test("applyToolProgress keeps only the latest lines", () => {
  const lines = Array.from({ length: progressLinesKept + 5 }, (_, index) => `line ${index}`);
  const progress = applyToolProgress(new Map(), event("c1", lines));
  assert.equal(progress.get("c1")?.lines.length, progressLinesKept);
  assert.equal(progress.get("c1")?.lines[0], "line 5");
});

test("dropToolProgress forgets only the finished call", () => {
  const progress: ToolProgress = new Map([
    ["c1", { lines: ["a"], session_id: null }],
    ["c2", { lines: ["b"], session_id: null }],
  ]);
  assert.deepEqual([...dropToolProgress(progress, "c1").keys()], ["c2"]);
  assert.equal(dropToolProgress(progress, "c3"), progress);
});
