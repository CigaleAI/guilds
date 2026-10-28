import path from "node:path";
import { ArtifactError } from "../artifacts/errors.js";
import { FILE_MAX_BYTES, isArtifactLevel, type ArtifactActor, type ArtifactLevel } from "../artifacts/types.js";
import { ArtifactFiles, mimeForName } from "../artifacts/files.js";
import { AgentFileError, agentDisplayPath, readAgentFile, writeAgentFile } from "../lib/agent-file.js";
import { argInteger, argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { Tool, ToolContext } from "./types.js";

export const FILE_TOOLS = ["file_find", "file_fetch", "file_put", "file_delete"] as const;

/** Where `file_fetch` lands a file when the agent names no destination: `shared/<name>` in its home. */
export const FETCH_FOLDER = "shared";

function files(ctx: ToolContext): ArtifactFiles {
  if (!ctx.files) {
    throw new ArtifactError("file store is not available", 500);
  }
  return ctx.files;
}

function actor(ctx: ToolContext): ArtifactActor {
  if (!ctx.artifact_actor) {
    throw new ArtifactError("file store is not available", 500);
  }
  return ctx.artifact_actor;
}

function workspace(ctx: ToolContext): string {
  if (!ctx.workspace_dir) {
    throw new ArtifactError("the agent's home is not available", 500);
  }
  return ctx.workspace_dir;
}

async function publish(ctx: ToolContext, displayPath: string): Promise<void> {
  if (ctx.group_chat !== null && ctx.guild_id && ctx.group_chat.publish) {
    await ctx.group_chat.publish(ctx.guild_id, "guild.artifacts.changed", {
      path: displayPath,
      agent_id: ctx.agent_id,
    });
  }
}

/** A home-file refusal as the tool answers it: what was wrong with the path, as a 422. */
function homeFileError(error: unknown): never {
  if (error instanceof AgentFileError) {
    throw new ArtifactError(error.message, 422);
  }
  throw error;
}

function levelArg(args: Record<string, unknown>): ArtifactLevel {
  const raw = argString(args, "level").trim();
  if (!isArtifactLevel(raw)) {
    throw new ArtifactError("level must be agent, guild, or org", 422);
  }
  return raw;
}

function optionalLevel(args: Record<string, unknown>): ArtifactLevel | undefined {
  const raw = argString(args, "level").trim();
  return isArtifactLevel(raw) ? raw : undefined;
}

export const fileFind: Tool = {
  name: "file_find",
  description:
    "Search or list the shared files you may read, by name and description. An empty query lists them, " +
    "optionally at one level. Results are { files }, each with its display path, name, description, mime, " +
    "bytes, and access (read or write). Files hold bytes, not Markdown: use note_find for notes.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "file_find",
    "Search or list the shared files you may read.",
    {
      query: { type: "string" },
      level: { type: "string", description: "agent, guild, or org; omit for every level you can read" },
      limit: { type: "integer" },
    },
    [],
  ),
  async handler(ctx, args) {
    const level = optionalLevel(args);
    const found = await files(ctx).findFiles(actor(ctx), {
      query: argString(args, "query"),
      ...(level ? { level } : {}),
      limit: argInteger(args, "limit", 20),
    });
    return JSON.stringify({ files: found });
  },
};

export const fileFetch: Tool = {
  name: "file_fetch",
  description:
    "Copy a shared file into your home by its display path. home_path is where it lands, relative to your " +
    `home or absolute under it; omitted, the file lands at ${FETCH_FOLDER}/<name>. The result is that path with ` +
    "the file's name, description, mime, and bytes, not the file's contents.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "file_fetch",
    "Copy a shared file into your home.",
    {
      path: { type: "string", description: "the file's display path, from file_find" },
      home_path: { type: "string", description: `destination in your home; default ${FETCH_FOLDER}/<name>` },
    },
    ["path"],
  ),
  async handler(ctx, args) {
    const store = files(ctx);
    const row = await store.loadFile(actor(ctx), argString(args, "path"));
    const bytes = await store.readBytes(row);
    const destination = argString(args, "home_path").trim() || `${FETCH_FOLDER}/${row.key}`;
    const workspaceDir = workspace(ctx);
    const resolved = await writeAgentFile(workspaceDir, destination, bytes).catch(homeFileError);
    return JSON.stringify({ home_path: agentDisplayPath(workspaceDir, resolved), ...store.view(row) });
  },
};

export const filePut: Tool = {
  name: "file_put",
  description:
    "Share a file from your home: copy it into the store at a level (agent, guild, or org) under a name. " +
    "A new file is created at agent or guild level; an existing file of that name is replaced when you have " +
    "write access to it. name defaults to the file's own name. description says what the file is, so others " +
    `find it with file_find. A file is at most ${FILE_MAX_BYTES / (1024 * 1024)} MiB. Returns the display path.`,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "file_put",
    "Share a file from your home at a level.",
    {
      home_path: { type: "string", description: "the file in your home, relative to it or absolute under it" },
      level: { type: "string", description: "agent, guild, or org" },
      description: { type: "string", description: "what the file is, in one or two sentences" },
      name: { type: "string", description: "the file's name in the store; default its name in your home" },
      mime: { type: "string", description: "the file's media type; default from its name" },
    },
    ["home_path", "level", "description"],
  ),
  async handler(ctx, args) {
    const homePath = argString(args, "home_path");
    const read = await readAgentFile(workspace(ctx), homePath, { maxBytes: FILE_MAX_BYTES }).catch(homeFileError);
    const name = argString(args, "name").trim() || path.basename(read.path);
    const store = files(ctx);
    const row = await store.putFile(actor(ctx), {
      level: levelArg(args),
      name,
      description: argString(args, "description"),
      mime: argString(args, "mime").trim() || mimeForName(name),
      bytes: read.bytes,
    });
    const display = store.view(row).display_path;
    await publish(ctx, display);
    return display;
  },
};

export const fileDelete: Tool = {
  name: "file_delete",
  description: "Delete a shared file by display path. You need write access to it.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema("file_delete", "Delete a shared file by display path.", { path: { type: "string" } }, ["path"]),
  async handler(ctx, args) {
    const store = files(ctx);
    const displayPath = argString(args, "path");
    const row = await store.loadFile(actor(ctx), displayPath);
    await store.deleteFile(actor(ctx), row);
    await publish(ctx, displayPath);
    return displayPath;
  },
};
