import { Type, type Static } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import {
  latestFileChanges,
  listPathChanges,
  readEmbeddableNotes,
} from "../artifacts/host-files.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import {
  deleteOwnerNote,
  listOwnerNotes,
  readMemoryHistory,
  readOwnerNote,
  writeOwnerNote,
  type NotesOwner,
  type OperatorNotesServices,
} from "../notes/operator.js";
import type { RouteApp, RouteDeps } from "./deps.js";
import { notesRead } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { AgentParams, filePathParam, GuildParams } from "./params.js";
import type { UserRow } from "../db/users.js";

/** A note's content, and the version the writer edited when they name one. */
const NoteWriteSchema = Type.Object({
  content: Type.Optional(Type.String()),
  expected_version: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

type NoteWriteBody = Static<typeof NoteWriteSchema>;

/** The file a change log or the embeddable notes name by its display path. */
const DisplayPathQuerySchema = Type.Object({ display_path: Type.Optional(Type.String()) });

/** The files whose newest change a query asks for, comma-separated. */
const DisplayPathsQuerySchema = Type.Object({ display_paths: Type.Optional(Type.String()) });

/** The files whose newest change a body asks for, when the list is too long for a query. */
const DisplayPathsSchema = Type.Object({
  display_paths: Type.Optional(Type.Array(Type.String())),
});

/** Whose notes a route reads or writes, and the user it does it for. */
type NoteScope = { owner: NotesOwner; user: UserRow };

/** The paths a list names, trimmed, without the empty ones. */
function pathsOf(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

/**
 * The notes of a guild, an agent and the organisation, an agent's memory history, the change
 * log of a file, and the notes an organisation can embed.
 */
export async function registerNoteRoutes(app: RouteApp, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const services: OperatorNotesServices = {
    db,
    artifacts: deps.artifacts,
    stream: deps.generation?.groupChat ?? null,
  };

  async function guildNotes(request: FastifyRequest, guildId: string): Promise<NoteScope> {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, guildId, user.id);
    return { owner: { level: "guild", guild }, user };
  }

  async function agentNotes(request: FastifyRequest, agentId: string): Promise<NoteScope> {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, agentId, user.id);
    return { owner: { level: "agent", agent }, user };
  }

  async function orgNotes(request: FastifyRequest): Promise<NoteScope> {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return { owner: { level: "org", orgId: String(org.id) }, user };
  }

  // One owner's notes: the list, and one note read, written and deleted by the path the
  // wildcard names.
  const listNotes = (scope: NoteScope) =>
    notesRead(listOwnerNotes(services, scope.owner, scope.user));
  const readNote = (scope: NoteScope, request: FastifyRequest) =>
    notesRead(readOwnerNote(services, scope.owner, scope.user, filePathParam(request)));
  const writeNote = (scope: NoteScope, request: FastifyRequest, body: NoteWriteBody) => {
    const write = {
      path: filePathParam(request),
      content: body.content ?? "",
      expectedVersion: body.expected_version,
    };
    return writeOwnerNote(services, scope.owner, scope.user, write);
  };
  const deleteNote = (scope: NoteScope, request: FastifyRequest) =>
    deleteOwnerNote(services, scope.owner, scope.user, filePathParam(request));

  app.get("/api/guilds/:guild_id/notes", { schema: { params: GuildParams } }, async (request) =>
    listNotes(await guildNotes(request, request.params.guild_id)),
  );

  app.get("/api/guilds/:guild_id/notes/*", { schema: { params: GuildParams } }, async (request) =>
    readNote(await guildNotes(request, request.params.guild_id), request),
  );

  app.put(
    "/api/guilds/:guild_id/notes/*",
    { schema: { params: GuildParams, body: NoteWriteSchema } },
    async (request) =>
      writeNote(await guildNotes(request, request.params.guild_id), request, request.body),
  );

  app.delete(
    "/api/guilds/:guild_id/notes/*",
    { schema: { params: GuildParams } },
    async (request, reply) => {
      await deleteNote(await guildNotes(request, request.params.guild_id), request);
      return reply.code(204).send();
    },
  );

  app.get("/api/agents/:agent_id/notes", { schema: { params: AgentParams } }, async (request) =>
    listNotes(await agentNotes(request, request.params.agent_id)),
  );

  app.get("/api/agents/:agent_id/notes/*", { schema: { params: AgentParams } }, async (request) =>
    readNote(await agentNotes(request, request.params.agent_id), request),
  );

  app.put(
    "/api/agents/:agent_id/notes/*",
    { schema: { params: AgentParams, body: NoteWriteSchema } },
    async (request) =>
      writeNote(await agentNotes(request, request.params.agent_id), request, request.body),
  );

  app.delete(
    "/api/agents/:agent_id/notes/*",
    { schema: { params: AgentParams } },
    async (request, reply) => {
      await deleteNote(await agentNotes(request, request.params.agent_id), request);
      return reply.code(204).send();
    },
  );

  app.get("/api/org/notes", async (request) => listNotes(await orgNotes(request)));

  app.get("/api/org/notes/*", async (request) => readNote(await orgNotes(request), request));

  app.put("/api/org/notes/*", { schema: { body: NoteWriteSchema } }, async (request) =>
    writeNote(await orgNotes(request), request, request.body),
  );

  app.delete("/api/org/notes/*", async (request, reply) => {
    await deleteNote(await orgNotes(request), request);
    return reply.code(204).send();
  });

  app.get("/api/agents/:agent_id/memory", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
    return readMemoryHistory(services, agent, user);
  });

  async function orgActor(request: FastifyRequest): Promise<ArtifactActor> {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return loadOperatorActor(db, user, { orgId: String(org.id) });
  }

  app.get(
    "/api/file-changes",
    { schema: { querystring: DisplayPathQuerySchema } },
    async (request) => {
      const actor = await orgActor(request);
      const displayPath = (request.query.display_path ?? "").trim();
      return listPathChanges({ store: deps.artifacts, db }, actor, displayPath);
    },
  );

  app.get(
    "/api/file-changes/latest",
    { schema: { querystring: DisplayPathsQuerySchema } },
    async (request) => {
      const actor = await orgActor(request);
      const paths = pathsOf((request.query.display_paths ?? "").split(","));
      return latestFileChanges({ store: deps.artifacts, db }, actor, paths);
    },
  );

  app.post(
    "/api/file-changes/latest",
    { schema: { body: DisplayPathsSchema } },
    async (request) => {
      const actor = await orgActor(request);
      const paths = pathsOf(request.body.display_paths ?? []);
      return latestFileChanges({ store: deps.artifacts, db }, actor, paths);
    },
  );

  app.get(
    "/api/org/embeddable-notes",
    { schema: { querystring: DisplayPathQuerySchema } },
    async (request) => {
      const actor = await orgActor(request);
      const displayPath = (request.query.display_path ?? "").trim();
      return readEmbeddableNotes(deps.artifacts, actor, displayPath);
    },
  );
}
