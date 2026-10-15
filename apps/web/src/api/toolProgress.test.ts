import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyToolProgress,
  dropToolProgress,
  progressLineCount,
  progressLinesKept,
} from "./toolProgress";

test("applyToolProgress appends each event's new lines to its call", () => {
  const first = applyToolProgress(
    {},
    { run_id: "r1", tool_call_id: "c1", lines: ["read a.py"], session_id: null },
  );
  assert.deepEqual(first, { c1: { lines: ["read a.py"], session_id: null } });
  const second = applyToolProgress(first, {
    run_id: "r1",
    tool_call_id: "c1",
    lines: ["edit a.py", "run tests"],
    session_id: "s1",
  });
  assert.deepEqual(second.c1, { lines: ["read a.py", "edit a.py", "run tests"], session_id: "s1" });
  const other = applyToolProgress(second, { tool_call_id: "c2", lines: ["start"] });
  assert.deepEqual(Object.keys(other), ["c1", "c2"]);
  assert.equal(progressLineCount(other), 4);
});

test("applyToolProgress keeps a known session and ignores empty or malformed events", () => {
  const known = { c1: { lines: ["a"], session_id: "s1" } };
  assert.equal(
    applyToolProgress(known, { tool_call_id: "c1", lines: [], session_id: null }),
    known,
  );
  assert.equal(applyToolProgress(known, null), known);
  assert.equal(applyToolProgress(known, { lines: ["x"] }), known);
  assert.equal(
    applyToolProgress(known, { tool_call_id: "c1", lines: ["b"], session_id: null }).c1?.session_id,
    "s1",
  );
});

test("applyToolProgress ignores data that is not an object or names no call", () => {
  const known = { c1: { lines: ["a"], session_id: null } };
  assert.equal(applyToolProgress(known, "read a.py"), known);
  assert.equal(applyToolProgress(known, { tool_call_id: "", lines: ["x"] }), known);
  assert.equal(applyToolProgress(known, { tool_call_id: 7, lines: ["x"] }), known);
});

test("applyToolProgress keeps only the string lines of an event", () => {
  const progress = applyToolProgress({}, { tool_call_id: "c1", lines: ["a", 2, null, "b"] });
  assert.deepEqual(progress.c1?.lines, ["a", "b"]);
  assert.deepEqual(applyToolProgress({}, { tool_call_id: "c1", lines: "a" }).c1?.lines, []);
});

test("applyToolProgress records a new call even before it reports a line", () => {
  assert.deepEqual(applyToolProgress({}, { tool_call_id: "c1", session_id: "s1" }), {
    c1: { lines: [], session_id: "s1" },
  });
});

test("applyToolProgress takes a new session from an event without lines", () => {
  const known = { c1: { lines: ["a"], session_id: "s1" } };
  assert.deepEqual(applyToolProgress(known, { tool_call_id: "c1", session_id: "s2" }).c1, {
    lines: ["a"],
    session_id: "s2",
  });
});

test("applyToolProgress treats an empty session as none", () => {
  const known = { c1: { lines: ["a"], session_id: "s1" } };
  assert.equal(applyToolProgress(known, { tool_call_id: "c1", session_id: "" }), known);
  assert.equal(
    applyToolProgress(known, { tool_call_id: "c1", lines: ["b"], session_id: "" }).c1?.session_id,
    "s1",
  );
});

test("applyToolProgress keeps only the latest lines", () => {
  const lines = Array.from({ length: progressLinesKept + 5 }, (_, index) => `line ${index}`);
  const progress = applyToolProgress({}, { tool_call_id: "c1", lines });
  assert.equal(progress.c1?.lines.length, progressLinesKept);
  assert.equal(progress.c1?.lines[0], "line 5");
});

test("dropToolProgress forgets only the finished call", () => {
  const progress = {
    c1: { lines: ["a"], session_id: null },
    c2: { lines: ["b"], session_id: null },
  };
  assert.deepEqual(Object.keys(dropToolProgress(progress, "c1")), ["c2"]);
  assert.equal(dropToolProgress(progress, "c3"), progress);
  assert.equal(dropToolProgress(progress, undefined), progress);
});
