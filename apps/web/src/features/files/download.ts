import { downloadFile } from "../../api/files";

/** How a download ended: the browser has the file to save, or the reason it does not. */
export type FileDownload = { kind: "saved" } | { kind: "failed"; reason: string };

/** Hands a file's bytes to the browser to save under its name, and says whether it could. */
export async function attemptFileDownload(id: string, name: string): Promise<FileDownload> {
  try {
    await downloadFile(id, name);
    return { kind: "saved" };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
