import { Type } from "@sinclair/typebox";
import { SecretAccessChangeSchema } from "../secrets/access.js";
import {
  changeSecret,
  createSecret,
  deleteOrgSecret,
  listOrgSecrets,
  replaceSecretAccess,
  requireMemberSecret,
  SecretChangeSchema,
  SecretDraftSchema,
  viewHeldSecret,
  type SecretServices,
} from "../secrets/service.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentOrg, currentUser } from "./identity.js";

/** Which secrets to list: the organisation's, or the ones that reach a guild or an agent. */
const SecretListQuery = Type.Object({
  guild_id: Type.Optional(Type.String()),
  agent_id: Type.Optional(Type.String()),
});

/** The path of one secret. */
const SecretParams = Type.Object({ secret_id: Type.String() });

/** An organisation's secrets: listed, created, changed, granted, and deleted by its members. */
export async function registerSecretRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: SecretServices = {
    db,
    masterKey: deps.masterKey,
    runSecrets: deps.generation?.secrets ?? null,
  };

  app.get("/api/secrets", { schema: { querystring: SecretListQuery } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    const { query } = request;
    const scope = { guildId: query.guild_id || null, agentId: query.agent_id || null };
    return listOrgSecrets(db, String(org.id), user.id, scope);
  });

  app.post("/api/secrets", { schema: { body: SecretDraftSchema } }, async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const org = await currentOrg(db, request, user);
    return reply
      .code(201)
      .send(await createSecret(services, String(org.id), user.id, request.body));
  });

  app.get("/api/secrets/:secret_id", { schema: { params: SecretParams } }, async (request) => {
    const user = await currentUser(db, request, deps);
    return viewHeldSecret(await requireMemberSecret(db, request.params.secret_id, user.id));
  });

  app.patch(
    "/api/secrets/:secret_id",
    { schema: { params: SecretParams, body: SecretChangeSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const held = await requireMemberSecret(db, request.params.secret_id, user.id);
      return changeSecret(services, held, request.body);
    },
  );

  app.put(
    "/api/secrets/:secret_id/access",
    { schema: { params: SecretParams, body: SecretAccessChangeSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const held = await requireMemberSecret(db, request.params.secret_id, user.id);
      return replaceSecretAccess(services, held, request.body);
    },
  );

  app.delete(
    "/api/secrets/:secret_id",
    { schema: { params: SecretParams } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const held = await requireMemberSecret(db, request.params.secret_id, user.id);
      await deleteOrgSecret(services, held);
      return reply.code(204).send();
    },
  );
}
