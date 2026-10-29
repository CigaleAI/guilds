import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import {
  latestFileChanges,
  listPathChanges,
  readEmbeddableNotes,
} from "../artifacts/host-files.js";
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
import type { RouteDeps } from "./deps.js";
import { notesRead, notesWrite } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { bodyOf, filePathParam, param, queryOf } from "./request.js";
import type { UserRow } from "../db/users.js";

/** The paths a comma-separated query value or a JSON array in a body lists. */
function pathsOf(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  return items.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * The notes of a guild, an agent and the organisation, an agent's memory history, the change
 * log of a file, and the notes an organisation can embed.
 */
export async function registerNoteRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const services: OperatorNotesServices = {
    db,
    artifacts: deps.artifacts,
    stream: deps.generation?.groupChat ?? null,
  };

  /** The routes of one owner's notes: the list, and one note read, written and deleted by path. */
  function registerOwnerNotes(
    prefix: string,
    resolve: (
      request: FastifyRequest,
    ) => Promise<{ owner: NotesOwner; user: UserRow }>,
  ): void {
    app.get(prefix, async (request) => {
      const { owner, user } = await resolve(request);
      return notesRead(listOwnerNotes(services, owner, user));
    });

    app.get(`${prefix}/*`, async (request) => {
      const { owner, user } = await resolve(request);
      return notesRead(readOwnerNote(services, owner, user, filePathParam(request)));
    });

    app.put(`${prefix}/*`, async (request) => {
      const { owner, user } = await resolve(request);
      const body = bodyOf(request);
      const write = {
        path: filePathParam(request),
        content: String(body.content ?? ""),
        expectedVersion: body.expected_version,
      };
      return notesWrite(writeOwnerNote(services, owner, user, write));
    });

    app.delete(`${prefix}/*`, async (request, reply) => {
      const { owner, user } = await resolve(request);
      await notesWrite(deleteOwnerNote(services, owner, user, filePathParam(request)));
      return reply.code(204).send();
    });
  }

  registerOwnerNotes("/api/guilds/:guild_id/notes", async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    return { owner: { level: "guild", guild }, user };
  });

  registerOwnerNotes("/api/agents/:agent_id/notes", async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return { owner: { level: "agent", agent }, user };
  });

  registerOwnerNotes("/api/org/notes", async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return { owner: { level: "org", orgId: String(org.id) }, user };
  });

  app.get("/api/agents/:agent_id/memory", async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    return readMemoryHistory(services, agent, user);
  });

  async function orgActor(request: FastifyRequest) {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return loadOperatorActor(db, user, { orgId: String(org.id) });
  }

  app.get("/api/file-changes", async (request) => {
    const actor = await orgActor(request);
    const displayPath = String(queryOf(request).display_path ?? "").trim();
    return listPathChanges({ store: deps.artifacts, db }, actor, displayPath);
  });

  // Newest change per display path. `display_paths` is comma-separated in
  // the query, or a JSON array in a POST body when the list is long.
  app.get("/api/file-changes/latest", async (request) => {
    const actor = await orgActor(request);
    const paths = pathsOf(queryOf(request).display_paths);
    return latestFileChanges({ store: deps.artifacts, db }, actor, paths);
  });

  app.post("/api/file-changes/latest", async (request) => {
    const actor = await orgActor(request);
    const raw = bodyOf(request).display_paths;
    const paths = Array.isArray(raw) ? pathsOf(raw) : [];
    return latestFileChanges({ store: deps.artifacts, db }, actor, paths);
  });

  app.get("/api/org/embeddable-notes", async (request) => {
    const actor = await orgActor(request);
    const displayPath = String(queryOf(request).display_path ?? "").trim();
    return readEmbeddableNotes(deps.artifacts, actor, displayPath);
  });
}
