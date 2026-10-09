import path from "node:path";
import { AgentFileError, readAgentFile } from "../../lib/agent-file.js";
import { DRIVE_FOLDER_MIME, DriveFolderError, driveJson, type DriveClientOptions } from "./folder.js";

export const MAX_DRIVE_UPLOAD_BYTES = 25 * 1024 * 1024;

export const DRIVE_CREATE_FILE_DESCRIPTION =
  "Create a file or folder in the connected Drive folder. Pass file_path under /home/agent for file bytes; the orchestrator reads and encodes them. Do not pass base64. Small UTF-8 text may use textContent. To create a folder, set title and contentMimeType application/vnd.google-apps.folder.";

export const DRIVE_CREATE_FILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", description: "File or folder name." },
    file_path: {
      type: "string",
      description: "Path under /home/agent. The orchestrator reads this file. Do not pass file bytes.",
    },
    textContent: {
      type: "string",
      description: "UTF-8 text for a small file. Use file_path for large or binary files.",
    },
    contentMimeType: {
      type: "string",
      description:
        "MIME type of the content. Inferred from file_path when omitted. Use application/vnd.google-apps.folder to create a folder.",
    },
    parentId: {
      type: "string",
      description: "Parent folder id. Defaults to the connected folder.",
    },
    disableConversionToGoogleType: {
      type: "boolean",
      description: "Keep the given MIME type instead of converting to a Google type.",
    },
  },
};

const MIME_BY_EXT: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

function argString(arguments_: Record<string, unknown>, camel: string, snake: string): string {
  const camelVal = arguments_[camel];
  if (typeof camelVal === "string" && camelVal.trim()) {
    return camelVal.trim();
  }
  const snakeVal = arguments_[snake];
  if (typeof snakeVal === "string" && snakeVal.trim()) {
    return snakeVal.trim();
  }
  return "";
}

export async function attachDriveCreateFile(
  arguments_: Record<string, unknown>,
  workspaceDir?: string,
): Promise<Record<string, unknown>> {
  const filePath = argString(arguments_, "file_path", "filePath");
  if (!filePath) {
    const next = { ...arguments_ };
    delete next.file_path;
    delete next.filePath;
    return next;
  }
  if (!workspaceDir) {
    throw new DriveFolderError("file_path is only available during an agent run");
  }
  let resolved: string;
  let bytes: Buffer;
  try {
    ({ path: resolved, bytes } = await readAgentFile(workspaceDir, filePath, { maxBytes: MAX_DRIVE_UPLOAD_BYTES }));
  } catch (error) {
    if (error instanceof AgentFileError) {
      throw new DriveFolderError(
        error.problem === "too_large" ? "file_path is larger than 25 MB" : error.message,
        { cause: error },
      );
    }
    throw error;
  }
  const mime = argString(arguments_, "contentMimeType", "content_mime_type")
    || MIME_BY_EXT[path.extname(resolved).toLowerCase()]
    || "application/octet-stream";
  const title =
    typeof arguments_.title === "string" && arguments_.title.trim()
      ? arguments_.title.trim()
      : path.basename(resolved);
  const next = { ...arguments_ };
  delete next.file_path;
  delete next.filePath;
  delete next.content;
  delete next.base64Content;
  delete next.base64_content;
  delete next.textContent;
  delete next.text_content;
  next.title = title;
  next.contentMimeType = mime;
  next.base64Content = bytes.toString("base64");
  return next;
}

const TEXT_TO_GOOGLE_DOC = "application/vnd.google-apps.document";

function metadataMimeType(contentMimeType: string, disableConversion: boolean): string {
  if (disableConversion || contentMimeType !== "text/plain") {
    return contentMimeType;
  }
  return TEXT_TO_GOOGLE_DOC;
}

function createdFileJson(payload: Record<string, unknown>): string {
  const id = typeof payload.id === "string" ? payload.id : "";
  const parents = Array.isArray(payload.parents)
    ? payload.parents.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
  return JSON.stringify({
    id,
    title: typeof payload.name === "string" ? payload.name : "",
    parentId: parents[0] ?? "",
    mimeType: typeof payload.mimeType === "string" ? payload.mimeType : "",
  });
}

function multipartBody(
  metadata: Record<string, unknown>,
  bytes: Buffer,
  contentType: string,
): { body: Buffer; contentType: string } {
  const boundary = `guilds_${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    body: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

export async function createDriveFile(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions & { workspaceDir?: string } = {},
): Promise<string> {
  const prepared = await attachDriveCreateFile(arguments_, options.workspaceDir);
  const title = typeof prepared.title === "string" ? prepared.title.trim() : "";
  const parentId = argString(prepared, "parentId", "parent_id");
  if (!title) {
    throw new DriveFolderError("create_file requires title");
  }
  if (!parentId) {
    throw new DriveFolderError("create_file requires a parent folder");
  }
  const contentMimeType =
    argString(prepared, "contentMimeType", "content_mime_type")
    || argString(prepared, "mimeType", "mime_type")
    || "application/octet-stream";
  const metadata: Record<string, unknown> = { name: title, parents: [parentId] };
  if (contentMimeType === DRIVE_FOLDER_MIME) {
    metadata.mimeType = DRIVE_FOLDER_MIME;
    const payload = await driveJson(
      accessToken,
      "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,parents",
      options,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) },
    );
    return createdFileJson(payload);
  }
  let bytes: Buffer | null = null;
  const base64 = argString(prepared, "base64Content", "base64_content");
  if (base64) {
    bytes = Buffer.from(base64, "base64");
  } else if (typeof prepared.textContent === "string") {
    bytes = Buffer.from(prepared.textContent, "utf8");
  } else if (typeof prepared.text_content === "string") {
    bytes = Buffer.from(prepared.text_content, "utf8");
  }
  if (!bytes) {
    throw new DriveFolderError("create_file requires file_path or textContent");
  }
  const disableConversion =
    prepared.disableConversionToGoogleType === true || prepared.disable_conversion_to_google_type === true;
  metadata.mimeType = metadataMimeType(contentMimeType, disableConversion);
  const part = multipartBody(metadata, bytes, contentMimeType);
  const payload = await driveJson(
    accessToken,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,parents",
    options,
    { method: "POST", headers: { "Content-Type": part.contentType }, body: part.body },
  );
  return createdFileJson(payload);
}
