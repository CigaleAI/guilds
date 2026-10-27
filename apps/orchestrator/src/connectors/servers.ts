import {
  getConnector,
  getConnectorBySlug,
  listOrgConnectors,
  setConnectorOauthClient,
} from "../db/connectors.js";
import type { Queryable } from "../db/pg.js";
import { loadConnector, type LoadedConnector } from "./load.js";

/**
 * The connectors an organisation sees, loaded with their overrides, by slug: the platform's,
 * and with `orgId` that organisation's own. Without one, the platform's alone.
 */
export async function listMcpServers(db: Queryable, orgId: string | null = null): Promise<LoadedConnector[]> {
  return (await listOrgConnectors(db, orgId)).map((row) => loadConnector(row));
}

export async function getMcpServer(db: Queryable, serverId: string): Promise<LoadedConnector | null> {
  const row = await getConnector(db, serverId);
  return row === null ? null : loadConnector(row);
}

/** The connector an organisation sees under a slug: the platform's, or with `orgId` its own. */
export async function getMcpServerBySlug(
  db: Queryable,
  slug: string,
  orgId: string | null = null,
): Promise<LoadedConnector | null> {
  const row = await getConnectorBySlug(db, slug, orgId);
  return row === null ? null : loadConnector(row);
}

/** Stores the OAuth client a server's `config.oauth_client` carries: the one registered with its authorization server. */
export async function updateMcpServerConfig(
  db: Queryable,
  serverId: string,
  config: unknown,
  now: Date,
): Promise<LoadedConnector | null> {
  const row = await setConnectorOauthClient(db, serverId, config, now);
  return row === null ? null : loadConnector(row);
}
