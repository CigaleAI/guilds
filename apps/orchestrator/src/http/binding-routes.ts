import type { FastifyInstance } from "fastify";
import { removeBinding, setBinding, type BindingRequest } from "../access/operator.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentUser } from "./identity.js";
import { identityDatabase } from "../users/identity.js";
import { bodyOf, queryOf } from "./request.js";

/** Bindings: a tool or connector turned on or off at a scope, with the login a connector uses there. */
export async function registerBindingRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);

  app.put("/api/bindings", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const missing = missingBodyFields(request.body, [
      "catalog_kind",
      "catalog_id",
      "scope",
      "enabled",
    ]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const optionalId = (value: unknown) =>
      value === undefined || value === null ? null : String(value);
    const binding: BindingRequest = {
      catalogKind: String(body.catalog_kind ?? ""),
      catalogId: String(body.catalog_id ?? ""),
      scope: String(body.scope ?? ""),
      scopeId: optionalId(body.scope_id),
      enabled: Boolean(body.enabled),
      ...("connection_id" in body ? { connectionId: optionalId(body.connection_id) } : {}),
    };
    return setBinding(db, user, binding);
  });

  app.delete("/api/bindings", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const query = queryOf(request);
    const key = {
      catalogKind: query.catalog_kind ?? "",
      catalogId: query.catalog_id ?? "",
      scope: query.scope ?? "",
      scopeId: query.scope_id ?? null,
    };
    await removeBinding(db, user, key);
    return reply.code(204).send();
  });
}
