import { FILE_MAX_BYTES } from "../../api/files";
import { formatSize } from "../../app/format";
import type { FileItem } from "../../api/types";

/** The files whose name or description holds the search, in the server's order. */
export function filterFiles(items: readonly FileItem[], query: string): FileItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(needle));
}

/** Why an upload cannot be sent, or null when it can: a file is chosen, fits, and is described. */
export function uploadProblem(file: { size: number } | null, description: string): string | null {
  if (!file) return "Choose a file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > FILE_MAX_BYTES) return `A file is at most ${formatSize(FILE_MAX_BYTES)}.`;
  return description.trim() ? null : "Say what the file is.";
}

/** One line under a file's name: its size, media type, who saved it, and when. */
export function fileMeta(item: FileItem, when: string): string {
  return [formatSize(item.bytes), item.mime, `${item.author} · ${when}`].join(" · ");
}
