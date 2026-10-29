import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadOperatorActor } from "../artifacts/actors.js";
import { ArtifactFiles } from "../artifacts/files.js";
import { FILE_MAX_BYTES, type ArtifactActor, type ArtifactLevel } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { requireVisibleAgent } from "../agents/access.js";
import { attachmentDisposition } from "../attachments/index.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { publishGroup } from "./publish.js";
import { param } from "./request.js";

// The operator's files API: one list and one upload route per level, and the file itself by id.
// Bytes are served for download only, never inline, whatever their media type says.

function filesOf(deps: AppDeps): ArtifactFiles {
  if (!deps.files) {
    throw new HttpError(422, "file store is not available");
  }
  return deps.files;
}

/** The uploaded file's name, description, and media type, from the request headers. */
function uploadHeaders(request: FastifyRequest): { name: string; description: string; mime: string } {
  const header = (key: string) => String(request.headers[key] ?? "").trim();
  const name = header("x-filename");
  const description = header("x-description");
  if (!name || !description) {
    throw new HttpError(422, "X-Filename and X-Description are required");
  }
  return { name: decodeURIComponent(name), description: decodeURIComponent(description), mime: header("x-mime") };
}

function uploadBytes(request: FastifyRequest): Buffer {
  if (!Buffer.isBuffer(request.body)) {
    throw new HttpError(422, "body must be the file bytes");
  }
  return request.body;
}

/** The owner a list or upload route names: the level, its id, the guild to publish to, and the actor. */
type FileOwner = { level: ArtifactLevel; ownerId: string; guildId: string | null; actor: ArtifactActor };

async function agentOwner(deps: AppDeps, request: FastifyRequest): Promise<FileOwner> {
  const user = await currentUser(deps.db, request, deps);
  const row = await requireVisibleAgent(deps.db, param(request, "agent_id"), user.id);
  const actor = await loadOperatorActor(deps.db, user, {
    orgId: String(row.org_id),
    guildId: String(row.guild_id),
    agentId: String(row.id),
  });
  return { level: "agent", ownerId: String(row.id), guildId: String(row.guild_id), actor };
}

async function guildOwner(deps: AppDeps, request: FastifyRequest): Promise<FileOwner> {
  const user = await currentUser(deps.db, request, deps);
  const row = await requireVisibleGuild(deps.db, param(request, "guild_id"), user.id);
  const actor = await loadOperatorActor(deps.db, user, { orgId: String(row.org_id), guildId: String(row.id) });
  return { level: "guild", ownerId: String(row.id), guildId: String(row.id), actor };
}

async function orgOwner(deps: AppDeps, request: FastifyRequest): Promise<FileOwner> {
  const user = await currentUser(deps.db, request, deps);
  const org = await currentOrg(deps.db, request, user);
  const actor = await loadOperatorActor(deps.db, user, { orgId: String(org.id) });
  return { level: "org", ownerId: String(org.id), guildId: null, actor };
}

async function publishFileChanged(deps: AppDeps, guildId: string | null, displayPath: string): Promise<void> {
  if (guildId) {
    await publishGroup(deps, guildId, "guild.artifacts.changed", { scope: "files", path: displayPath });
  }
}

function registerOwnerRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  path: string,
  owner: (deps: AppDeps, request: FastifyRequest) => Promise<FileOwner>,
): void {
  app.get(path, async (request) => {
    const { level, ownerId, actor } = await owner(deps, request);
    return await filesOf(deps).listOwnerFiles(actor, level, ownerId);
  });

  app.post(path, { bodyLimit: FILE_MAX_BYTES + 4096 }, async (request, reply) => {
    const { level, guildId, actor } = await owner(deps, request);
    const files = filesOf(deps);
    const bytes = uploadBytes(request);
    const row = await files.putFile(actor, { level, ...uploadHeaders(request), bytes });
    const view = files.view(row);
    await publishFileChanged(deps, guildId, view.display_path);
    return reply.code(201).send(view);
  });
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

export async function registerFileRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  registerOwnerRoutes(app, deps, "/api/agents/:agent_id/files", agentOwner);
  registerOwnerRoutes(app, deps, "/api/guilds/:guild_id/files", guildOwner);
  registerOwnerRoutes(app, deps, "/api/org/files", orgOwner);

  app.get("/api/files/:file_id", async (request, reply) => {
    const { actor } = await orgOwner(deps, request);
    const files = filesOf(deps);
    const row = await files.loadFileById(actor, param(request, "file_id"));
    return sendBytes(reply, files.view(row), await files.readBytes(row));
  });

  app.delete("/api/files/:file_id", async (request, reply) => {
    const { actor } = await orgOwner(deps, request);
    const files = filesOf(deps);
    const row = await files.loadFileById(actor, param(request, "file_id"));
    await files.deleteFile(actor, row);
    await publishFileChanged(deps, row.guild_id, files.view(row).display_path);
    return reply.code(204).send();
  });
}
