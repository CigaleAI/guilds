import type { Static, TObject } from "typebox";
import {
  copyDriveFile,
  DRIVE_DOWNLOAD_FILE_DESCRIPTION,
  downloadDriveFileContent,
  getDriveFileMetadata,
  getDriveFilePermissions,
  readDriveFileContent,
} from "./content.js";
import {
  assertPickedDriveFolder,
  assertReachesFolder,
  constrainCreate,
  constrainSearch,
  DriveFolderError,
  listRecentDriveFiles,
  loadDriveFolder,
  pastedDriveFolderRef,
  searchDriveFolder,
  searchDriveFolders,
  type ScopedDrive,
} from "./folder.js";
import {
  CopyFileParameters,
  CreateFileParameters,
  DownloadFileParameters,
  FileParameters,
  FileReference,
  ListRecentFilesParameters,
  ReadFileParameters,
  SearchFilesParameters,
} from "./parameters.js";
import { DRIVE_CREATE_FILE_DESCRIPTION, createDriveFile } from "./upload.js";
import type { JsonObject } from "../../lib/json.js";
import { decodeArguments, offeredParameters } from "../../lib/tool-schema.js";
import { adapterTool, toolsAdapter } from "../tools.js";
import {
  ConnectorError,
  requiredCredential,
  type AdapterTool,
  type ConnectorContext,
  type ConnectorTool,
  type Credentials,
} from "../types.js";

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

/** The connected folder a call is limited to, with the login that makes it; a 422 when the login has no folder. */
function scopedDrive(creds: Credentials, ctx: ConnectorContext): ScopedDrive {
  const folderId = ctx.settings.folder_id?.trim() ?? "";
  const accessToken = creds.access_token ?? "";
  if (!folderId || !accessToken) {
    throw new ConnectorError("Drive connection is missing a folder", 422);
  }
  return { accessToken, folderId, client: ctx.http };
}

/** A tool Drive runs itself, as it is written: its work runs on the connected folder, with the call's context. */
type DriveToolDefinition<P extends TObject> = {
  name: string;
  parameters: P;
  run: (input: Static<P>, scoped: ScopedDrive, ctx: ConnectorContext) => Promise<string>;
};

/** The tool `definition` describes, limited to the connected folder, its folder errors answered as 422s. */
function driveTool<P extends TObject>(definition: DriveToolDefinition<P>): AdapterTool {
  const { name, parameters, run } = definition;
  return adapterTool({
    name,
    parameters,
    run: (input, creds, ctx) => folderWork(() => run(input, scopedDrive(creds, ctx), ctx)),
  });
}

const searchFiles = driveTool({
  name: "search_files",
  parameters: SearchFilesParameters,
  run: async (input, scoped) => {
    await constrainSearch(scoped, input.query ?? "");
    return searchDriveFolder(scoped.accessToken, scoped.folderId, input, scoped);
  },
});

const listRecentFiles = driveTool({
  name: "list_recent_files",
  parameters: ListRecentFilesParameters,
  run: (input, scoped) => listRecentDriveFiles(scoped.accessToken, scoped.folderId, input, scoped),
});

const createFile = driveTool({
  name: "create_file",
  parameters: CreateFileParameters,
  run: async (input, scoped, ctx) =>
    createDriveFile(scoped.accessToken, await constrainCreate(scoped, input), scoped, ctx.workspace_dir),
});

const getFileMetadata = driveTool({
  name: "get_file_metadata",
  parameters: FileParameters,
  run: async (input, scoped) => {
    await assertReachesFolder(scoped, input);
    return getDriveFileMetadata(scoped.accessToken, input, scoped);
  },
});

const getFilePermissions = driveTool({
  name: "get_file_permissions",
  parameters: FileParameters,
  run: async (input, scoped) => {
    await assertReachesFolder(scoped, input);
    return getDriveFilePermissions(scoped.accessToken, input, scoped);
  },
});

const readFileContent = driveTool({
  name: "read_file_content",
  parameters: ReadFileParameters,
  run: async (input, scoped) => {
    await assertReachesFolder(scoped, input);
    return readDriveFileContent(scoped.accessToken, input, scoped);
  },
});

const downloadFileContent = driveTool({
  name: "download_file_content",
  parameters: DownloadFileParameters,
  run: async (input, scoped, ctx) => {
    await assertReachesFolder(scoped, input);
    return downloadDriveFileContent(scoped.accessToken, input, scoped, ctx.workspace_dir);
  },
});

const copyFile = driveTool({
  name: "copy_file",
  parameters: CopyFileParameters,
  run: async (input, scoped) => {
    await assertReachesFolder(scoped, input);
    return copyDriveFile(scoped.accessToken, input, scoped);
  },
});

/**
 * The listed tools Drive offers with its own description and the parameters it decodes, in place
 * of the endpoint's: they take a workspace path, not bytes.
 */
const OFFERED = new Map([
  [createFile.name, { description: DRIVE_CREATE_FILE_DESCRIPTION, input_schema: offeredParameters(createFile.parameters) }],
  [
    downloadFileContent.name,
    { description: DRIVE_DOWNLOAD_FILE_DESCRIPTION, input_schema: offeredParameters(downloadFileContent.parameters) },
  ],
]);

export function rewriteDescriptions(tools: ConnectorTool[]): ConnectorTool[] {
  return tools.map((tool) => {
    const offered = OFFERED.get(tool.name);
    return offered ? { ...tool, ...offered } : tool;
  });
}

/** A call to a tool the endpoint runs, forwarded once the file and the folder it names are inside the connected folder. */
async function forwarded(name: string, args: JsonObject, creds: Credentials, ctx: ConnectorContext): Promise<string> {
  const scoped = scopedDrive(creds, ctx);
  await folderWork(() =>
    assertReachesFolder(scoped, decodeArguments(FileReference, args, (problem) => new DriveFolderError(problem))),
  );
  return ctx.remote.call(name, args);
}

export default toolsAdapter(
  [
    searchFiles,
    listRecentFiles,
    createFile,
    getFileMetadata,
    getFilePermissions,
    readFileContent,
    downloadFileContent,
    copyFile,
  ],
  {
    /** Checks the picked folder: a folder inside the Drive, not My Drive. Its name is the account hint. */
    async validate(creds, ctx) {
      const accessToken = requiredCredential(creds, "access_token", "Drive access token is missing");
      const folderId = ctx.settings.folder_id?.trim() ?? "";
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
      const ref = pastedDriveFolderRef(query);
      const folders = await folderWork(async () =>
        ref ? [await loadDriveFolder(accessToken, ref, { client: ctx.http })] : searchDriveFolders(accessToken, query, { client: ctx.http }),
      );
      return folders.map((folder) => ({ value: folder.id, label: folder.name }));
    },
    list: async (_creds, ctx) => rewriteDescriptions(await ctx.remote.list()),
    call: forwarded,
  },
);
