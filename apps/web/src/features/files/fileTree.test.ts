import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileItem } from "../../api/types";
import { buildTree, newNotePath } from "./fileTree";

function file(path: string): FileItem {
  return { path, display_path: `org/o/agents/a/${path}`, kind: "note", title: null, version: 1 };
}

const notes = [file("process.md"), file("scoring.md"), file("sources.md")];

test("a scope's tree is its notes side by side, without a folder", () => {
  assert.deepEqual(
    buildTree(notes).map((node) => [node.id, node.name, node.kind]),
    [
      ["org/o/agents/a/process.md", "process.md", "file"],
      ["org/o/agents/a/scoring.md", "scoring.md", "file"],
      ["org/o/agents/a/sources.md", "sources.md", "file"],
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

test("a new note's name gets .md and refuses folders, reserved or taken names", () => {
  assert.deepEqual(newNotePath(" ideas ", notes), { path: "ideas.md" });
  assert.deepEqual(newNotePath("ideas.md", notes), { path: "ideas.md" });
  assert.deepEqual(newNotePath("", notes), { error: "Enter a file name." });
  assert.deepEqual(newNotePath("research/ideas", notes), {
    error: "Notes have no folders; leave / out of the name.",
  });
  assert.ok("error" in newNotePath("research\\ideas", notes));
  assert.ok("error" in newNotePath("memory", notes));
  assert.ok("error" in newNotePath("task.md", notes));
  assert.deepEqual(newNotePath("process", notes), {
    error: "A note with this name already exists.",
  });
});
