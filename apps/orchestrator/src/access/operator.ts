import { requireVisibleAgent } from "../agents/access.js";
import { getMcpServer } from "../connectors/servers.js";
import { bindingItem } from "../mcp/view.js";
import { getAgent } from "../db/agents.js";
import { getBinding, upsertPlatformBinding, type BindingKey } from "../db/bindings.js";
import { getGuild } from "../db/guilds.js";
import { getMcpConnection, isListedMcpTool } from "../db/mcp.js";
import { getMembership } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import { requireVisibleGuild } from "../guilds/access.js";
import { userActor } from "../lib/change-actor.js";
import { newId } from "../lib/ids.js";
import { serverVisible } from "../mcp/visibility.js";
import { resetBinding, writeBinding } from "./bindings.js";
import {
  BindingError,
  validateBinding,
  validateCatalog,
  validateScope,
  type BoundConnector,
} from "./index.js";
import type { UserRow } from "../db/users.js";

/** A binding as an operator asks for it, before validation; `connectionId` absent keeps the stored login. */
export type BindingRequest = {
  catalogKind: string;
  catalogId: string;
  scope: string;
  scopeId: string | null;
  enabled: boolean;
  connectionId?: string | null;
};

/**
 * Refuses a scope the user may not change: the platform, an organisation they are not in, or a
 * guild or agent they do not see. Answers the guild the scope sits in; null for an organisation.
 */
async function assertChangesScope(
  db: Queryable,
  scope: string,
  scopeId: string | null,
  userId: string,
): Promise<string | null> {
  if (scope === "platform") {
    throw new BindingError("platform bindings cannot be changed here", 400);
  }
  if (scope === "org") {
    if ((await getMembership(db, scopeId || "", userId)) === null) {
      throw new BindingError("organisation not found", 404);
    }
    return null;
  }
  if (scope === "guild") {
    return (await requireVisibleGuild(db, scopeId || "", userId)).id;
  }
  return (await requireVisibleAgent(db, scopeId || "", userId)).guild_id;
}

/** The organisation a scope belongs to; null for the platform or a scope that no longer exists. */
async function scopeOrgId(
  db: Queryable,
  scope: string,
  scopeId: string | null,
): Promise<string | null> {
  if (scope === "org") {
    return scopeId;
  }
  if (scope === "guild") {
    return (await getGuild(db, scopeId || ""))?.org_id ?? null;
  }
  if (scope === "agent") {
    return (await getAgent(db, scopeId || ""))?.org_id ?? null;
  }
  return null;
}

/** The connector and login a binding of a connector names; both refused when the organisation does not see them. */
async function loadBoundConnector(
  db: Queryable,
  key: BindingKey,
  orgId: string | null,
  connectionId: string | null,
): Promise<BoundConnector> {
  if (key.catalogKind === "mcp_tool" && !(await isListedMcpTool(db, key.catalogId, orgId))) {
    throw new BindingError("mcp tool not found", 404);
  }
  if (key.catalogKind !== "mcp") {
    return { server: null, connection: null };
  }
  const server = await getMcpServer(db, key.catalogId);
  if (server === null || !serverVisible(server, orgId)) {
    throw new BindingError("mcp server not found", 404);
  }
  const connection = connectionId === null ? null : await getMcpConnection(db, connectionId);
  if (connectionId !== null && connection === null) {
    throw new BindingError("connection not found", 404);
  }
  return { server, connection };
}

/**
 * Turns a tool or connector on or off at a scope the user may change, with the login a connector
 * uses there. A connector's binding keeps its stored login unless the request names one.
 */
export async function setBinding(
  db: Queryable,
  user: UserRow,
  request: BindingRequest,
): Promise<Record<string, unknown>> {
  const [catalogKind, catalogId] = validateCatalog(request.catalogKind, request.catalogId);
  const [scope, scopeId] = validateScope(request.scope, request.scopeId);
  const key = { catalogKind, catalogId, scope, scopeId };
  const guildId = await assertChangesScope(db, scope, scopeId, user.id);
  const orgId = await scopeOrgId(db, scope, scopeId);
  const replacesConnection = request.connectionId !== undefined;
  const connectionId = request.connectionId ?? null;
  const connector = await loadBoundConnector(db, key, orgId, connectionId);
  const overlay = validateBinding(
    key,
    { enabled: request.enabled, connectionId },
    { orgId, guildId },
    connector,
  );
  const existing = catalogKind === "mcp" && !replacesConnection ? await getBinding(db, key) : null;
  const binding = {
    bindingId: newId("bind"),
    catalogKind: overlay.catalog_kind,
    catalogId: overlay.catalog_id,
    enabled: overlay.enabled,
    connectionId: existing === null ? overlay.connection_id : (existing.connection_id ?? null),
  };
  const now = new Date();
  const row =
    scope === "platform"
      ? await upsertPlatformBinding(db, binding, now)
      : await writeBinding(
          db,
          { ...binding, scope: overlay.scope, scopeId: overlay.scope_id },
          now,
          userActor(user),
        );
  return bindingItem(row);
}

/** Removes a binding at a scope the user may change. */
export async function removeBinding(
  db: Queryable,
  user: UserRow,
  request: BindingKey,
): Promise<void> {
  const [catalogKind, catalogId] = validateCatalog(request.catalogKind, request.catalogId);
  const [scope, scopeId] = validateScope(request.scope, request.scopeId);
  await assertChangesScope(db, scope, scopeId, user.id);
  if (
    (await resetBinding(db, { catalogKind, catalogId, scope, scopeId }, userActor(user))) === null
  ) {
    throw new BindingError("binding not found", 404);
  }
}
