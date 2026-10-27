import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installedConnectors, removeInstalledConnector, replaceInstalledConnector } from "../connectors/index.js";
import { loadManifest, serverIdOf } from "../connectors/manifest.js";
import { ConnectorRegistry, type ConnectorEntry } from "../connectors/registry.js";
import { listMcpServers } from "../connectors/servers.js";
import type { Adapter } from "../connectors/types.js";
import { CONNECTOR_CODE, integrationValue, integrationValues } from "../instance/integrations.js";
import { writeLog } from "../observability/log.js";
import type { ConnectorPackage } from "./client.js";
import type { Queryable } from "../db/pg.js";

// Code connectors live under CONNECTORS_ROOT, one folder per version: `<root>/<slug>/<version>/`
// holding connector.json, adapter.js, and logo.svg. The row's version names the folder that serves.

const HOOKS = ["validate", "lookup", "list", "call", "state"] as const;

/** The version of each code connector this process serves, by slug. */
const served = new Map<string, string>();

/** Where code connectors live on disk: `CONNECTORS_ROOT`, whether or not the code tier is on. */
export function connectorsRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return integrationValue(CONNECTOR_CODE, "CONNECTORS_ROOT", { env }) || null;
}

/** The root code connectors install to and load from while the code tier is on (`CONNECTORS_CODE_TIER=1`); null while it is off. */
export function codeTierRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const values = integrationValues(CONNECTOR_CODE, { env });
  return values && values.CONNECTORS_CODE_TIER === "1" && values.CONNECTORS_ROOT ? values.CONNECTORS_ROOT : null;
}

export function codeFolder(root: string, slug: string, version: string): string {
  return path.join(root, slug, version);
}

/** Writes one version of a code package to its folder whole, replacing that version if it was there. */
export function writeCodePackage(root: string, slug: string, version: string, pkg: ConnectorPackage): void {
  const folder = codeFolder(root, slug, version);
  const staging = path.join(root, slug, `.${version}.installing`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, "connector.json"), `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  if (pkg.adapter) {
    writeFileSync(path.join(staging, "adapter.js"), pkg.adapter);
  }
  if (pkg.logo) {
    writeFileSync(path.join(staging, "logo.svg"), pkg.logo);
  }
  rmSync(folder, { recursive: true, force: true });
  renameSync(staging, folder);
}

/** Removes a connector's code folders: every version but `keep`, or all of them. */
export function removeCodePackage(root: string, slug: string, keep: string | null = null): void {
  const base = path.join(root, slug);
  if (keep === null) {
    rmSync(base, { recursive: true, force: true });
    return;
  }
  if (!existsSync(base)) {
    return;
  }
  for (const name of readdirSync(base)) {
    if (name !== keep) {
      rmSync(path.join(base, name), { recursive: true, force: true });
    }
  }
}

/** The adapter a bundled `adapter.js` exports by default, its hooks checked to be functions. */
async function importAdapter(file: string, version: string): Promise<Adapter> {
  // The version in the URL gives each version its own module; a new version never reuses an old one.
  const module = (await import(`${pathToFileURL(file).href}?v=${encodeURIComponent(version)}`)) as { default?: unknown };
  const adapter = module.default;
  if (!adapter || typeof adapter !== "object") {
    throw new Error("adapter.js has no default export object");
  }
  for (const hook of HOOKS) {
    const value = (adapter as Record<string, unknown>)[hook];
    if (value !== undefined && typeof value !== "function") {
      throw new Error(`adapter.js exports ${hook} that is not a function`);
    }
  }
  return adapter as Adapter;
}

/**
 * One version of a code connector as a registry entry: its manifest from the folder, its adapter
 * imported and checked against the manifest the way a core entry is. Throws when it does not load.
 */
export async function codeEntry(
  root: string,
  slug: string,
  version: string,
  row: { verified: boolean; publisher: string },
): Promise<ConnectorEntry> {
  const folder = codeFolder(root, slug, version);
  const manifest = loadManifest(JSON.parse(readFileSync(path.join(folder, "connector.json"), "utf8")), slug);
  const entry: ConnectorEntry = {
    id: serverIdOf(slug),
    manifest,
    adapter: await importAdapter(path.join(folder, "adapter.js"), version),
    source: "registry",
    verified: row.verified,
    publisher: row.publisher,
    folder,
  };
  new ConnectorRegistry([entry]);
  return entry;
}

export type CodeSync = { loaded: string[]; removed: string[]; failed: string[] };

/**
 * Brings the code connectors this process serves in line with the database, without a restart:
 * each registry row whose version folder holds `adapter.js` is loaded when this process serves
 * another version or none, and swapped in for the old one; a served connector whose row is gone or
 * has no code is taken out. Calls already running finish on the adapter they started with. A
 * version that does not load is logged and the one served before stays. While the code tier is
 * off, code on disk is a warning and is not loaded. Runs at boot and after each change.
 */
export async function syncCodeConnectors(db: Queryable, env: NodeJS.ProcessEnv = process.env): Promise<CodeSync> {
  const result: CodeSync = { loaded: [], removed: [], failed: [] };
  const root = connectorsRoot(env);
  const on = codeTierRoot(env) !== null;
  const rows = (await listMcpServers(db)).filter((row) => !row.owner_org_id && row.source === "registry");
  const wanted = new Set<string>();
  for (const row of root === null ? [] : rows) {
    const slug = String(row.slug);
    const version = String(row.version ?? "");
    if (!version || !existsSync(path.join(codeFolder(root!, slug, version), "adapter.js"))) {
      continue;
    }
    if (!on) {
      writeLog("warn", "code connector on disk while the code tier is off; not loaded", {
        operation: "connectors.code.load",
        path: codeFolder(root!, slug, version),
      });
      continue;
    }
    wanted.add(slug);
    if (served.get(slug) === version && installedConnectors().bySlug(slug)) {
      continue;
    }
    try {
      const entry = await codeEntry(root!, slug, version, {
        verified: row.verified === true,
        publisher: String(row.publisher ?? ""),
      });
      replaceInstalledConnector(entry);
      served.set(slug, version);
      result.loaded.push(slug);
    } catch (error) {
      result.failed.push(slug);
      writeLog(
        "error",
        "code connector did not load",
        {
          operation: "connectors.code.load",
          path: codeFolder(root!, slug, version),
          error_type: error instanceof Error ? error.name : "Error",
        },
        error,
      );
    }
  }
  for (const slug of [...served.keys()]) {
    if (!wanted.has(slug)) {
      removeInstalledConnector(slug);
      served.delete(slug);
      result.removed.push(slug);
    }
  }
  return result;
}
