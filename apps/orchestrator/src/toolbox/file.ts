import path from "node:path";
import { Type } from "@sinclair/typebox";
import { ArtifactError } from "../artifacts/errors.js";
import { FILE_MAX_BYTES, isArtifactLevel, type ArtifactActor, type ArtifactLevel } from "../artifacts/types.js";
import { ArtifactFiles, mimeForName } from "../artifacts/files.js";
import { AgentFileError, agentDisplayPath, readAgentFile, writeAgentFile } from "../lib/agent-file.js";
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

async function publish(services: ToolServices, run: ToolRun, displayPath: string): Promise<void> {
  if (services.group_chat !== null && run.guild_id && services.group_chat.publish) {
    await services.group_chat.publish(run.guild_id, "guild.artifacts.changed", {
      path: displayPath,
      agent_id: run.agent_id,
    });
  }
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

/** The level a call names, which must be one. */
function requiredLevel(level: string): ArtifactLevel {
  const named = level.trim();
  if (!isArtifactLevel(named)) {
    throw new ArtifactError("level must be agent, guild, or org", 422);
  }
  return named;
}

/** The level a call names; none when it names none, or one that is not a level. */
function optionalLevel(level: string | undefined): ArtifactLevel | undefined {
  const named = level?.trim() ?? "";
  return isArtifactLevel(named) ? named : undefined;
}

export const fileFind = nativeTool({
  name: "file_find",
  description:
    "Search or list the shared files you may read, by name and description. An empty query lists them, " +
    "optionally at one level. Results are { files }, each with its display path, name, description, mime, " +
    "bytes, and access (read or write). Files hold bytes, not Markdown: use note_find for notes.",
  summary: "Search or list the shared files you may read.",
  parameters: Type.Object({
    query: Type.Optional(Type.String()),
    level: Type.Optional(Type.String({ description: "agent, guild, or org; omit for every level you can read" })),
    limit: Type.Optional(Type.Integer({ description: "at most 100, default 20" })),
  }),
  async handler(services, run, _hooks, call) {
    const { query = "", limit = 20 } = call.arguments;
    const level = optionalLevel(call.arguments.level);
    const found = await files(services).findFiles(actor(run, call), {
      query,
      ...(level ? { level } : {}),
      limit,
    });
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
    "Share a file from your home: copy it into the store at a level (agent, guild, or org) under a name. " +
    "A new file is created at agent or guild level; an existing file of that name is replaced when you have " +
    "write access to it. name defaults to the file's own name. description says what the file is, so others " +
    `find it with file_find. A file is at most ${FILE_MAX_BYTES / (1024 * 1024)} MiB. Returns the display path.`,
  summary: "Share a file from your home at a level.",
  parameters: Type.Object({
    home_path: Type.String({ description: "the file in your home, relative to it or absolute under it" }),
    level: Type.String({ description: "agent, guild, or org" }),
    description: Type.String({ description: "what the file is, in one or two sentences" }),
    name: Type.Optional(Type.String({ description: "the file's name in the store; default its name in your home" })),
    mime: Type.Optional(Type.String({ description: "the file's media type; default from its name" })),
  }),
  async handler(services, run, _hooks, call) {
    const { home_path: homePath, level, description } = call.arguments;
    const read = await homeFile(readAgentFile(workspace(run), homePath, { maxBytes: FILE_MAX_BYTES }));
    const name = call.arguments.name?.trim() || path.basename(read.path);
    const store = files(services);
    const row = await store.putFile(actor(run, call), {
      level: requiredLevel(level),
      name,
      description,
      mime: call.arguments.mime?.trim() || mimeForName(name),
      bytes: read.bytes,
    });
    const display = store.view(row).display_path;
    await publish(services, run, display);
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
    await store.deleteFile(actor(run, call), row);
    await publish(services, run, displayPath);
    return displayPath;
  },
});
