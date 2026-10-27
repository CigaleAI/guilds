import { CONNECTORS } from "../../src/connectors/index.js";
import { loadConnector, type LoadedConnector } from "../../src/connectors/load.js";
import type { Manifest } from "../../src/db/schema/index.js";

const STAMP = "2026-10-12T09:00:00.000Z";

/**
 * A connector as `getMcpServer` loads it: core's installed connector of `slug` when there is one,
 * else a hand-made token connector of that slug. `overrides` replaces fields after loading.
 */
export function serverRow(slug: string, overrides: Partial<LoadedConnector> = {}): LoadedConnector {
  const entry = CONNECTORS.bySlug(slug);
  const manifest: Manifest = entry?.manifest ?? {
    slug,
    display_name: slug,
    auth: { kind: "token" },
    description: "",
  };
  const loaded = loadConnector({
    id: entry?.id ?? `mcp_${slug}`,
    slug,
    tool_prefix: slug,
    owner_org_id: null,
    manifest,
    source: entry?.source ?? "local",
    version: "",
    verified: entry?.verified ?? false,
    experimental: false,
    publisher: entry?.publisher ?? "",
    enabled: true,
    oauth_client: null,
    overrides: {},
    installed_at: STAMP,
    updated_at: STAMP,
  });
  return { ...loaded, ...overrides };
}
