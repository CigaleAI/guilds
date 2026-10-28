import type { Manifest } from "../db/schema/index.js";
import { loadManifest, serverIdOf } from "./manifest.js";
import type { Adapter } from "./types.js";
import type { LoadedConnector } from "./servers.js";

/** Where an installed connector came from: shipped with core, pulled from a registry, or added on this box. */
export type ConnectorSource = "core" | "registry" | "local";

/** One installed connector: its manifest, the code beside it, and where it came from. */
export type ConnectorEntry = {
  /** `mcp_` and the slug. */
  id: string;
  manifest: Manifest;
  /** Empty for a connector with no code. */
  adapter: Adapter;
  source: ConnectorSource;
  verified: boolean;
  publisher: string;
  /** The folder holding `connector.json`, and `logo.svg` when there is one. */
  folder: string | null;
};

export class ConnectorRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorRegistryError";
  }
}

/**
 * An entry for a connector folder shipped in the image, by core or by an extension: its
 * `connector.json`, checked against the folder name, and its adapter.
 */
export function folderEntry(
  raw: unknown,
  adapter: Adapter,
  folder: string,
  options: { publisher?: string } = {},
): ConnectorEntry {
  const name = folder.replace(/\/+$/, "").split("/").pop() ?? "";
  const manifest = loadManifest(raw, name);
  return {
    id: serverIdOf(manifest.slug),
    manifest,
    adapter,
    source: "core",
    verified: true,
    publisher: options.publisher ?? "guilds",
    folder,
  };
}

/** Whether the entry offers tools: an adapter `list`, or tools in its manifest. */
function listsTools(entry: ConnectorEntry): boolean {
  return Boolean(entry.adapter.list) || Boolean(entry.manifest.tools?.length);
}

function checkEntry(entry: ConnectorEntry): void {
  const { manifest, adapter } = entry;
  if (!manifest.endpoint && listsTools(entry) && !adapter.call) {
    throw new ConnectorRegistryError(`connector ${manifest.slug} lists tools with no endpoint and no call`);
  }
  if (manifest.state && !adapter.state) {
    throw new ConnectorRegistryError(`connector ${manifest.slug} declares state with no state hook`);
  }
  if (!manifest.state && adapter.state) {
    throw new ConnectorRegistryError(`connector ${manifest.slug} has a state hook with no state in its manifest`);
  }
}

/** The installed connectors, by slug and by server id. */
export class ConnectorRegistry {
  private bySlugMap = new Map<string, ConnectorEntry>();
  private byIdMap = new Map<string, ConnectorEntry>();

  constructor(entries: readonly ConnectorEntry[]) {
    for (const entry of entries) {
      checkEntry(entry);
      if (this.bySlugMap.has(entry.manifest.slug)) {
        throw new ConnectorRegistryError(`connector ${entry.manifest.slug} is registered twice`);
      }
      this.bySlugMap.set(entry.manifest.slug, entry);
      this.byIdMap.set(entry.id, entry);
    }
  }

  entries(): ConnectorEntry[] {
    return [...this.bySlugMap.values()];
  }

  bySlug(slug: string): ConnectorEntry | null {
    return this.bySlugMap.get(slug) ?? null;
  }

  byId(id: string): ConnectorEntry | null {
    return this.byIdMap.get(id) ?? null;
  }

  /** The entry behind a server row, by its id, else by its slug; null for a server created by hand. */
  forServer(server: Pick<LoadedConnector, "id" | "slug">): ConnectorEntry | null {
    return (server.id ? this.byId(server.id) : null) ?? this.bySlug(server.slug);
  }

  /** A copy of this registry with `adapter` merged over the connector's own code. */
  withAdapter(slug: string, adapter: Adapter): ConnectorRegistry {
    return new ConnectorRegistry(
      this.entries().map((entry) =>
        entry.manifest.slug === slug ? { ...entry, adapter: { ...entry.adapter, ...adapter } } : entry,
      ),
    );
  }

  /** A copy of this registry with `entries` appended. */
  with(entries: readonly ConnectorEntry[]): ConnectorRegistry {
    return new ConnectorRegistry([...this.entries(), ...entries]);
  }

  /** A copy of this registry with `entry` in place of the one under its slug, or appended. */
  replacing(entry: ConnectorEntry): ConnectorRegistry {
    return new ConnectorRegistry([...this.without(entry.manifest.slug).entries(), entry]);
  }

  /** A copy of this registry without the connector under `slug`. */
  without(slug: string): ConnectorRegistry {
    return new ConnectorRegistry(this.entries().filter((entry) => entry.manifest.slug !== slug));
  }
}
