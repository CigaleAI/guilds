import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { loadOperatorActor } from "../artifacts/index.js";
import { requireVisibleGuild } from "../guilds/access.js";
import type { RouteDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param } from "./request.js";

/** The items whose access lists the same routes read and replace. */
const ACCESS_TARGETS = [
  { path: "/api/notes/:note_id/access", kind: "note", param: "note_id" },
  { path: "/api/collections/:collection_id/access", kind: "collection", param: "collection_id" },
  { path: "/api/files/:file_id/access", kind: "file", param: "file_id" },
] as const;

/** An item's access list, and what a guild or an agent reaches across the organisation's items. */
export async function registerArtifactAccessRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { db, artifacts: store } = deps;
  const identityDb = identityDatabase(db);

  async function orgActor(request: FastifyRequest) {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    return loadOperatorActor(db, user, { orgId: String(org.id) });
  }

  for (const target of ACCESS_TARGETS) {
    app.get(target.path, async (request) => {
      const actor = await orgActor(request);
      return store.accessList(actor, { kind: target.kind, id: param(request, target.param) });
    });

    app.put(target.path, async (request) => {
      const actor = await orgActor(request);
      const missing = missingBodyFields(request.body, ["subjects"]);
      if (missing) {
        throw missing;
      }
      const item = { kind: target.kind, id: param(request, target.param) };
      return store.replaceAccess(actor, item, bodyOf(request).subjects);
    });
  }

  app.get("/api/guilds/:guild_id/reach", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const actor = await loadOperatorActor(db, user, { orgId: guild.org_id });
    return store.reachOf(actor, { type: "guild", id: guild.id, guildId: guild.id });
  });

  app.get("/api/agents/:agent_id/reach", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const actor = await loadOperatorActor(db, user, { orgId: agent.org_id });
    return store.reachOf(actor, { type: "agent", id: agent.id, guildId: agent.guild_id });
  });
}
