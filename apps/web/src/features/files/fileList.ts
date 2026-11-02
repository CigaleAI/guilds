import { ApiError } from "../../api/client";
import { FILE_MAX_BYTES } from "../../api/files";
import { formatSize } from "../../app/format";
import type { ItemSections } from "../../api/types/access";
import type { FileItem } from "../../api/types/files";
import { filterSections } from "../access/listedItems";

/** A page's files whose name or description holds the search, in each section; all of them without one. */
export function searchFiles(sections: ItemSections<FileItem>, query: string): ItemSections<FileItem> {
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return filterSections(sections, (item) =>
    `${item.name} ${item.description}`.toLowerCase().includes(needle),
  );
}

/** Why an upload cannot be sent, or null when it can: a file is chosen, fits, and is described. */
export function uploadProblem(file: Pick<File, "size"> | null, description: string): string | null {
  if (!file) return "Choose a file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > FILE_MAX_BYTES) return `A file is at most ${formatSize(FILE_MAX_BYTES)}.`;
  return description.trim() ? null : "Say what the file is.";
}

/** One line under a file's name: its size, media type, who saved it, and when. */
export function fileMeta(item: FileItem, when: string): string {
  return [formatSize(item.bytes), item.mime, `${item.author} · ${when}`].join(" · ");
}

/**
 * The version an upload of a file with this name expects: the listed file's of that name, which the
 * upload replaces, or 0 when the list holds none, so the upload only creates.
 */
export function uploadExpectedVersion(name: string, listed: readonly FileItem[]): number {
  return listed.find((item) => item.name === name)?.version ?? 0;
}

/** Why an upload failed, in words: a 409 says what the expected version ran into, else the server's message. */
export function uploadFailure(error: Error, expectedVersion: number | undefined): string {
  if (!(error instanceof ApiError && error.status === 409)) return error.message;
  return expectedVersion === 0
    ? "A file with this name already exists in the organisation, outside this list."
    : "The file was replaced since this list loaded. Upload again to replace the new version.";
}
