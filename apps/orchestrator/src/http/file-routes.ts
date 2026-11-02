import { Type, type Static } from "typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SubjectEntry } from "../artifacts/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import type { ArtifactFiles } from "../artifacts/files.js";
import {
  deleteSharedFile,
  listAgentSharedFiles,
  listGuildSharedFiles,
  listOrgSharedFiles,
  readSharedFile,
  uploadSharedFile,
  type SharedFileDownload,
  type SharedFileReadDeps,
  type SharedFileUpload,
  type SharedFileWriteDeps,
} from "../artifacts/operator-files.js";
import { FILE_MAX_BYTES, type ArtifactActor } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { requireVisibleAgent } from "../agents/access.js";
import { attachmentDisposition } from "../attachments/index.js";
import type { AppDeps, RouteApp, RouteDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";

/**
 * An upload's headers: the file's name and description, URL-encoded, its media type, and, when the
 * upload creates it, the subject and mode of the row its access list starts with and the guild it
 * is homed in.
 */
const UploadHeadersSchema = Type.Object({
  "x-home-guild": Type.Optional(Type.String()),
  "x-filename": Type.Optional(Type.String()),
  "x-description": Type.Optional(Type.String()),
  "x-mime": Type.Optional(Type.String()),
  "x-access-type": Type.Optional(Type.String()),
  "x-access-id": Type.Optional(Type.String()),
  "x-access-mode": Type.Optional(Type.String()),
  "x-expected-version": Type.Optional(Type.String()),
});

type UploadHeaders = Static<typeof UploadHeadersSchema>;

/** The path of one file. */
const FileParams = Type.Object({ file_id: Type.String() });

// The operator's files API: the organisation's list and upload, the lists of a guild's and an
// agent's pages, and the file itself by id. Bytes are served for download only, never inline,
// whatever their media type says.

function filesOf(deps: AppDeps): ArtifactFiles {
  if (!deps.files) {
    throw new HttpError(422, "file store is not available");
  }
  return deps.files;
}

/** An upload route's request: the headers its schema reads, and the body as Fastify parsed it. */
type UploadRequest = Pick<FastifyRequest, "body"> & { headers: UploadHeaders };

/** The starting row the access headers name; none when they name none, a 422 when they name only part of one. */
function uploadAccess(headers: UploadHeaders): SubjectEntry | undefined {
  const type = (headers["x-access-type"] ?? "").trim();
  const id = (headers["x-access-id"] ?? "").trim();
  const mode = (headers["x-access-mode"] ?? "").trim();
  if (!type && !id && !mode) {
    return undefined;
  }
  if (!type || !id || !mode) {
    throw new HttpError(422, "X-Access-Type, X-Access-Id, and X-Access-Mode go together");
  }
  return { type, id, mode };
}

/** The version an upload replaces, from its header; none when it names none, a 422 when it is not an integer. */
function uploadExpectedVersion(headers: UploadHeaders): number | undefined {
  const raw = (headers["x-expected-version"] ?? "").trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(422, "X-Expected-Version must be a whole number");
  }
  return Number(raw);
}

/** The guild an upload is homed in, from its header; none when it names none. */
function uploadHome(headers: UploadHeaders): string | undefined {
  const guildId = (headers["x-home-guild"] ?? "").trim();
  return guildId || undefined;
}

/** The uploaded file: its name, description, media type, expected version, starting row, and home from the headers, its bytes the body. */
function fileUpload(request: UploadRequest): SharedFileUpload {
  const { headers, body } = request;
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
    expectedVersion: uploadExpectedVersion(headers),
    access: uploadAccess(headers),
    homeGuildId: uploadHome(headers),
  };
}

/** The user as the artifact actor of their organisation. */
async function orgActor(deps: AppDeps, request: FastifyRequest): Promise<ArtifactActor> {
  const user = await currentUser(deps.db, request, deps);
  const org = await currentOrg(deps.db, request, user);
  return loadOperatorActor(deps.db, user, { orgId: org.id });
}

/** What a file list runs with: the database the user's actor is loaded from, and the shared files. */
function fileReads(deps: AppDeps): SharedFileReadDeps {
  return { db: deps.db, files: filesOf(deps) };
}

/** What a file write runs with: the artifact store, the shared files, and the announcement of each change. */
function fileWrites(deps: RouteDeps): SharedFileWriteDeps {
  return {
    artifacts: deps.artifacts,
    files: filesOf(deps),
    ...(deps.publishSharedFileChanged ? { publishSharedFileChanged: deps.publishSharedFileChanged } : {}),
  };
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

export async function registerFileRoutes(app: RouteApp, deps: RouteDeps): Promise<void> {
  const upload = { bodyLimit: FILE_MAX_BYTES + 4096 };

  app.get("/api/agents/:agent_id/files", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(deps.db, request, deps);
    const agent = await requireVisibleAgent(deps.db, request.params.agent_id, user.id);
    return listAgentSharedFiles(fileReads(deps), agent, user);
  });

  app.get("/api/guilds/:guild_id/files", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(deps.db, request, deps);
    const guild = await requireVisibleGuild(deps.db, request.params.guild_id, user.id);
    return listGuildSharedFiles(fileReads(deps), guild, user);
  });

  app.get("/api/org/files", async (request) => {
    const user = await currentUser(deps.db, request, deps);
    const org = await currentOrg(deps.db, request, user);
    return listOrgSharedFiles(fileReads(deps), org.id, user);
  });
  app.post(
    "/api/org/files",
    { ...upload, schema: { headers: UploadHeadersSchema } },
    async (request, reply) => {
      const actor = await orgActor(deps, request);
      const view = await uploadSharedFile(fileWrites(deps), actor, fileUpload(request));
      return reply.code(201).send(view);
    },
  );

  app.get("/api/files/:file_id", { schema: { params: FileParams } }, async (request, reply) => {
    const actor = await orgActor(deps, request);
    return sendBytes(reply, await readSharedFile(filesOf(deps), actor, request.params.file_id));
  });

  app.delete("/api/files/:file_id", { schema: { params: FileParams } }, async (request, reply) => {
    const actor = await orgActor(deps, request);
    await deleteSharedFile(fileWrites(deps), actor, request.params.file_id);
    return reply.code(204).send();
  });
}
