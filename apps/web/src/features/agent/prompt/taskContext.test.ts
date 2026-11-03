import assert from "node:assert/strict";
import { test } from "node:test";
import { taskDraftAfterSave, taskEdit } from "./taskContext";

test("a Task without a draft shows the saved text, unchanged", () => {
  const task = { path: "task.md", content: "Plan", version: 3 };
  assert.deepEqual(taskEdit(null, task), {
    saved: "Plan",
    value: "Plan",
    dirty: false,
    conflict: false,
  });
  assert.deepEqual(taskEdit(null, undefined), {
    saved: "",
    value: "",
    dirty: false,
    conflict: false,
  });
});

test("a draft started from the saved version differs without a conflict", () => {
  const task = { path: "task.md", content: "Plan", version: 3 };
  const edit = taskEdit({ text: "Plan more", base: 3 }, task);
  assert.equal(edit.dirty, true);
  assert.equal(edit.conflict, false);
});

test("a draft started from an older version conflicts with the one saved since", () => {
  const task = { path: "task.md", content: "Plan", version: 4 };
  assert.equal(taskEdit({ text: "Plan more", base: 3 }, task).conflict, true);
  assert.equal(taskEdit({ text: "Plan", base: 3 }, task).conflict, false);
  assert.equal(taskEdit({ text: "Plan more", base: undefined }, task).conflict, false);
});

test("a draft that still holds the saved text is cleared once the Task is saved", () => {
  const saved = { path: "task.md", content: "Plan", version: 4 };
  assert.equal(taskDraftAfterSave({ text: "Plan", base: 3 }, "Plan", saved), null);
  assert.equal(taskDraftAfterSave(null, "Plan", saved), null);
});

test("text typed while the Task saved is kept, started from the version just saved", () => {
  const saved = { path: "task.md", content: "Plan", version: 4 };
  const draft = taskDraftAfterSave({ text: "Plan more", base: 3 }, "Plan", saved);
  assert.deepEqual(draft, { text: "Plan more", base: 4 });
  assert.equal(taskEdit(draft, saved).conflict, false);
});
