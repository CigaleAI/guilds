import { ApiError, readApiFailure } from "./client";
import { requestId } from "./clientLog";
import { identityHeaders } from "./session";
import type { FileItem, FileUpload } from "./types/files";
import { hasFields, isNumber, isJsonObject, isString } from "./wire";

/** Where every upload goes: the organisation holds every shared file. */
const uploadPath = "/api/org/files";

/** The largest file the server stores; the picker refuses a bigger one before sending it. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Stores a file's bytes in the organisation with its description, its access list starting with
 * the upload's row; a file of the same name is replaced.
 */
export async function uploadFile(upload: FileUpload): Promise<FileItem> {
  const { file, description, access } = upload;
  const response = await fetch(uploadPath, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "X-Request-Id": requestId(),
      ...identityHeaders(),
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
      "X-Description": encodeURIComponent(description),
      ...(file.type ? { "X-Mime": file.type } : {}),
      "X-Access-Type": access.type,
      "X-Access-Id": access.id,
      "X-Access-Mode": access.mode,
    },
    credentials: "same-origin",
    body: file,
  });
  if (!response.ok) {
    throw await readApiFailure("POST", uploadPath, response);
  }
  const reply: unknown = await response.json();
  if (!isFileItem(reply)) {
    throw new ApiError(response.status, "The server's reply is not a stored file.");
  }
  return reply;
}

/** Whether a reply is a stored file, as a files list holds one. */
export function isFileItem(value: unknown): value is FileItem {
  return (
    isJsonObject(value) &&
    hasFields(
      value,
      ["id", "display_path", "name", "description", "mime", "author", "updated_at"],
      isString,
    ) &&
    hasFields(value, ["bytes", "version"], isNumber) &&
    (value.access === undefined || value.access === "read" || value.access === "write")
  );
}

/** Fetches a file's bytes as the operator and hands them to the browser to save under its name. */
export async function downloadFile(id: string, name: string): Promise<void> {
  const path = `/api/files/${encodeURIComponent(id)}`;
  const response = await fetch(path, {
    headers: { Accept: "application/json", "X-Request-Id": requestId(), ...identityHeaders() },
    credentials: "same-origin",
  });
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
