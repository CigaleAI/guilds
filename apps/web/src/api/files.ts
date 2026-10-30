import { readApiFailure } from "./client";
import { requestId } from "./clientLog";
import { identityHeaders } from "./session";
import type { FileItem } from "./types/files";

/** A files scope's API root: `/api/agents/:id/files`, `/api/guilds/:id/files` or `/api/org/files`. */
export type FilesPrefix = string;

/** The largest file the server stores; the picker refuses a bigger one before sending it. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;

function bytesHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Request-Id": requestId(),
    ...identityHeaders(),
    ...extra,
  };
}

/** Stores a file's bytes under a scope with its description; a file of the same name there is replaced. */
export async function uploadFile(prefix: FilesPrefix, file: File, description: string): Promise<FileItem> {
  const response = await fetch(prefix, {
    method: "POST",
    headers: bytesHeaders({
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
      "X-Description": encodeURIComponent(description),
      ...(file.type ? { "X-Mime": file.type } : {}),
    }),
    credentials: "same-origin",
    body: file,
  });
  if (!response.ok) {
    throw await readApiFailure("POST", prefix, response);
  }
  return (await response.json()) as FileItem;
}

/** Fetches a file's bytes as the operator and hands them to the browser to save under its name. */
export async function downloadFile(id: string, name: string): Promise<void> {
  const path = `/api/files/${encodeURIComponent(id)}`;
  const response = await fetch(path, { headers: bytesHeaders({}), credentials: "same-origin" });
  if (!response.ok) {
    throw await readApiFailure("GET", path, response);
  }
  const url = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
