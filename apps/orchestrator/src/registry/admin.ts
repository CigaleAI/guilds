import { refreshConnectorIntegrations, syncInstanceLogins } from "../connectors/instance.js";
import type { LoadedConnector } from "../connectors/servers.js";
import type { Queryable } from "../db/pg.js";
import type { InstanceKeys } from "../instance/keys.js";
import type { McpPool } from "../mcp/pool.js";
import { listPlatformServers, reloadServer } from "../mcp/servers.js";
import { onlineRegistry, type RegistryClient } from "./client.js";
import { codeTierRoot, connectorsRoot, syncCodeConnectors, type CodeSync } from "./code.js";
import { latestEntries, type RegistryConnectorEntry } from "./index.js";
import {
  installConnector,
  removeConnector,
  updateConnectors,
  type Acceptance,
  type ConnectorPick,
} from "./install.js";

/** What serving a connector change in this process reloads: the instance keys, the logins' key, and the pool. */
export type ConnectorServeServices = {
  instanceKeys?: InstanceKeys | undefined;
  masterKey?: Buffer | undefined;
  mcp?: McpPool | undefined;
};

/** The services the instance admin's registry changes run with: the box's registry client, null while offline. */
export type RegistryAdminServices = ConnectorServeServices & { registry: RegistryClient | null };

/** A connector the index offers: its newest entry, every version, and the box's row when it holds one. */
export type RegistryCatalogEntry = RegistryConnectorEntry & {
  versions: string[];
  installed: { source: string; version: string } | null;
};

/** What the registry offers beside what the box has; empty while the box is offline. */
export type RegistryCatalog = {
  offline: boolean;
  url: string | null;
  connectors: RegistryCatalogEntry[];
};

/** A connector's move to a newer version. */
export type ConnectorMove = { slug: string; from: string; to: string; code: boolean };

/** The newest entry of each connector the registry's index offers, with the box's row beside it. */
export async function registryCatalog(
  db: Queryable,
  services: RegistryAdminServices,
): Promise<RegistryCatalog> {
  const client = services.registry;
  if (client === null) {
    return { offline: true, url: null, connectors: [] };
  }
  const index = await client.index();
  const installed = new Map((await listPlatformServers(db)).map((row) => [row.slug, row]));
  return {
    offline: false,
    url: client.baseUrl,
    connectors: latestEntries(index.connectors, (entry) => entry.slug).map((entry) => {
      const row = installed.get(entry.slug);
      return {
        ...entry,
        installed: row ? { source: String(row.source), version: String(row.version ?? "") } : null,
      };
    }),
  };
}

/**
 * Serves what the database now says in this process, without a restart: code connectors are
 * loaded, swapped, or taken out, and every login lists its tools again on its next use.
 */
export async function serveInstalledConnectors(
  db: Queryable,
  services: ConnectorServeServices,
): Promise<CodeSync> {
  const sync = await syncCodeConnectors(db);
  await refreshConnectorIntegrations(db);
  await services.instanceKeys?.load();
  await syncInstanceLogins(db, services.masterKey);
  services.mcp?.forgetListings();
  return sync;
}

/**
 * Installs a registry connector, its code under the code tier's root when it carries any, serves
 * it in this process, and returns its row as every reader now sees it.
 */
export async function installRegistryConnector(
  db: Queryable,
  services: RegistryAdminServices,
  pick: ConnectorPick,
): Promise<LoadedConnector> {
  const { row } = await installConnector(db, onlineRegistry(services.registry), pick, codeTierRoot());
  await serveInstalledConnectors(db, services);
  return reloadServer(db, row);
}

/** Moves one registry connector to the newest version the index offers, serves it, and returns what moved. */
export async function updateRegistryConnector(
  db: Queryable,
  services: RegistryAdminServices,
  slug: string,
  accept: Acceptance,
): Promise<ConnectorMove[]> {
  const moved = await updateConnectors(
    db,
    onlineRegistry(services.registry),
    { ...accept, slug },
    { codeTier: codeTierRoot(), connectors: connectorsRoot() },
  );
  await serveInstalledConnectors(db, services);
  return moved;
}

/** Removes a registry connector with its code on disk, and takes it out of this process. */
export async function removeRegistryConnector(
  db: Queryable,
  services: ConnectorServeServices,
  slug: string,
): Promise<void> {
  await removeConnector(db, slug, connectorsRoot());
  await serveInstalledConnectors(db, services);
}
