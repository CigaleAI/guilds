import { rmSync } from "node:fs";
import type { Repositories } from "../db/repositories.js";
import { serverIdOf } from "../connectors/manifest.js";
import { assertSlugFree, CatalogError } from "../mcp/catalog.js";
import { generateToolPrefix, isReservedToolPrefix } from "../mcp/policy.js";
import type { ConnectorPackage, RegistryClient } from "./client.js";
import { codeEntry, codeFolder, removeCodePackage, writeCodePackage } from "./code.js";
import { compareVersions, pickEntry, RegistryError, type RegistryConnectorEntry, type RegistryIndex } from "./index.js";

/** A connector the box installed from a registry, beside the newest version its index offers. */
export type InstalledConnector = {
  slug: string;
  display_name: string;
  source: string;
  version: string;
  verified: boolean;
  experimental: boolean;
  enabled: boolean;
  latest: string | null;
};

function entriesFor(index: RegistryIndex, slug: string): RegistryConnectorEntry[] {
  return index.connectors.filter((entry) => entry.slug === slug);
}

/** What an install accepts beyond a verified, stable entry. */
type Acceptance = { unverified?: boolean; experimental?: boolean };

function chosenEntry(index: RegistryIndex, slug: string, version: string | undefined, accept: Acceptance): RegistryConnectorEntry {
  const entry = pickEntry(entriesFor(index, slug), version);
  if (entry === null) {
    throw new RegistryError(version ? `the registry has no ${slug}@${version}` : `the registry has no connector ${slug}`, 404);
  }
  if (!entry.verified && accept.unverified !== true) {
    throw new RegistryError(`${slug}@${entry.version} is unverified; install it with --unverified to accept that`, 409);
  }
  if (entry.experimental && accept.experimental !== true) {
    throw new RegistryError(`${slug}@${entry.version} is experimental; install it with --experimental to accept that`, 409);
  }
  return entry;
}

/**
 * Places a package that carries code: only into the code tier's root, only from an index the box's
 * key verified, and only when the index marks it verified. It is written to its version's folder
 * and imported once, so a package that does not load is refused before any row changes. A package
 * without code needs none of this and writes nothing.
 */
async function placeCode(
  client: RegistryClient,
  entry: RegistryConnectorEntry,
  pkg: ConnectorPackage,
  codeRoot: string | null | undefined,
): Promise<boolean> {
  if (pkg.adapter === null) {
    return false;
  }
  const slug = entry.slug;
  if (!codeRoot) {
    throw new RegistryError(`${slug} carries adapter code, which this box installs only with CONNECTORS_CODE_TIER=1`, 409);
  }
  if (!client.verifiesSignatures) {
    throw new RegistryError(`${slug} carries adapter code, which this box installs only from an index REGISTRY_PUBLIC_KEY verifies`, 409);
  }
  if (!entry.verified) {
    throw new RegistryError(`${slug}@${entry.version} carries adapter code and is unverified; code installs only when verified`, 409);
  }
  writeCodePackage(codeRoot, slug, entry.version, pkg);
  try {
    await codeEntry(codeRoot, slug, entry.version, { verified: entry.verified, publisher: entry.publisher });
  } catch (error) {
    rmSync(codeFolder(codeRoot, slug, entry.version), { recursive: true, force: true });
    throw new RegistryError(`${slug}@${entry.version} does not load: ${error instanceof Error ? error.message : String(error)}`, 422);
  }
  return true;
}

export type InstallOptions = Acceptance & {
  version?: string;
  now?: Date;
  /** The code tier's root while it is on: a package carrying code installs there. */
  codeRoot?: string | null;
};

/**
 * Installs a connector from the registry as a platform row: `registry` source, on at install,
 * its tool prefix generated against every prefix on the box. A slug any server holds is refused.
 * A package carrying code is written under the code tier's root; `code` says so, and the process
 * serves it once `syncCodeConnectors` runs.
 */
export async function installConnector(
  repo: Repositories,
  client: RegistryClient,
  slug: string,
  options: InstallOptions = {},
): Promise<{ row: Record<string, unknown>; code: boolean }> {
  const entry = chosenEntry(await client.index(), slug, options.version, options);
  try {
    await assertSlugFree(repo, slug, null);
  } catch (error) {
    if (error instanceof CatalogError) {
      throw new RegistryError(error.message, error.status);
    }
    throw error;
  }
  const pkg = await client.connectorPackage(entry);
  const toolPrefix = generateToolPrefix(slug, await repo.listTakenToolPrefixes());
  if (isReservedToolPrefix(toolPrefix)) {
    throw new RegistryError(`the tool prefix for ${slug} is reserved`);
  }
  const code = await placeCode(client, entry, pkg, options.codeRoot);
  try {
    const row = await repo.insertConnector(
      {
        id: serverIdOf(slug),
        slug,
        toolPrefix,
        ownerOrgId: null,
        manifest: pkg.manifest,
        source: "registry",
        version: entry.version,
        verified: entry.verified,
        experimental: entry.experimental === true,
        publisher: entry.publisher,
        enabled: true,
      },
      options.now ?? new Date(),
    );
    return { row, code };
  } catch (error) {
    if (code && options.codeRoot) {
      removeCodePackage(options.codeRoot, slug);
    }
    throw error;
  }
}

async function registryRow(repo: Repositories, slug: string): Promise<Record<string, unknown>> {
  const row = await repo.getMcpServerBySlug(slug, null);
  if (row === null || row.owner_org_id) {
    throw new RegistryError(`connector ${slug} is not installed`, 404);
  }
  if (row.source !== "registry") {
    throw new RegistryError(`connector ${slug} is ${String(row.source)}, not a registry install`, 409);
  }
  return row;
}

/**
 * Moves registry connectors to the newest version the index offers, or `slug` alone. The row keeps
 * its switch, its OAuth client, the admin's overrides, its logins, and its bindings; its tools are
 * listed again on each login's next use. A connector with code keeps only the new version's folder,
 * served once `syncCodeConnectors` runs. Returns what moved.
 */
export async function updateConnectors(
  repo: Repositories,
  client: RegistryClient,
  options: Acceptance & { slug?: string; now?: Date; codeRoot?: string | null; connectorsRoot?: string | null } = {},
): Promise<Array<{ slug: string; from: string; to: string; code: boolean }>> {
  const index = await client.index();
  const rows = options.slug
    ? [await registryRow(repo, options.slug)]
    : (await repo.listMcpServers()).filter((row) => !row.owner_org_id && row.source === "registry");
  const moved: Array<{ slug: string; from: string; to: string; code: boolean }> = [];
  for (const row of rows) {
    const slug = String(row.slug);
    const latest = pickEntry(entriesFor(index, slug));
    const current = String(row.version ?? "");
    if (latest === null || (current && compareVersions(latest.version, current) <= 0)) {
      continue;
    }
    const entry = chosenEntry(index, slug, latest.version, options);
    const pkg = await client.connectorPackage(entry);
    const code = await placeCode(client, entry, pkg, options.codeRoot);
    await repo.updateConnector(
      String(row.id),
      {
        manifest: pkg.manifest,
        version: entry.version,
        verified: entry.verified,
        experimental: entry.experimental === true,
        publisher: entry.publisher,
      },
      options.now ?? new Date(),
    );
    await repo.expireMcpTools(String(row.id));
    if (options.connectorsRoot) {
      removeCodePackage(options.connectorsRoot, slug, code ? entry.version : null);
    }
    moved.push({ slug, from: current, to: entry.version, code });
  }
  return moved;
}

/** Removes a registry connector with its logins, the bindings that name it, and its code on disk. */
export async function removeConnector(repo: Repositories, slug: string, connectorsRoot: string | null = null): Promise<void> {
  const row = await registryRow(repo, slug);
  await repo.deleteConnector(String(row.id));
  if (connectorsRoot) {
    removeCodePackage(connectorsRoot, slug);
  }
}

/** The box's platform connectors, each with the newest version the index offers when one is given. */
export async function listConnectors(repo: Repositories, index: RegistryIndex | null): Promise<InstalledConnector[]> {
  const rows = (await repo.listMcpServers()).filter((row) => !row.owner_org_id);
  return rows
    .map((row) => {
      const slug = String(row.slug);
      const latest = index ? pickEntry(entriesFor(index, slug)) : null;
      return {
        slug,
        display_name: String(row.display_name ?? slug),
        source: String(row.source),
        version: String(row.version ?? ""),
        verified: row.verified === true,
        experimental: row.experimental === true,
        enabled: row.enabled !== false,
        latest: row.source === "registry" && latest ? latest.version : null,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
