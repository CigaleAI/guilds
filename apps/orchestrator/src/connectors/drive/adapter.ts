import { DRIVE_DOWNLOAD_FILE_DESCRIPTION, DRIVE_DOWNLOAD_FILE_SCHEMA, callDriveFileTool } from "./content.js";
import {
  assertPickedDriveFolder,
  constrainDriveTool,
  DriveFolderError,
  listRecentDriveFiles,
  loadDriveFolder,
  parseDriveFolderRef,
  searchDriveFolder,
  searchDriveFolders,
} from "./folder.js";
import { DRIVE_CREATE_FILE_DESCRIPTION, DRIVE_CREATE_FILE_SCHEMA, createDriveFile } from "./upload.js";
import type { ToolInputSchema } from "../../db/schema/index.js";
import { ConnectorError, requiredCredential, type Adapter, type ConnectorContext, type ConnectorTool } from "../types.js";

/** Listed tools whose description and schema Drive replaces: they take a workspace path, not bytes. */
const REWRITTEN: Record<string, { description: string; input_schema: ToolInputSchema }> = {
  create_file: { description: DRIVE_CREATE_FILE_DESCRIPTION, input_schema: DRIVE_CREATE_FILE_SCHEMA },
  download_file_content: { description: DRIVE_DOWNLOAD_FILE_DESCRIPTION, input_schema: DRIVE_DOWNLOAD_FILE_SCHEMA },
};

export function rewriteDescriptions(tools: ConnectorTool[]): ConnectorTool[] {
  return tools.map((tool) => {
    const rewrite = REWRITTEN[tool.name];
    return rewrite ? { ...tool, ...rewrite } : tool;
  });
}

/** Runs one of the tools Drive implements itself, or null when `name` is not one of them. */
async function fileTool(
  name: string,
  args: Record<string, unknown>,
  scoped: { accessToken: string; folderId: string; client: ConnectorContext["http"] },
  ctx: ConnectorContext,
): Promise<string | null> {
  const { accessToken, folderId } = scoped;
  const withWorkspace = { ...scoped, ...(ctx.workspace_dir ? { workspaceDir: ctx.workspace_dir } : {}) };
  if (name === "create_file") {
    return createDriveFile(accessToken, args, withWorkspace);
  }
  if (name === "search_files") {
    return searchDriveFolder(accessToken, folderId, args, scoped);
  }
  if (name === "list_recent_files") {
    return listRecentDriveFiles(accessToken, folderId, args, scoped);
  }
  return callDriveFileTool(name, args, withWorkspace);
}

/** Runs Drive folder code and answers its folder errors as 422s. */
async function folderWork<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DriveFolderError) {
      throw new ConnectorError(error.message, 422);
    }
    throw error;
  }
}

/** A pasted folder link or id, or null when the query is a name to search for. */
function folderRef(query: string): string | null {
  try {
    const id = parseDriveFolderRef(query);
    return /^[a-zA-Z0-9_-]{20,}$/.test(id) || query.includes("drive.google.com") ? id : null;
  } catch {
    return null;
  }
}

const adapter: Adapter = {
  /** Checks the picked folder: a folder inside the Drive, not My Drive. Its name is the account hint. */
  async validate(creds, ctx) {
    const accessToken = requiredCredential(creds, "access_token", "Drive access token is missing");
    const folderId = typeof ctx.settings.folder_id === "string" ? ctx.settings.folder_id.trim() : "";
    if (!folderId) {
      return "";
    }
    const folder = await folderWork(() => assertPickedDriveFolder(accessToken, folderId, { client: ctx.http }));
    return folder.name;
  },
  /** Folders for `folder_id`: the one a pasted link names, else those whose name contains the query. */
  async lookup(property, query, creds, ctx) {
    if (property !== "folder_id") {
      throw new ConnectorError(`Drive has no lookup for ${property}`, 404);
    }
    const accessToken = requiredCredential(creds, "access_token", "Drive access token is missing");
    const ref = folderRef(query);
    const folders = await folderWork(async () =>
      ref ? [await loadDriveFolder(accessToken, ref, { client: ctx.http })] : searchDriveFolders(accessToken, query, { client: ctx.http }),
    );
    return folders.map((folder) => ({ value: folder.id, label: folder.name }));
  },
  list: async (_creds, ctx) => rewriteDescriptions(await ctx.remote.list()),
  async call(name, args, creds, ctx) {
    const folderId = typeof ctx.settings.folder_id === "string" ? ctx.settings.folder_id.trim() : "";
    const accessToken = creds.access_token ?? "";
    if (!folderId || !accessToken) {
      throw new ConnectorError("Drive connection is missing a folder", 422);
    }
    const scoped = { accessToken, folderId, client: ctx.http };
    let constrained: Record<string, unknown>;
    let handled: string | null;
    try {
      constrained = await constrainDriveTool(name, args, scoped);
      handled = await fileTool(name, constrained, scoped, ctx);
    } catch (error) {
      if (error instanceof DriveFolderError) {
        throw new ConnectorError(error.message, 422);
      }
      throw error;
    }
    return handled ?? ctx.remote.call(name, constrained);
  },
};

export default adapter;
