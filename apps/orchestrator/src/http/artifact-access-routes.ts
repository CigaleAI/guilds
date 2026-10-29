import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import { requireVisibleGuild } from "../guilds/access.js";
import type { RouteDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { bodyOf, param } from "./request.js";
import { accessList, reachOf, replaceAccess } from "../artifacts/access-lists.js";

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

  async function orgActor(request: FastifyRequest) {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return loadOperatorActor(db, user, { orgId: String(org.id) });
  }

  for (const target of ACCESS_TARGETS) {
    app.get(target.path, async (request) => {
      const actor = await orgActor(request);
      return accessList(store, actor, { kind: target.kind, id: param(request, target.param) });
    });

    app.put(target.path, async (request) => {
      const actor = await orgActor(request);
      const missing = missingBodyFields(request.body, ["subjects"]);
      if (missing) {
        throw missing;
      }
      const item = { kind: target.kind, id: param(request, target.param) };
      return replaceAccess(store, actor, item, bodyOf(request).subjects);
    });
  }

  app.get("/api/guilds/:guild_id/reach", async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, param(request, "guild_id"), user.id);
    const actor = await loadOperatorActor(db, user, { orgId: guild.org_id });
    return reachOf(store, actor, { type: "guild", id: guild.id, guildId: guild.id });
  });

  app.get("/api/agents/:agent_id/reach", async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, param(request, "agent_id"), user.id);
    const actor = await loadOperatorActor(db, user, { orgId: agent.org_id });
    return reachOf(store, actor, { type: "agent", id: agent.id, guildId: agent.guild_id });
  });
}
