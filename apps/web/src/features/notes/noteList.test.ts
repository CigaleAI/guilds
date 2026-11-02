import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemSections } from "../../api/types/access";
import type { NoteItem } from "../../api/types/notes";
import { newNotePath, searchNotes } from "./noteList";

function file(path: string, title: string | null = null): NoteItem {
  return {
    id: `n_${path}`,
    path,
    display_path: `org/o/${path}`,
    kind: "note",
    title,
    version: 1,
    home: null,
    viewer_mode: "read",
  };
}

const notes: ItemSections<NoteItem> = {
  own: [file("process.md"), file("scoring.md", "How we score leads")],
  shared: [file("sources.md"), file("leads.md")],
};

const keys = (sections: ItemSections<NoteItem>) => ({
  own: sections.own.map((note) => note.path),
  shared: sections.shared.map((note) => note.path),
});

test("without a search, both sections keep every note", () => {
  assert.deepEqual(searchNotes(notes, "  "), notes);
});

test("search keeps the notes whose key or title matches, in each section", () => {
  assert.deepEqual(keys(searchNotes(notes, "Leads")), { own: ["scoring.md"], shared: ["leads.md"] });
  assert.deepEqual(keys(searchNotes(notes, "sources")), { own: [], shared: ["sources.md"] });
  assert.deepEqual(keys(searchNotes(notes, "nothing")), { own: [], shared: [] });
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
