import { Type } from "@sinclair/typebox";
import { catalogServerItem } from "../mcp/catalog.js";
import { registryClient, type RegistryClient } from "../registry/client.js";
import { compareVersions } from "../registry/index.js";
import {
  installRegistryConnector,
  registryCatalog,
  removeRegistryConnector,
  serveInstalledConnectors,
  updateRegistryConnector,
  type ConnectorServeServices,
  type RegistryAdminServices,
} from "../registry/admin.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { instanceAdminOnly } from "./instance-admin.js";

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
  const serving = (): ConnectorServeServices => ({
    instanceKeys: deps.instanceKeys,
    masterKey: deps.masterKey,
    mcp: deps.mcp,
  });
  /** The box's `REGISTRY_URL` is read on each request that reaches the registry. */
  const services = (): RegistryAdminServices => ({ ...serving(), registry: registryOf(deps) });

  app.get("/api/admin/registry", { preValidation }, async () => registryCatalog(db, services()));

  app.post(
    "/api/admin/registry/connectors",
    { preValidation, schema: { body: RegistryInstallSchema } },
    async (request, reply) => {
      const row = await installRegistryConnector(db, services(), request.body);
      reply.code(201);
      return catalogServerItem(row);
    },
  );

  app.post(
    "/api/admin/registry/connectors/:slug/update",
    { preValidation, schema: { params: RegistrySlugParams, body: RegistryUpdateSchema } },
    async (request) => ({
      moved: await updateRegistryConnector(db, services(), request.params.slug, request.body),
    }),
  );

  app.delete(
    "/api/admin/registry/connectors/:slug",
    { preValidation, schema: { params: RegistrySlugParams } },
    async (request, reply) => {
      await removeRegistryConnector(db, serving(), request.params.slug);
      return reply.code(204).send();
    },
  );

  /** Serves what the database and `CONNECTORS_ROOT` hold now: after a CLI install, update, or remove. */
  app.post("/api/admin/registry/reload", { preValidation }, async () =>
    serveInstalledConnectors(db, serving()),
  );
}
