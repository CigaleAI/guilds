import assert from "node:assert/strict";
import { test } from "node:test";
import type { NoteItem } from "../../api/types/notes";
import { buildTree, newNotePath } from "./noteTree";

function file(path: string): NoteItem {
  return {
    id: `n_${path}`,
    path,
    display_path: `org/o/${path}`,
    kind: "note",
    title: null,
    version: 1,
  };
}

const notes = [file("process.md"), file("scoring.md"), file("sources.md")];

test("a list's tree is its notes side by side, without a folder", () => {
  assert.deepEqual(
    buildTree(notes).map((node) => [node.id, node.name, node.kind]),
    [
      ["org/o/process.md", "process.md", "file"],
      ["org/o/scoring.md", "scoring.md", "file"],
      ["org/o/sources.md", "sources.md", "file"],
    ],
  );
});

test("search keeps the matching notes", () => {
  assert.deepEqual(
    buildTree(notes, "scoring").map((node) => node.name),
    ["scoring.md"],
  );
  assert.deepEqual(buildTree(notes, "nothing"), []);
});

test("a new note's name gets .md and refuses folders and reserved names", () => {
  assert.deepEqual(newNotePath(" ideas "), { path: "ideas.md" });
  assert.deepEqual(newNotePath("ideas.md"), { path: "ideas.md" });
  assert.deepEqual(newNotePath(""), { error: "Enter a file name." });
  assert.deepEqual(newNotePath("research/ideas"), {
    error: "Notes have no folders; leave / out of the name.",
  });
  assert.ok("error" in newNotePath("research\\ideas"));
  assert.ok("error" in newNotePath("memory"));
  assert.ok("error" in newNotePath("task.md"));
});
