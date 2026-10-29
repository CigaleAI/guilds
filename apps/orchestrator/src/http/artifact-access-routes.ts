import { Type } from "@sinclair/typebox";
import type { FastifyRequest } from "fastify";
import { requireVisibleAgent } from "../agents/access.js";
import { AccessListSchema } from "../artifacts/access.js";
import { loadOperatorActor } from "../artifacts/actors.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { requireVisibleGuild } from "../guilds/access.js";
import type { RouteApp, RouteDeps } from "./deps.js";
import { currentOrg, currentUser } from "./identity.js";
import { AgentParams, GuildParams } from "./params.js";
import { accessList, reachOf, replaceAccess } from "../artifacts/access-lists.js";

/** The path of one item whose access list a route reads or replaces. */
const ItemParams = Type.Object({ item_id: Type.String() });

/** The items whose access lists the same routes read and replace. */
const ACCESS_TARGETS = [
  { path: "/api/notes/:item_id/access", kind: "note" },
  { path: "/api/collections/:item_id/access", kind: "collection" },
  { path: "/api/files/:item_id/access", kind: "file" },
] as const;

/** An item's access list, and what a guild or an agent reaches across the organisation's items. */
export async function registerArtifactAccessRoutes(app: RouteApp, deps: RouteDeps): Promise<void> {
  const { db, artifacts: store } = deps;

  async function orgActor(request: FastifyRequest): Promise<ArtifactActor> {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return loadOperatorActor(db, user, { orgId: String(org.id) });
  }

  for (const target of ACCESS_TARGETS) {
    app.get(target.path, { schema: { params: ItemParams } }, async (request) => {
      const actor = await orgActor(request);
      return accessList(store, actor, { kind: target.kind, id: request.params.item_id });
    });

    app.put(
      target.path,
      { schema: { params: ItemParams, body: AccessListSchema } },
      async (request) => {
        const actor = await orgActor(request);
        const item = { kind: target.kind, id: request.params.item_id };
        return replaceAccess(store, actor, item, request.body.subjects);
      },
    );
  }

  app.get("/api/guilds/:guild_id/reach", { schema: { params: GuildParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const guild = await requireVisibleGuild(db, request.params.guild_id, user.id);
    const actor = await loadOperatorActor(db, user, { orgId: guild.org_id });
    return reachOf(store, actor, { type: "guild", id: guild.id, guildId: guild.id });
  });

  app.get("/api/agents/:agent_id/reach", { schema: { params: AgentParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const agent = await requireVisibleAgent(db, request.params.agent_id, user.id);
    const actor = await loadOperatorActor(db, user, { orgId: agent.org_id });
    return reachOf(store, actor, { type: "agent", id: agent.id, guildId: agent.guild_id });
  });
}
