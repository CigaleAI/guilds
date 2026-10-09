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
} from "./folder.js";

export const DRIVE_DOWNLOAD_FILE_DESCRIPTION =
  "Download a file from the connected Drive folder into the agent workspace. Pass an optional file_path under /home/agent. The result is that path, not file bytes.";

export const DRIVE_DOWNLOAD_FILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    fileId: { type: "string", description: "Drive file id." },
    file_path: {
      type: "string",
      description: "Destination path under /home/agent. Defaults to the file's title in the workspace root.",
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

function parentIdOf(payload: Record<string, unknown>): string {
  const parents = Array.isArray(payload.parents)
    ? payload.parents.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
  return parents[0] ?? "";
}

function mcpFileFromMeta(payload: Record<string, unknown>): Record<string, unknown> {
  const owners = Array.isArray(payload.owners) ? payload.owners : [];
  const owner0 = owners[0] && typeof owners[0] === "object" ? (owners[0] as { emailAddress?: unknown }).emailAddress : "";
  const caps =
    payload.capabilities && typeof payload.capabilities === "object" && !Array.isArray(payload.capabilities)
      ? (payload.capabilities as { canAddChildren?: unknown })
      : {};
  const file: Record<string, unknown> = {
    id: typeof payload.id === "string" ? payload.id : "",
    title: typeof payload.name === "string" ? payload.name : "",
    parentId: parentIdOf(payload),
    mimeType: typeof payload.mimeType === "string" ? payload.mimeType : "",
  };
  if (typeof payload.size === "string" && payload.size) {
    file.fileSize = payload.size;
  }
  if (typeof payload.description === "string" && payload.description) {
    file.description = payload.description;
  }
  if (typeof payload.fileExtension === "string" && payload.fileExtension) {
    file.fileExtension = payload.fileExtension;
  }
  if (typeof payload.webViewLink === "string" && payload.webViewLink) {
    file.viewUrl = payload.webViewLink;
  }
  if (typeof payload.createdTime === "string" && payload.createdTime) {
    file.createdTime = payload.createdTime;
  }
  if (typeof payload.modifiedTime === "string" && payload.modifiedTime) {
    file.modifiedTime = payload.modifiedTime;
  }
  if (typeof payload.viewedByMeTime === "string" && payload.viewedByMeTime) {
    file.viewedByMeTime = payload.viewedByMeTime;
  }
  if (typeof payload.sharedWithMeTime === "string" && payload.sharedWithMeTime) {
    file.sharedWithMeTime = payload.sharedWithMeTime;
  }
  if (typeof owner0 === "string" && owner0) {
    file.owner = owner0;
  }
  if (typeof caps.canAddChildren === "boolean") {
    file.canAddChildren = caps.canAddChildren;
  }
  return file;
}

async function loadFile(
  accessToken: string,
  fileId: string,
  options: DriveClientOptions,
): Promise<Record<string, unknown>> {
  return driveJson(
    accessToken,
    fileUrl(fileId, `fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`),
    options,
  );
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

async function fetchFileBytes(
  accessToken: string,
  fileId: string,
  mimeType: string,
  exportMimeType: string,
  options: DriveClientOptions,
): Promise<{ bytes: Buffer; mimeType: string }> {
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

export async function getDriveFilePermissions(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions,
): Promise<string> {
  const fileId = requireFileId(arguments_, "get_file_permissions");
  const payload = await driveJson(
    accessToken,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&fields=permissions(role,displayName,type,emailAddress)`,
    options,
  );
  const rows = Array.isArray(payload.permissions) ? payload.permissions : [];
  const permissions: Array<Record<string, unknown>> = [];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const permission: Record<string, unknown> = {};
    if (typeof row.role === "string") {
      permission.role = row.role;
    }
    if (typeof row.displayName === "string") {
      permission.displayName = row.displayName;
    }
    if (typeof row.type === "string") {
      permission.type = row.type;
    }
    if (typeof row.emailAddress === "string") {
      permission.emailAddress = row.emailAddress;
    }
    permissions.push(permission);
  }
  return JSON.stringify({ permissions });
}

export async function downloadDriveFileContent(
  accessToken: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions & { workspaceDir?: string },
): Promise<string> {
  if (!options.workspaceDir) {
    throw new DriveFolderError("download_file_content is only available during an agent run");
  }
  const fileId = requireFileId(arguments_, "download_file_content");
  const meta = await loadFile(accessToken, fileId, options);
  const title = typeof meta.name === "string" ? meta.name : "";
  const mimeType = typeof meta.mimeType === "string" ? meta.mimeType : "";
  const exportMimeType = driveArg(arguments_, "exportMimeType", "export_mime_type");
  const downloaded = await fetchFileBytes(accessToken, fileId, mimeType, exportMimeType, options);
  const requested = driveArg(arguments_, "file_path", "filePath");
  let resolved: string;
  try {
    resolved = await writeAgentFile(
      options.workspaceDir,
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
    file_path: agentDisplayPath(options.workspaceDir, resolved),
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
  const mimeType = typeof meta.mimeType === "string" ? meta.mimeType : "";
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
    const downloaded = await fetchFileBytes(accessToken, fileId, mimeType, "", options);
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
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?supportsAllDrives=true&fields=id,name,mimeType,parents`,
    options,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  return JSON.stringify(mcpFileFromMeta(payload));
}

export async function callDriveFileTool(
  remoteName: string,
  arguments_: Record<string, unknown>,
  options: DriveClientOptions & { accessToken: string; workspaceDir?: string },
): Promise<string | null> {
  const { accessToken } = options;
  if (remoteName === "get_file_metadata") {
    return getDriveFileMetadata(accessToken, arguments_, options);
  }
  if (remoteName === "get_file_permissions") {
    return getDriveFilePermissions(accessToken, arguments_, options);
  }
  if (remoteName === "download_file_content") {
    return downloadDriveFileContent(accessToken, arguments_, options);
  }
  if (remoteName === "read_file_content") {
    return readDriveFileContent(accessToken, arguments_, options);
  }
  if (remoteName === "copy_file") {
    return copyDriveFile(accessToken, arguments_, options);
  }
  return null;
}
