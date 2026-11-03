import path from "node:path";
import { Type } from "typebox";
import { ArtifactError } from "../artifacts/errors.js";
import { FILE_MAX_BYTES, type ArtifactActor } from "../artifacts/types.js";
import { ArtifactFiles, mimeForName } from "../artifacts/files.js";
import { AgentFileError, agentDisplayPath, readAgentFile, writeAgentFile } from "../lib/agent-file.js";
import { announceItemChange, itemGuilds } from "./artifacts.js";
import type { ToolServices } from "./services.js";
import { callActor, nativeTool, type ToolInvocation, type ToolRun } from "./types.js";

export const FILE_TOOLS = ["file_find", "file_fetch", "file_put", "file_delete"] as const;

/** Where `file_fetch` lands a file when the agent names no destination: `shared/<name>` in its home. */
export const FETCH_FOLDER = "shared";

function files(services: ToolServices): ArtifactFiles {
  if (!services.files) {
    throw new ArtifactError("file store is not available", 500);
  }
  return services.files;
}

function actor(run: ToolRun, call: ToolInvocation): ArtifactActor {
  const made = callActor(run.artifact_actor, call);
  if (!made) {
    throw new ArtifactError("file store is not available", 500);
  }
  return made;
}

function workspace(run: ToolRun): string {
  if (!run.workspace_dir) {
    throw new ArtifactError("the agent's home is not available", 500);
  }
  return run.workspace_dir;
}

/** What `work` on a file of the agent's home gives; a refusal of its path is a 422 saying what was wrong with it. */
async function homeFile<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof AgentFileError) {
      throw new ArtifactError(error.message, 422);
    }
    throw error;
  }
}

export const fileFind = nativeTool({
  name: "file_find",
  description:
    "Search or list the shared files you may read, by name and description. An empty query lists them. " +
    "Results are { files }, each with its display path, name, description, mime, bytes, and access " +
    "(read or write). Files hold bytes, not Markdown: use note_find for notes.",
  summary: "Search or list the shared files you may read.",
  parameters: Type.Object({
    query: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ description: "at most 100, default 20" })),
  }),
  async handler(services, run, _hooks, call) {
    const { query = "", limit = 20 } = call.arguments;
    const found = await files(services).findFiles(actor(run, call), { query, limit });
    return JSON.stringify({ files: found });
  },
});

export const fileFetch = nativeTool({
  name: "file_fetch",
  description:
    "Copy a shared file into your home by its display path. home_path is where it lands, relative to your " +
    `home or absolute under it; omitted, the file lands at ${FETCH_FOLDER}/<name>. The result is that path with ` +
    "the file's name, description, mime, and bytes, not the file's contents.",
  summary: "Copy a shared file into your home.",
  parameters: Type.Object({
    path: Type.String({ description: "the file's display path, from file_find" }),
    home_path: Type.Optional(Type.String({ description: `destination in your home; default ${FETCH_FOLDER}/<name>` })),
  }),
  async handler(services, run, _hooks, call) {
    const store = files(services);
    const row = await store.loadFile(actor(run, call), call.arguments.path);
    const bytes = await store.readBytes(row);
    const destination = call.arguments.home_path?.trim() || `${FETCH_FOLDER}/${row.key}`;
    const workspaceDir = workspace(run);
    const resolved = await homeFile(writeAgentFile(workspaceDir, destination, bytes));
    return JSON.stringify({ home_path: agentDisplayPath(workspaceDir, resolved), ...store.view(row) });
  },
});

export const filePut = nativeTool({
  name: "file_put",
  description:
    "Share a file from your home: copy it into the store under a name. An existing file of that name is " +
    "replaced when your access to it is write and refused otherwise; a missing one is created, written by " +
    "you alone until an operator shares it. One name is one file across the organisation. name defaults to " +
    "the file's own name. description says what the file is, so others find it with file_find. A file is at " +
    `most ${FILE_MAX_BYTES / (1024 * 1024)} MiB. Returns the display path.`,
  summary: "Share a file from your home.",
  parameters: Type.Object({
    home_path: Type.String({ description: "the file in your home, relative to it or absolute under it" }),
    description: Type.String({ description: "what the file is, in one or two sentences" }),
    name: Type.Optional(Type.String({ description: "the file's name in the store; default its name in your home" })),
    mime: Type.Optional(Type.String({ description: "the file's media type; default from its name" })),
  }),
  async handler(services, run, _hooks, call) {
    const { home_path: homePath, description } = call.arguments;
    const read = await homeFile(readAgentFile(workspace(run), homePath, { maxBytes: FILE_MAX_BYTES }));
    const name = call.arguments.name?.trim() || path.basename(read.path);
    const store = files(services);
    const row = await store.putFile(actor(run, call), {
      name,
      description,
      mime: call.arguments.mime?.trim() || mimeForName(name),
      bytes: read.bytes,
    });
    const display = store.view(row).display_path;
    await announceItemChange(services, run, await itemGuilds(services, row.org_id, { kind: "file", id: row.id }), display);
    return display;
  },
});

export const fileDelete = nativeTool({
  name: "file_delete",
  description: "Delete a shared file by display path. You need write access to it.",
  summary: "Delete a shared file by display path.",
  parameters: Type.Object({ path: Type.String() }),
  async handler(services, run, _hooks, call) {
    const store = files(services);
    const displayPath = call.arguments.path;
    const row = await store.loadFile(actor(run, call), displayPath);
    const guilds = await itemGuilds(services, row.org_id, { kind: "file", id: row.id });
    await store.deleteFile(actor(run, call), row);
    await announceItemChange(services, run, guilds, displayPath);
    return displayPath;
  },
});
