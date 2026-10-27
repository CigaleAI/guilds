import type { FastifyInstance } from "fastify";
import {
  changeSecret,
  createSecret,
  deleteOrgSecret,
  listOrgSecrets,
  replaceSecretAccess,
  requireMemberSecret,
  viewHeldSecret,
  type SecretServices,
} from "../secrets/service.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentOrg, currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, param, queryOf } from "./request.js";

/** An organisation's secrets: listed, created, changed, granted, and deleted by its members. */
export async function registerSecretRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const services: SecretServices = {
    db,
    masterKey: deps.masterKey,
    generation: deps.generation ?? null,
  };

  app.get("/api/secrets", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const query = queryOf(request);
    const scope = { guildId: query.guild_id || null, agentId: query.agent_id || null };
    return listOrgSecrets(db, String(org.id), String(user.id), scope);
  });

  app.post("/api/secrets", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const org = await currentOrg(identityDb, request, user);
    const missing = missingBodyFields(request.body, ["name", "description", "value"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const draft = {
      name: body.name,
      description: body.description,
      value: body.value,
      access: body,
    };
    return reply
      .code(201)
      .send(await createSecret(services, String(org.id), String(user.id), draft));
  });

  app.get("/api/secrets/:secret_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    return viewHeldSecret(
      await requireMemberSecret(db, param(request, "secret_id"), String(user.id)),
    );
  });

  app.patch("/api/secrets/:secret_id", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const held = await requireMemberSecret(db, param(request, "secret_id"), String(user.id));
    const body = bodyOf(request);
    return changeSecret(services, held, {
      name: body.name,
      description: body.description,
      value: body.value,
    });
  });

  app.put("/api/secrets/:secret_id/access", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const held = await requireMemberSecret(db, param(request, "secret_id"), String(user.id));
    const missing = missingBodyFields(request.body, ["org_wide"]);
    if (missing) {
      throw missing;
    }
    return replaceSecretAccess(services, held, bodyOf(request));
  });

  app.delete("/api/secrets/:secret_id", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const held = await requireMemberSecret(db, param(request, "secret_id"), String(user.id));
    await deleteOrgSecret(services, held);
    return reply.code(204).send();
  });
}
