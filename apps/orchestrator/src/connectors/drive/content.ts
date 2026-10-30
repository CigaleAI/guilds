import path from "node:path";
import { AgentFileError, agentDisplayPath, writeAgentFile } from "../../lib/agent-file.js";
import { MAX_DRIVE_UPLOAD_BYTES } from "./upload.js";
import {
  DRIVE_FOLDER_MIME,
  DriveFolderError,
  driveArg,
  driveBytes,
  driveJson,
  type DriveClientOptions,
  type DriveLogin,
} from "./folder.js";
import type { ToolInputSchema } from "../../db/schema/index.js";
import { DriveFile, PermissionList } from "./responses.js";

export const DRIVE_DOWNLOAD_FILE_DESCRIPTION =
  "Download a file from the connected Drive folder into the agent workspace. Pass an optional file_path in your home. The result is that path, not file bytes.";

export const DRIVE_DOWNLOAD_FILE_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    fileId: { type: "string", description: "Drive file id." },
    file_path: {
      type: "string",
      description: "Destination path in your home. Defaults to the file's title in the workspace root.",
    },
    exportMimeType: {
      type: "string",
      description: "For Google Docs, Sheets, or Slides, the MIME type to export to.",
    },
  },
  required: ["fileId"],
};

const GOOGLE_APP = "application/vnd.google-apps.";
const FILE_FIELDS = "id,name,mimeType,parents,size,description,fileExtension,webViewLink,createdTime,modifiedTime,viewedByMeTime,sharedWithMeTime,owners(emailAddress),capabilities(canAddChildren)";

function fileUrl(fileId: string, query: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${query}`;
}

function requireFileId(arguments_: Record<string, unknown>, tool: string): string {
  const fileId = driveArg(arguments_, "fileId", "file_id");
  if (!fileId) {
    throw new DriveFolderError(`${tool} requires fileId`);
  }
  return fileId;
}

/** The fields of a file's metadata the result carries under its own name, each when Drive has a value. */
const META_FIELDS = [
  ["size", "fileSize"],
  ["description", "description"],
  ["fileExtension", "fileExtension"],
  ["webViewLink", "viewUrl"],
  ["createdTime", "createdTime"],
  ["modifiedTime", "modifiedTime"],
  ["viewedByMeTime", "viewedByMeTime"],
  ["sharedWithMeTime", "sharedWithMeTime"],
] as const;

/** The fields every file carries: its id, title, first parent and type, empty when Drive has none. */
function mcpFileHead(payload: DriveFile): Record<string, string | boolean> {
  return {
    id: payload.id ?? "",
    title: payload.name ?? "",
    parentId: (payload.parents ?? []).find(Boolean) ?? "",
    mimeType: payload.mimeType ?? "",
  };
}

/** A file's metadata as the Drive MCP tools return it. */
function mcpFileFromMeta(payload: DriveFile): Record<string, string | boolean> {
  const file = mcpFileHead(payload);
  for (const [from, to] of META_FIELDS) {
    const value = payload[from];
    if (value) {
      file[to] = value;
    }
  }
  const owner = payload.owners?.[0]?.emailAddress;
  if (owner) {
    file.owner = owner;
  }
  const canAddChildren = payload.capabilities?.canAddChildren;
  if (canAddChildren !== undefined) {
    file.canAddChildren = canAddChildren;
  }
  return file;
}

async function loadFile(accessToken: string, fileId: string, options: DriveClientOptions): Promise<DriveFile> {
  const url = fileUrl(fileId, `fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`);
  return driveJson(accessToken, { url, schema: DriveFile }, options);
}

function defaultExportMime(mimeType: string): string {
  if (mimeType === `${GOOGLE_APP}spreadsheet`) {
    return "text/csv";
  }
  if (mimeType === `${GOOGLE_APP}drawing`) {
    return "image/png";
  }
  return "text/plain";
}

function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_APP) && mimeType !== DRIVE_FOLDER_MIME;
}

/** A file to fetch: its id, its type, and the type to export a Google file to, when one is asked. */
type FileFetch = { id: string; mimeType: string; exportMimeType: string };

async function fetchFileBytes(
  accessToken: string,
  file: FileFetch,
  options: DriveClientOptions,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const { id: fileId, mimeType, exportMimeType } = file;
  if (mimeType === DRIVE_FOLDER_MIME) {
    throw new DriveFolderError("cannot download a folder");
  }
  if (isGoogleNative(mimeType)) {
    const exported = exportMimeType || defaultExportMime(mimeType);
    const { bytes } = await driveBytes(
      accessToken,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exported)}&supportsAllDrives=true`,
      options,
    );
    if (bytes.length > MAX_DRIVE_UPLOAD_BYTES) {
      throw new DriveFolderError("file is larger than 25 MB");
    }
    return { bytes, mimeType: exported };
  }
  const { bytes, contentType } = await driveBytes(
    accessToken,
    fileUrl(fileId, "alt=media&supportsAllDrives=true"),
    options,
  );
  if (bytes.length > MAX_DRIVE_UPLOAD_BYTES) {
    throw new DriveFolderError("file is larger than 25 MB");
  }
  return { bytes, mimeType: contentType.split(";")[0]?.trim() || mimeType };
}

const EXT_BY_MIME: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

function downloadFileName(title: string, fileId: string, mimeType: string): string {
  let name = title.trim().replace(/[/\\]/g, "-").replace(/^\.+/, "") || fileId;
  if (!path.extname(name)) {
    const ext = EXT_BY_MIME[mimeType];
    if (ext) {
      name = `${name}${ext}`;
    }
  }
  return name.slice(0, 200);
}

function textReadable(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType === "application/xml"
    || mimeType.endsWith("+json")
    || mimeType.endsWith("+xml")
  );
}

export async function getDriveFileMetadata(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions,
): Promise<string> {
  const payload = await loadFile(accessToken, requireFileId(arguments_, "get_file_metadata"), options);
  return JSON.stringify(mcpFileFromMeta(payload));
}

const PERMISSION_FIELDS = ["role", "displayName", "type", "emailAddress"] as const;

type Permission = NonNullable<PermissionList["permissions"]>[number];

/** A permission with the fields Drive gave it. */
function permissionView(row: Permission): Record<string, string> {
  const permission: Record<string, string> = {};
  for (const field of PERMISSION_FIELDS) {
    const value = row[field];
    if (value !== undefined) {
      permission[field] = value;
    }
  }
  return permission;
}

export async function getDriveFilePermissions(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions,
): Promise<string> {
  const fileId = requireFileId(arguments_, "get_file_permissions");
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&fields=permissions(role,displayName,type,emailAddress)`;
  const payload = await driveJson(accessToken, { url, schema: PermissionList }, options);
  const permissions = (payload.permissions ?? []).map(permissionView);
  return JSON.stringify({ permissions });
}

export async function downloadDriveFileContent(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions,
  workspaceDir?: string,
): Promise<string> {
  if (!workspaceDir) {
    throw new DriveFolderError("download_file_content is only available during an agent run");
  }
  const fileId = requireFileId(arguments_, "download_file_content");
  const meta = await loadFile(accessToken, fileId, options);
  const title = meta.name ?? "";
  const exportMimeType = driveArg(arguments_, "exportMimeType", "export_mime_type");
  const downloaded = await fetchFileBytes(accessToken, { id: fileId, mimeType: meta.mimeType ?? "", exportMimeType }, options);
  const requested = driveArg(arguments_, "file_path", "filePath");
  let resolved: string;
  try {
    resolved = await writeAgentFile(
      workspaceDir,
      requested || downloadFileName(title, fileId, downloaded.mimeType),
      downloaded.bytes,
    );
  } catch (error) {
    if (error instanceof AgentFileError) {
      throw new DriveFolderError(error.message, { cause: error });
    }
    throw error;
  }
  return JSON.stringify({
    id: fileId,
    title,
    mimeType: downloaded.mimeType,
    file_path: agentDisplayPath(workspaceDir, resolved),
    bytes: downloaded.bytes.length,
  });
}

export async function readDriveFileContent(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions,
): Promise<string> {
  const fileId = requireFileId(arguments_, "read_file_content");
  const meta = await loadFile(accessToken, fileId, options);
  const mimeType = meta.mimeType ?? "";
  const includeComments = arguments_.includeComments === true || arguments_.include_comments === true;
  const result: Record<string, unknown> = {};
  if (includeComments) {
    result.commentsNotSupported = true;
  }
  if (mimeType === DRIVE_FOLDER_MIME) {
    result.textFormattingNotSupported = true;
    return JSON.stringify(result);
  }
  try {
    const downloaded = await fetchFileBytes(accessToken, { id: fileId, mimeType, exportMimeType: "" }, options);
    if (!textReadable(downloaded.mimeType) && !isGoogleNative(mimeType)) {
      result.textFormattingNotSupported = true;
      return JSON.stringify(result);
    }
    result.fileContent = downloaded.bytes.toString("utf8");
    return JSON.stringify(result);
  } catch (error) {
    if (error instanceof DriveFolderError && /cannot download a folder/.test(error.message)) {
      result.textFormattingNotSupported = true;
      return JSON.stringify(result);
    }
    throw error;
  }
}

export async function copyDriveFile(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions,
): Promise<string> {
  const fileId = requireFileId(arguments_, "copy_file");
  const title = driveArg(arguments_, "title", "title");
  const parentId = driveArg(arguments_, "parentId", "parent_id");
  const body: Record<string, unknown> = {};
  if (title) {
    body.name = title;
  }
  if (parentId) {
    body.parents = [parentId];
  }
  const payload = await driveJson(
    accessToken,
    {
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?supportsAllDrives=true&fields=id,name,mimeType,parents`,
      schema: DriveFile,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    },
    options,
  );
  return JSON.stringify(mcpFileFromMeta(payload));
}

export async function callDriveFileTool(
  remoteName: string,
  arguments_: Record<string, unknown>,
  login: DriveLogin,
  workspaceDir?: string,
): Promise<string | null> {
  const { accessToken } = login;
  if (remoteName === "get_file_metadata") {
    return getDriveFileMetadata(accessToken, arguments_, login);
  }
  if (remoteName === "get_file_permissions") {
    return getDriveFilePermissions(accessToken, arguments_, login);
  }
  if (remoteName === "download_file_content") {
    return downloadDriveFileContent(accessToken, arguments_, login, workspaceDir);
  }
  if (remoteName === "read_file_content") {
    return readDriveFileContent(accessToken, arguments_, login);
  }
  if (remoteName === "copy_file") {
    return copyDriveFile(accessToken, arguments_, login);
  }
  return null;
}
