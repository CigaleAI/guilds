import { Type, type Static } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import { loadOperatorActor } from "../artifacts/actors.js";
import { ArtifactFiles, type FileView } from "../artifacts/files.js";
import { deleteSharedFile, uploadSharedFile } from "../artifacts/operator-files.js";
import { FILE_MAX_BYTES, type ArtifactActor, type ArtifactLevel } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { requireVisibleAgent } from "../agents/access.js";
import { attachmentDisposition } from "../attachments/index.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";

/** An upload's headers: the file's name and description, URL-encoded, and its media type. */
const UploadHeadersSchema = Type.Object({
  "x-filename": Type.Optional(Type.String()),
  "x-description": Type.Optional(Type.String()),
  "x-mime": Type.Optional(Type.String()),
});

type UploadHeaders = Static<typeof UploadHeadersSchema>;

/** The path of one file. */
const FileParams = Type.Object({ file_id: Type.String() });

// The operator's files API: one list and one upload route per level, and the file itself by id.
// Bytes are served for download only, never inline, whatever their media type says.

function filesOf(deps: AppDeps): ArtifactFiles {
  if (!deps.files) {
    throw new HttpError(422, "file store is not available");
  }
  return deps.files;
}

/** A file as an upload carries it: its name, description, and media type, and its bytes. */
type FileUpload = { name: string; description: string; mime: string; bytes: Buffer };

/** The uploaded file: its name, description, and media type from the headers, its bytes the body. */
function fileUpload(headers: UploadHeaders, body: unknown): FileUpload {
  if (!Buffer.isBuffer(body)) {
    throw new HttpError(422, "body must be the file bytes");
  }
  const name = (headers["x-filename"] ?? "").trim();
  const description = (headers["x-description"] ?? "").trim();
  if (!name || !description) {
    throw new HttpError(422, "X-Filename and X-Description are required");
  }
  return {
    name: decodeURIComponent(name),
    description: decodeURIComponent(description),
    mime: (headers["x-mime"] ?? "").trim(),
    bytes: body,
  };
}

/** The owner a list or upload route names: the level, its id, and the actor. */
type FileOwner = { level: ArtifactLevel; ownerId: string; actor: ArtifactActor };

async function agentOwner(
  deps: AppDeps,
  request: FastifyRequest,
  agentId: string,
): Promise<FileOwner> {
  const user = await currentUser(deps.db, request, deps);
  const row = await requireVisibleAgent(deps.db, agentId, user.id);
  const actor = await loadOperatorActor(deps.db, user, {
    orgId: String(row.org_id),
    guildId: String(row.guild_id),
    agentId: String(row.id),
  });
  return { level: "agent", ownerId: String(row.id), actor };
}

async function guildOwner(
  deps: AppDeps,
  request: FastifyRequest,
  guildId: string,
): Promise<FileOwner> {
  const user = await currentUser(deps.db, request, deps);
  const row = await requireVisibleGuild(deps.db, guildId, user.id);
  const actor = await loadOperatorActor(deps.db, user, { orgId: String(row.org_id), guildId: String(row.id) });
  return { level: "guild", ownerId: String(row.id), actor };
}

async function orgOwner(deps: AppDeps, request: FastifyRequest): Promise<FileOwner> {
  const user = await currentUser(deps.db, request, deps);
  const org = await currentOrg(deps.db, request, user);
  const actor = await loadOperatorActor(deps.db, user, { orgId: String(org.id) });
  return { level: "org", ownerId: String(org.id), actor };
}

/** The files an owner holds. */
async function listFiles(deps: AppDeps, owner: FileOwner): Promise<FileView[]> {
  return await filesOf(deps).listOwnerFiles(owner.actor, owner.level, owner.ownerId);
}

/** Stores an upload as the owner's file, or a new version of the file of that name, and answers 201. */
async function uploadFile(
  deps: AppDeps,
  reply: FastifyReply,
  owner: FileOwner,
  upload: FileUpload,
): Promise<FastifyReply> {
  const writes = { ...deps, files: filesOf(deps) };
  const view = await uploadSharedFile(writes, owner.actor, { level: owner.level, ...upload });
  return reply.code(201).send(view);
}

/** Sends a file's bytes for download: its media type, no sniffing, never shown inline. */
function sendBytes(reply: FastifyReply, file: { name: string; mime: string }, bytes: Buffer): FastifyReply {
  return reply
    .header("content-type", file.mime)
    .header("x-content-type-options", "nosniff")
    .header("content-disposition", attachmentDisposition(file.name))
    .header("cache-control", "private, no-store")
    .send(bytes);
}

export async function registerFileRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const upload = { bodyLimit: FILE_MAX_BYTES + 4096 };

  app.get("/api/agents/:agent_id/files", { schema: { params: AgentParams } }, async (request) =>
    listFiles(deps, await agentOwner(deps, request, request.params.agent_id)),
  );
  app.post(
    "/api/agents/:agent_id/files",
    { ...upload, schema: { params: AgentParams, headers: UploadHeadersSchema } },
    async (request, reply) => {
      const owner = await agentOwner(deps, request, request.params.agent_id);
      return uploadFile(deps, reply, owner, fileUpload(request.headers, request.body));
    },
  );

  app.get("/api/guilds/:guild_id/files", { schema: { params: GuildParams } }, async (request) =>
    listFiles(deps, await guildOwner(deps, request, request.params.guild_id)),
  );
  app.post(
    "/api/guilds/:guild_id/files",
    { ...upload, schema: { params: GuildParams, headers: UploadHeadersSchema } },
    async (request, reply) => {
      const owner = await guildOwner(deps, request, request.params.guild_id);
      return uploadFile(deps, reply, owner, fileUpload(request.headers, request.body));
    },
  );

  app.get("/api/org/files", async (request) => listFiles(deps, await orgOwner(deps, request)));
  app.post(
    "/api/org/files",
    { ...upload, schema: { headers: UploadHeadersSchema } },
    async (request, reply) => {
      const owner = await orgOwner(deps, request);
      return uploadFile(deps, reply, owner, fileUpload(request.headers, request.body));
    },
  );

  app.get("/api/files/:file_id", { schema: { params: FileParams } }, async (request, reply) => {
    const { actor } = await orgOwner(deps, request);
    const files = filesOf(deps);
    const row = await files.loadFileById(actor, request.params.file_id);
    return sendBytes(reply, files.view(row), await files.readBytes(row));
  });

  app.delete("/api/files/:file_id", { schema: { params: FileParams } }, async (request, reply) => {
    const { actor } = await orgOwner(deps, request);
    await deleteSharedFile({ ...deps, files: filesOf(deps) }, actor, request.params.file_id);
    return reply.code(204).send();
  });
}
