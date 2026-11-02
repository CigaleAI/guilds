import path from "node:path";
import { AgentFileError, readAgentFile } from "../../lib/agent-file.js";
import { DRIVE_FOLDER_MIME, DriveFolderError, driveJson, mcpFile, type DriveClientOptions, type DriveRequestInit } from "./folder.js";
import { given, type CreateFileArguments } from "./parameters.js";
import { DriveFile } from "./responses.js";

export const MAX_DRIVE_UPLOAD_BYTES = 25 * 1024 * 1024;

export const DRIVE_CREATE_FILE_DESCRIPTION =
  "Create a file or folder in the connected Drive folder. Pass file_path in your home (absolute, or relative to it) for file bytes; the orchestrator reads and encodes them. Do not pass base64. Small UTF-8 text may use textContent. To create a folder, set title and contentMimeType application/vnd.google-apps.folder.";

/** The metadata a create or a copy writes on a Drive file. */
export type DriveFileWrite = { name?: string; parents?: string[]; mimeType?: string };

/** The type of a workspace file's content by its extension, when the create names none. */
const MIME_BY_EXT = new Map([
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

/**
 * What a create uploads: the file's name, the folder it goes in, the type of its content, the
 * content when the create gives any, and whether Drive keeps that type instead of converting it.
 */
export type DriveUpload = {
  title: string;
  parentId: string;
  contentMimeType: string;
  bytes: Buffer | null;
  keepType: boolean;
};

/** The workspace file a create names, read: its bytes, and the path they were read from. */
async function workspaceFile(filePath: string, workspaceDir?: string) {
  if (!workspaceDir) {
    throw new DriveFolderError("file_path is only available during an agent run");
  }
  try {
    return await readAgentFile(workspaceDir, filePath, { maxBytes: MAX_DRIVE_UPLOAD_BYTES });
  } catch (error) {
    if (error instanceof AgentFileError) {
      throw new DriveFolderError(
        error.problem === "too_large" ? "file_path is larger than 25 MB" : error.message,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The upload a create's arguments describe. A create that names a workspace file uploads its
 * bytes, named and typed after the file unless the create says otherwise; another uploads its text.
 */
export async function attachDriveCreateFile(
  arguments_: CreateFileArguments,
  workspaceDir?: string,
): Promise<DriveUpload> {
  const upload = {
    parentId: given(arguments_.parentId),
    keepType: arguments_.disableConversionToGoogleType === true,
  };
  const filePath = given(arguments_.file_path);
  if (!filePath) {
    return {
      ...upload,
      title: given(arguments_.title),
      contentMimeType: given(arguments_.contentMimeType) || "application/octet-stream",
      bytes: arguments_.textContent === undefined ? null : Buffer.from(arguments_.textContent, "utf8"),
    };
  }
  const file = await workspaceFile(filePath, workspaceDir);
  return {
    ...upload,
    title: given(arguments_.title) || path.basename(file.path),
    contentMimeType:
      given(arguments_.contentMimeType) || MIME_BY_EXT.get(path.extname(file.path).toLowerCase()) || "application/octet-stream",
    bytes: file.bytes,
  };
}

const TEXT_TO_GOOGLE_DOC = "application/vnd.google-apps.document";

/** The Drive type a plain-text upload is converted to; any other content keeps its own type. */
function googleConvertedMimeType(contentMimeType: string): string {
  if (contentMimeType !== "text/plain") {
    return contentMimeType;
  }
  return TEXT_TO_GOOGLE_DOC;
}

function createdFileJson(payload: DriveFile): string {
  return JSON.stringify(mcpFile(payload));
}

/** The type Drive stores an upload as: its own when it keeps the type, else the converted one. */
function storedMimeType(upload: DriveUpload): string {
  return upload.keepType ? upload.contentMimeType : googleConvertedMimeType(upload.contentMimeType);
}

/** A POST of a file's metadata as JSON. */
export function jsonPost(body: DriveFileWrite): DriveRequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** A POST of a file's metadata and its bytes in one multipart body. */
function multipartPost(metadata: DriveFileWrite, bytes: Buffer, contentType: string): DriveRequestInit {
  const boundary = `guilds_${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([head, bytes, tail]),
  };
}

export async function createDriveFile(
  accessToken: string,
  arguments_: CreateFileArguments,
  options: DriveClientOptions = {},
  workspaceDir?: string,
): Promise<string> {
  const upload = await attachDriveCreateFile(arguments_, workspaceDir);
  if (!upload.title) {
    throw new DriveFolderError("create_file requires title");
  }
  if (!upload.parentId) {
    throw new DriveFolderError("create_file requires a parent folder");
  }
  const metadata: DriveFileWrite = { name: upload.title, parents: [upload.parentId] };
  if (upload.contentMimeType === DRIVE_FOLDER_MIME) {
    metadata.mimeType = DRIVE_FOLDER_MIME;
    const url = "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,parents";
    return createdFileJson(await driveJson(accessToken, { url, schema: DriveFile, init: jsonPost(metadata) }, options));
  }
  if (!upload.bytes) {
    throw new DriveFolderError("create_file requires file_path or textContent");
  }
  metadata.mimeType = storedMimeType(upload);
  const payload = await driveJson(
    accessToken,
    {
      url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,parents",
      schema: DriveFile,
      init: multipartPost(metadata, upload.bytes, upload.contentMimeType),
    },
    options,
  );
  return createdFileJson(payload);
}
