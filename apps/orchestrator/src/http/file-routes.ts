import { Type, type Static } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ArtifactFiles, type FileView } from "../artifacts/files.js";
import {
  deleteSharedFile,
  listSharedFiles,
  loadSharedFileActor,
  readSharedFile,
  uploadSharedFile,
  type SharedFileDownload,
  type SharedFileOwner,
} from "../artifacts/operator-files.js";
import { FILE_MAX_BYTES, type ArtifactActor } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { requireVisibleAgent } from "../agents/access.js";
import { attachmentDisposition } from "../attachments/index.js";
import type { UserRow } from "../db/users.js";
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

/** Whose files a list or upload route names, and the user it lists or uploads them for. */
type FileScope = { owner: SharedFileOwner; user: UserRow };

async function agentFiles(deps: AppDeps, request: FastifyRequest, agentId: string): Promise<FileScope> {
  const user = await currentUser(deps.db, request, deps);
  const agent = await requireVisibleAgent(deps.db, agentId, user.id);
  return { owner: { level: "agent", agent }, user };
}

async function guildFiles(deps: AppDeps, request: FastifyRequest, guildId: string): Promise<FileScope> {
  const user = await currentUser(deps.db, request, deps);
  const guild = await requireVisibleGuild(deps.db, guildId, user.id);
  return { owner: { level: "guild", guild }, user };
}

async function orgFiles(deps: AppDeps, request: FastifyRequest): Promise<FileScope> {
  const user = await currentUser(deps.db, request, deps);
  const org = await currentOrg(deps.db, request, user);
  return { owner: { level: "org", orgId: org.id }, user };
}

/** The user as the artifact actor of their organisation. */
async function orgActor(deps: AppDeps, request: FastifyRequest): Promise<ArtifactActor> {
  const scope = await orgFiles(deps, request);
  return await loadSharedFileActor(deps.db, scope.owner, scope.user);
}

/** The files an owner holds that the user may read. */
async function listFiles(deps: AppDeps, scope: FileScope): Promise<FileView[]> {
  return await listSharedFiles({ db: deps.db, files: filesOf(deps) }, scope.owner, scope.user);
}

/** Stores an upload as the owner's file, or a new version of the file of that name, and answers 201. */
async function uploadFile(
  deps: AppDeps,
  reply: FastifyReply,
  scope: FileScope,
  upload: FileUpload,
): Promise<FastifyReply> {
  const actor = await loadSharedFileActor(deps.db, scope.owner, scope.user);
  const writes = { ...deps, files: filesOf(deps) };
  const view = await uploadSharedFile(writes, actor, { level: scope.owner.level, ...upload });
  return reply.code(201).send(view);
}

/** Sends a file's bytes for download: its media type, no sniffing, never shown inline. */
function sendBytes(reply: FastifyReply, download: SharedFileDownload): FastifyReply {
  return reply
    .header("content-type", download.file.mime)
    .header("x-content-type-options", "nosniff")
    .header("content-disposition", attachmentDisposition(download.file.name))
    .header("cache-control", "private, no-store")
    .send(download.bytes);
}

export async function registerFileRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const upload = { bodyLimit: FILE_MAX_BYTES + 4096 };

  app.get("/api/agents/:agent_id/files", { schema: { params: AgentParams } }, async (request) =>
    listFiles(deps, await agentFiles(deps, request, request.params.agent_id)),
  );
  app.post(
    "/api/agents/:agent_id/files",
    { ...upload, schema: { params: AgentParams, headers: UploadHeadersSchema } },
    async (request, reply) => {
      const scope = await agentFiles(deps, request, request.params.agent_id);
      return uploadFile(deps, reply, scope, fileUpload(request.headers, request.body));
    },
  );

  app.get("/api/guilds/:guild_id/files", { schema: { params: GuildParams } }, async (request) =>
    listFiles(deps, await guildFiles(deps, request, request.params.guild_id)),
  );
  app.post(
    "/api/guilds/:guild_id/files",
    { ...upload, schema: { params: GuildParams, headers: UploadHeadersSchema } },
    async (request, reply) => {
      const scope = await guildFiles(deps, request, request.params.guild_id);
      return uploadFile(deps, reply, scope, fileUpload(request.headers, request.body));
    },
  );

  app.get("/api/org/files", async (request) => listFiles(deps, await orgFiles(deps, request)));
  app.post(
    "/api/org/files",
    { ...upload, schema: { headers: UploadHeadersSchema } },
    async (request, reply) => {
      const scope = await orgFiles(deps, request);
      return uploadFile(deps, reply, scope, fileUpload(request.headers, request.body));
    },
  );

  app.get("/api/files/:file_id", { schema: { params: FileParams } }, async (request, reply) => {
    const actor = await orgActor(deps, request);
    return sendBytes(reply, await readSharedFile(filesOf(deps), actor, request.params.file_id));
  });

  app.delete("/api/files/:file_id", { schema: { params: FileParams } }, async (request, reply) => {
    const actor = await orgActor(deps, request);
    await deleteSharedFile({ ...deps, files: filesOf(deps) }, actor, request.params.file_id);
    return reply.code(204).send();
  });
}
