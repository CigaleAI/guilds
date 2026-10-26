import type { NoteItem } from "../../api/types";
import type { FileTreeNode } from "@guildsrun/ui";
/** Names a note cannot take: the agent's Task and memory live under them. */
const reservedFiles = ["task.md", "memory.md"];

function matches(item: NoteItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${item.path} ${item.title ?? ""}`.toLowerCase().includes(needle);
}

/** A scope's notes that match the search, side by side in the server's order. */
export function buildTree(items: readonly NoteItem[], query = ""): FileTreeNode[] {
  return items
    .filter((item) => matches(item, query))
    .map((item) => ({ id: item.display_path, name: item.path, kind: "file" }));
}

/**
 * The file name a new note gets from what the operator typed, or why it cannot be made: `.md` is
 * added, and folders, reserved names and existing notes refused.
 */
export function newNotePath(
  typed: string,
  existing: readonly Pick<NoteItem, "path">[],
): { path: string } | { error: string } {
  let path = typed.trim();
  if (!path) return { error: "Enter a file name." };
  if (/[/\\]/.test(path)) return { error: "Notes have no folders; leave / out of the name." };
  if (path === "." || path === "..") return { error: "Enter a file name." };
  if (!path.endsWith(".md")) path = `${path}.md`;
  if (reservedFiles.includes(path)) return { error: "That name is reserved; pick another." };
  if (existing.some((item) => item.path === path))
    return { error: "A note with this name already exists." };
  return { path };
}
