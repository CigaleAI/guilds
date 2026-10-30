import { Type } from "@sinclair/typebox";
import { removeBinding, setBinding } from "../access/operator.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";

/** A binding as a request names it: what it binds, and at which scope. */
const BindingKeyQuery = Type.Object({
  catalog_kind: Type.String(),
  catalog_id: Type.String(),
  scope: Type.String(),
  scope_id: Type.Optional(Type.String()),
});

/** A binding to set: its key, whether it is on, and the login a connector uses there. */
const BindingBody = Type.Object({
  catalog_kind: Type.String(),
  catalog_id: Type.String(),
  scope: Type.String(),
  scope_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  enabled: Type.Boolean(),
  connection_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** Bindings: a tool or connector turned on or off at a scope, with the login a connector uses there. */
export async function registerBindingRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.put("/api/bindings", { schema: { body: BindingBody } }, async (request) => {
    const user = await currentUser(db, request, deps);
    const body = request.body;
    return setBinding(db, user, {
      catalogKind: body.catalog_kind,
      catalogId: body.catalog_id,
      scope: body.scope,
      scopeId: body.scope_id ?? null,
      enabled: body.enabled,
      ...(body.connection_id !== undefined ? { connectionId: body.connection_id } : {}),
    });
  });

  app.delete("/api/bindings", { schema: { querystring: BindingKeyQuery } }, async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const query = request.query;
    await removeBinding(db, user, {
      catalogKind: query.catalog_kind,
      catalogId: query.catalog_id,
      scope: query.scope,
      scopeId: query.scope_id ?? null,
    });
    return reply.code(204).send();
  });
}
