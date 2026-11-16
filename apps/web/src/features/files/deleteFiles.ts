import type { ToastOptions } from "@guildsrun/ui";
import type { FileItem } from "../../api/types/files";

/** A file a bulk delete could not remove, and the server's reason. */
export type FileDeletionFailure = { file: FileItem; reason: string };

/** What a bulk delete did: the files it removed and those it could not, each in the order asked. */
export type FileDeletionOutcome = { deleted: FileItem[]; failed: FileDeletionFailure[] };

/**
 * Deletes the files one at a time, in order, each through `deleteFile`, so one request is in flight
 * at most. A refused file is recorded with its reason and the next one is still sent.
 */
export async function deleteFilesInTurn(
  files: readonly FileItem[],
  deleteFile: (id: string) => Promise<undefined>,
): Promise<FileDeletionOutcome> {
  const outcome: FileDeletionOutcome = { deleted: [], failed: [] };
  for (const file of files) {
    await deleteFile(file.id).then(
      () => outcome.deleted.push(file),
      (error: Error) => outcome.failed.push({ file, reason: error.message }),
    );
  }
  return outcome;
}

/** The toast after a bulk delete that refused some files: how many, and each one's name and reason. */
export function fileDeletionFailureToast(failed: readonly FileDeletionFailure[]): ToastOptions {
  return {
    kind: "error",
    title: `Couldn't delete ${failed.length} ${failed.length === 1 ? "file" : "files"}`,
    description: failed.map(({ file, reason }) => `${file.name}: ${reason}`).join("\n"),
  };
}
