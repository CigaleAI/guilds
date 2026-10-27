import type { LoadedConnector } from "../connectors/load.js";
import {
  countOrgConnectors,
  deleteConnector,
  getMcpServer,
  listMcpServers,
} from "../db/connectors.js";
import { isUniqueViolation, type Queryable } from "../db/pg.js";
import { refreshConnectorIntegrations } from "../instance/connectors.js";
import { LimitError, type OrgPolicy } from "../policy/index.js";
import { CatalogError, createConnector, patchConnector } from "./catalog.js";

type Item = Record<string, unknown>;

/** The 409 for a connector whose slug or tool prefix another one holds; any other error as it is. */
function nameConflict(error: unknown): unknown {
  return isUniqueViolation(error)
    ? new CatalogError("slug or tool prefix already exists", 409)
    : error;
}

/** The connectors the platform offers every organisation. */
export async function listPlatformServers(db: Queryable): Promise<LoadedConnector[]> {
  return (await listMcpServers(db)).filter((server) => !server.owner_org_id);
}

/** A connector the platform offers; an organisation's own, or none, is a 404. */
export async function requirePlatformServer(
  db: Queryable,
  serverId: string,
): Promise<LoadedConnector> {
  const server = await getMcpServer(db, serverId);
  if (!server || server.owner_org_id) {
    throw new CatalogError("mcp server not found", 404);
  }
  return server;
}

/** Adds a connector to the platform's catalog, and the integrations it brings. */
export async function createPlatformServer(db: Queryable, body: Item): Promise<Item> {
  try {
    const row = await createConnector(db, body);
    await refreshConnectorIntegrations(db);
    return row;
  } catch (error) {
    throw nameConflict(error);
  }
}

/** Changes a platform connector, and the integrations it brings. */
export async function patchPlatformServer(
  db: Queryable,
  server: LoadedConnector,
  body: Item,
): Promise<Item> {
  try {
    const patched = await patchConnector(db, server, body);
    await refreshConnectorIntegrations(db);
    return patched;
  } catch (error) {
    throw nameConflict(error);
  }
}

/** A connector row as every reader sees it, once it is installed: the stored row when it does not load. */
export async function reloadServer(db: Queryable, row: Item): Promise<Item> {
  return (await getMcpServer(db, String(row.id))) ?? row;
}

/** The organisation's own connectors. */
export async function listOrgOwnServers(db: Queryable, orgId: string): Promise<LoadedConnector[]> {
  return (await listMcpServers(db, orgId)).filter((server) => server.owner_org_id === orgId);
}

/** One of the organisation's own connectors; the platform's, another organisation's, or none is a 404. */
export async function requireOrgServer(
  db: Queryable,
  orgId: string,
  serverId: string,
): Promise<LoadedConnector> {
  const server = await getMcpServer(db, serverId);
  if (server === null || server.owner_org_id !== orgId) {
    throw new CatalogError("mcp server not found", 404);
  }
  return server;
}

/** Adds a connector of the organisation's own, within its policy's cap on them. */
export async function createOrgServer(
  db: Queryable,
  policy: OrgPolicy,
  orgId: string,
  body: Item,
): Promise<Item> {
  const { limits } = await policy.standing(orgId);
  if (
    limits.maxMcpServers !== null &&
    (await countOrgConnectors(db, orgId)) >= limits.maxMcpServers
  ) {
    throw new LimitError(limits.source, "MCP servers");
  }
  try {
    return await createConnector(db, body, new Date(), orgId);
  } catch (error) {
    throw nameConflict(error);
  }
}

export async function patchOrgServer(
  db: Queryable,
  server: LoadedConnector,
  body: Item,
): Promise<Item> {
  try {
    return await patchConnector(db, server, body);
  } catch (error) {
    throw nameConflict(error);
  }
}

export async function deleteOrgServer(db: Queryable, server: LoadedConnector): Promise<void> {
  await deleteConnector(db, server.id);
}
