import { Type } from "typebox";
import type { FastifyRequest } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { SubjectEntrySchema } from "../artifacts/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import {
  latestFileChanges,
  listPathChanges,
  readEmbeddableNotes,
} from "../artifacts/host-files.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import {
  deleteOrgNote,
  listAgentPageNotes,
  listGuildPageNotes,
  listOrgPageNotes,
  readAgentFile,
  readMemoryHistory,
  readOrgNote,
  writeAgentFile,
  writeOrgNote,
  type OperatorNotesServices,
} from "../notes/operator.js";
import type { RouteApp, RouteDeps } from "./deps.js";
import { notesRead } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { AgentParams, filePathParam, GuildParams } from "./params.js";
import type { UserRow } from "../db/users.js";

/**
 * A note's content, the version the writer edited (0 for a note that must not exist yet), and the
 * subject and mode of the row its access list starts with when the write creates it.
 */
const NoteWriteSchema = Type.Object({
  content: Type.Optional(Type.String()),
  expected_version: Type.Optional(Type.Integer()),
  access: Type.Optional(SubjectEntrySchema),
});

/** An agent's `task.md` or `memory.md` content, and the version the writer edited when they name one. */
const AgentFileWriteSchema = Type.Object({
  content: Type.Optional(Type.String()),
  expected_version: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

/** The files an agent's notes routes read and write by name: its Task and its Memory. */
const AGENT_FILES = ["task.md", "memory.md"] as const;

/** The file a change log or the embeddable notes name by its display path. */
const DisplayPathQuerySchema = Type.Object({ display_path: Type.Optional(Type.String()) });

/** The files whose newest change a query asks for, comma-separated. */
const DisplayPathsQuerySchema = Type.Object({ display_paths: Type.Optional(Type.String()) });

/** The files whose newest change a body asks for, when the list is too long for a query. */
const DisplayPathsSchema = Type.Object({
  display_paths: Type.Optional(Type.Array(Type.String())),
});

/** The paths a list names, trimmed, without the empty ones. */
function pathsOf(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

/**
 * The organisation's notes by key, the notes a guild's and an agent's pages list, an agent's Task
 * and Memory, an agent's memory history, the change log of a file, and the notes an organisation
 * can embed.
 */
export async function registerNoteRoutes(app: RouteApp, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const services: OperatorNotesServices = {
    db,
    artifacts: deps.artifacts,
    stream: deps.generation?.groupChat ?? null,
  };

  async function orgScope(request: FastifyRequest): Promise<{ orgId: string; user: UserRow }> {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return { orgId: String(org.id), user };
  }

  app.get("/api/guilds/:guild_id/notes", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
    return notesRead(listGuildPageNotes(services, guild, user));
  });

  app.get("/api/agents/:agent_id/notes", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
    return notesRead(listAgentPageNotes(services, agent, user));
  });

  for (const name of AGENT_FILES) {
    app.get(`/api/agents/:agent_id/notes/${name}`, { schema: { params: AgentParams } }, async (request) => {
      const user = await currentUser(db, request, deps);
      const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
      return notesRead(readAgentFile(services, agent, user, name));
    });

    app.put(
      `/api/agents/:agent_id/notes/${name}`,
      { schema: { params: AgentParams, body: AgentFileWriteSchema } },
      async (request) => {
        const user = await currentUser(db, request, deps);
        const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
        const write = { path: name, content: request.body.content ?? "", expectedVersion: request.body.expected_version };
        return writeAgentFile(services, agent, user, write);
      },
    );
  }

  app.get("/api/org/notes", async (request) => {
    const { orgId, user } = await orgScope(request);
    return notesRead(listOrgPageNotes(services, orgId, user));
  });

  app.get("/api/org/notes/*", async (request) => {
    const { orgId, user } = await orgScope(request);
    return notesRead(readOrgNote(services, orgId, user, filePathParam(request)));
  });

  app.put("/api/org/notes/*", { schema: { body: NoteWriteSchema } }, async (request) => {
    const { orgId, user } = await orgScope(request);
    const write = {
      path: filePathParam(request),
      content: request.body.content ?? "",
      expectedVersion: request.body.expected_version,
      access: request.body.access,
    };
    return writeOrgNote(services, orgId, user, write);
  });

  app.delete("/api/org/notes/*", async (request, reply) => {
    const { orgId, user } = await orgScope(request);
    await deleteOrgNote(services, orgId, user, filePathParam(request));
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
