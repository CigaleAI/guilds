import type { FastifyInstance } from "fastify";
import { catalogServerItem } from "../mcp/catalog.js";
import { registryClient, type RegistryClient } from "../registry/client.js";
import { compareVersions, RegistryError } from "../registry/index.js";
import { codeTierRoot, connectorsRoot, syncCodeConnectors, type CodeSync } from "../registry/code.js";
import { installConnector, removeConnector, updateConnectors } from "../registry/install.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { refreshConnectorIntegrations, syncInstanceLogins } from "../connectors/instance.js";
import { requireInstanceAdmin } from "./instance-admin.js";
import { bodyOf, param } from "./request.js";
import { listPlatformServers, reloadServer } from "../mcp/servers.js";

/** The box's registry client: the one the deps carry, else `REGISTRY_URL`'s; null while offline. */
export function registryOf(deps: AppDeps): RegistryClient | null {
  return deps.registry === undefined ? registryClient() : deps.registry;
}

export function registryHttp(error: unknown): never {
  if (error instanceof RegistryError) {
    throw new HttpError(error.status, error.message);
  }
  throw error;
}

/** Each name's newest entry, with every version the index offers for it. */
export function latestEntries<E extends { version: string }>(
  entries: readonly E[],
  nameOf: (entry: E) => string,
): Array<E & { versions: string[] }> {
  const byName = new Map<string, E[]>();
  for (const entry of entries) {
    byName.set(nameOf(entry), [...(byName.get(nameOf(entry)) ?? []), entry]);
  }
  return [...byName.values()]
    .map((versions) => {
      const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
      return { ...sorted[0]!, versions: sorted.map((entry) => entry.version) };
    })
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

/**
 * The instance admin's view of the registry: what its index offers beside what the box has, and
 * installing, updating, and removing a registry connector.
 */
export async function registerAdminRegistryRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  /**
   * Serves what the database now says in this process, without a restart: code connectors are
   * loaded, swapped, or taken out, and every login lists its tools again on its next use.
   */
  async function applyChange(): Promise<CodeSync> {
    const sync = await syncCodeConnectors(db);
    await refreshConnectorIntegrations(db);
    await deps.instanceKeys?.load();
    await syncInstanceLogins(db, deps.masterKey);
    deps.mcp?.forgetListings();
    return sync;
  }

  function onlineClient(): RegistryClient {
    const client = registryOf(deps);
    if (client === null) {
      throw new HttpError(409, "the box is offline: REGISTRY_URL is set empty");
    }
    return client;
  }

  app.get("/api/admin/registry", async (request) => {
    await requireInstanceAdmin(deps, request);
    const client = registryOf(deps);
    if (client === null) {
      return { offline: true, url: null, connectors: [] };
    }
    try {
      const index = await client.index();
      const installed = new Map(
        (await listPlatformServers(db)).map((row) => [row.slug, row]),
      );
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
    } catch (error) {
      registryHttp(error);
    }
  });

  app.post("/api/admin/registry/connectors", async (request, reply) => {
    await requireInstanceAdmin(deps, request);
    const body = bodyOf(request);
    try {
      const { row } = await installConnector(db, onlineClient(), typeof body.slug === "string" ? body.slug : "", {
        ...(typeof body.version === "string" && body.version ? { version: body.version } : {}),
        unverified: body.unverified === true,
        experimental: body.experimental === true,
        codeRoot: codeTierRoot(),
      });
      await applyChange();
      reply.code(201);
      return catalogServerItem(await reloadServer(db, row));
    } catch (error) {
      registryHttp(error);
    }
  });

  app.post("/api/admin/registry/connectors/:slug/update", async (request) => {
    await requireInstanceAdmin(deps, request);
    try {
      const body = bodyOf(request);
      const moved = await updateConnectors(db, onlineClient(), {
        slug: param(request, "slug"),
        unverified: body.unverified === true,
        experimental: body.experimental === true,
        codeRoot: codeTierRoot(),
        connectorsRoot: connectorsRoot(),
      });
      await applyChange();
      return { moved };
    } catch (error) {
      registryHttp(error);
    }
  });

  app.delete("/api/admin/registry/connectors/:slug", async (request, reply) => {
    await requireInstanceAdmin(deps, request);
    try {
      await removeConnector(db, param(request, "slug"), connectorsRoot());
    } catch (error) {
      registryHttp(error);
    }
    await applyChange();
    return reply.code(204).send();
  });

  /** Serves what the database and `CONNECTORS_ROOT` hold now: after a CLI install, update, or remove. */
  app.post("/api/admin/registry/reload", async (request) => {
    await requireInstanceAdmin(deps, request);
    return applyChange();
  });
}
