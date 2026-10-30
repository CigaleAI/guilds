import { ApiError, readApiFailure } from "./client";
import { reportClientError, requestId } from "./clientLog";
import { identityHeaders } from "./session";
import type { ChatAttachment } from "./types/runs";

/** Stores image bytes, then returns the id later messages reference. */
export async function uploadAttachment(file: File): Promise<ChatAttachment> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/octet-stream",
    "X-Filename": file.name,
    "X-Request-Id": requestId(),
    ...identityHeaders(),
  };
  let response: Response;
  try {
    response = await fetch("/api/attachments", {
      method: "POST",
      headers,
      credentials: "same-origin",
      body: file,
    });
  } catch (error) {
    reportClientError({
      kind: "api",
      message: `POST /api/attachments: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }
  if (!response.ok) {
    throw await readApiFailure("POST", "/api/attachments", response);
  }
  return (await response.json()) as ChatAttachment;
}

export async function attachmentIdsOf(files?: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files ?? []) {
    ids.push((await uploadAttachment(file)).id);
  }
  return ids;
}

/** Fetches one image as a blob URL the transcript can show. */
export async function attachmentBlobUrl(id: string): Promise<string> {
  const path = `/api/attachments/${encodeURIComponent(id)}`;
  const response = await fetch(path, {
    headers: {
      "X-Request-Id": requestId(),
      ...identityHeaders(),
    },
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
  return URL.createObjectURL(await response.blob());
}
