import { Type } from "@sinclair/typebox";
import { catalogServerItem } from "../mcp/catalog.js";
import { registryClient, type RegistryClient } from "../registry/client.js";
import { compareVersions } from "../registry/index.js";
import { codeTierRoot, connectorsRoot, syncCodeConnectors, type CodeSync } from "../registry/code.js";
import { installConnector, removeConnector, updateConnectors } from "../registry/install.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { refreshConnectorIntegrations, syncInstanceLogins } from "../connectors/instance.js";
import { instanceAdminOnly } from "./instance-admin.js";
import { listPlatformServers, reloadServer } from "../mcp/servers.js";

/** What an install or an update accepts: an unverified connector, an experimental one. */
const RegistryAcceptanceFields = {
  unverified: Type.Optional(Type.Boolean()),
  experimental: Type.Optional(Type.Boolean()),
};

/** A registry connector to install: its slug, a version (the newest when left out), and what it accepts. */
const RegistryInstallSchema = Type.Object({
  slug: Type.String(),
  version: Type.Optional(Type.String()),
  ...RegistryAcceptanceFields,
});

/** What moving a registry connector to its newest version accepts. */
const RegistryUpdateSchema = Type.Object(RegistryAcceptanceFields);

/** The path of one registry connector. */
const RegistrySlugParams = Type.Object({ slug: Type.String() });

/** The box's registry client: the one the deps carry, else `REGISTRY_URL`'s; null while offline. */
export function registryOf(deps: AppDeps): RegistryClient | null {
  return deps.registry === undefined ? registryClient() : deps.registry;
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
export async function registerAdminRegistryRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const preValidation = instanceAdminOnly(deps);

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

  app.get("/api/admin/registry", { preValidation }, async () => {
    const client = registryOf(deps);
    if (client === null) {
      return { offline: true, url: null, connectors: [] };
    }
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
  });

  app.post(
    "/api/admin/registry/connectors",
    { preValidation, schema: { body: RegistryInstallSchema } },
    async (request, reply) => {
      const body = request.body;
      const { row } = await installConnector(db, onlineClient(), body.slug, {
        ...(body.version ? { version: body.version } : {}),
        unverified: body.unverified === true,
        experimental: body.experimental === true,
        codeRoot: codeTierRoot(),
      });
      await applyChange();
      reply.code(201);
      return catalogServerItem(await reloadServer(db, row));
    },
  );

  app.post(
    "/api/admin/registry/connectors/:slug/update",
    { preValidation, schema: { params: RegistrySlugParams, body: RegistryUpdateSchema } },
    async (request) => {
      const moved = await updateConnectors(db, onlineClient(), {
        slug: request.params.slug,
        unverified: request.body.unverified === true,
        experimental: request.body.experimental === true,
        codeRoot: codeTierRoot(),
        connectorsRoot: connectorsRoot(),
      });
      await applyChange();
      return { moved };
    },
  );

  app.delete(
    "/api/admin/registry/connectors/:slug",
    { preValidation, schema: { params: RegistrySlugParams } },
    async (request, reply) => {
      await removeConnector(db, request.params.slug, connectorsRoot());
      await applyChange();
      return reply.code(204).send();
    },
  );

  /** Serves what the database and `CONNECTORS_ROOT` hold now: after a CLI install, update, or remove. */
  app.post("/api/admin/registry/reload", { preValidation }, async () => applyChange());
}
