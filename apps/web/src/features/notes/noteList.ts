import type { ItemSections } from "../../api/types/access";
import type { NoteItem } from "../../api/types/notes";
import { filterSections } from "../access/listedItems";

/** Names a note cannot take: the agent's Task and memory live under them. */
const reservedFiles = ["task.md", "memory.md"];

/** A page's notes whose key or title holds the search, in each section; all of them without one. */
export function searchNotes(sections: ItemSections<NoteItem>, query: string): ItemSections<NoteItem> {
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return filterSections(sections, (item) =>
    `${item.path} ${item.title ?? ""}`.toLowerCase().includes(needle),
  );
}

/**
 * The file name a new note gets from what the operator typed, or why it cannot be made: `.md` is
 * added, and folders and reserved names refused.
 */
export function newNotePath(typed: string): { path: string } | { error: string } {
  let path = typed.trim();
  if (!path) return { error: "Enter a file name." };
  if (/[/\\]/.test(path)) return { error: "Notes have no folders; leave / out of the name." };
  if (path === "." || path === "..") return { error: "Enter a file name." };
  if (!path.endsWith(".md")) path = `${path}.md`;
  if (reservedFiles.includes(path)) return { error: "That name is reserved; pick another." };
  return { path };
}
