import type { ConnectorRow } from "../db/connectors.js";
import { jsonObj } from "../db/json.js";
import type { Manifest, ManifestTool, OAuthClient, Overrides, ToolInputSchema } from "../db/schema/index.js";
import { namespacedName } from "../mcp/names.js";
import { nameMutates } from "../mcp/verbs.js";
import { installedConnectors } from "./index.js";
import { matchesPattern } from "./manifest.js";

/** The copy fields an override may replace. */
export const OVERRIDE_FIELDS = ["display_name", "description", "limitations", "setup_hint"] as const;

function record(value: unknown): Record<string, unknown> {
  const parsed = jsonObj(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function overridesOf(value: unknown): Overrides {
  return record(value) as Overrides;
}

/** The manifest with the admin's overrides applied. */
export function applyOverrides(manifest: Manifest, overrides: Overrides): Manifest {
  const next: Manifest = { ...manifest };
  for (const field of OVERRIDE_FIELDS) {
    const value = overrides[field];
    if (typeof value === "string") {
      next[field] = value;
    }
  }
  if (manifest.tools && overrides.tools) {
    next.tools = manifest.tools.map((tool) => {
      const edit = overrides.tools?.[tool.name];
      return edit
        ? {
            ...tool,
            ...(edit.description !== undefined ? { description: edit.description } : {}),
            ...(edit.input_schema !== undefined ? { input_schema: edit.input_schema } : {}),
          }
        : tool;
    });
  }
  return next;
}

type OauthStrategy = "none" | "dynamic" | "configured";

/** A `connectors` row as every reader sees it: see `loadConnector`. */
export type LoadedConnector = {
  id: string;
  slug: string;
  tool_prefix: string;
  owner_org_id: string | null;
  display_name: string;
  transport: "http";
  config: { url?: string; oauth_client?: OAuthClient };
  auth: Manifest["auth"]["kind"];
  oauth_strategy: OauthStrategy;
  description: string;
  limitations: string | null;
  setup_hint: string | null;
  enabled: boolean;
  source: string;
  version: string;
  verified: boolean;
  experimental: boolean;
  publisher: string;
  manifest: Manifest;
  upstream: Manifest;
  overrides: Overrides;
  created_at: string;
  updated_at: string;
};

function oauthStrategyOf(manifest: Manifest): OauthStrategy {
  const strategy = manifest.auth.oauth?.strategy;
  if (manifest.auth.kind !== "oauth" || strategy === undefined) {
    return "none";
  }
  return strategy === "dynamic" ? "dynamic" : "configured";
}

/**
 * A `connectors` row as every reader sees it: the manifest with its overrides applied, plus the
 * server fields the pool, OAuth, and the API read (`config` holds the endpoint and the registered
 * OAuth client).
 */
export function loadConnector(row: ConnectorRow): LoadedConnector {
  const upstream = row.manifest;
  const overrides = row.overrides;
  const manifest = applyOverrides(upstream, overrides);
  const oauthClient = row.oauth_client;
  return {
    id: row.id,
    slug: row.slug,
    tool_prefix: row.tool_prefix,
    owner_org_id: row.owner_org_id,
    display_name: manifest.display_name,
    transport: "http",
    config: {
      ...(manifest.endpoint ? { url: manifest.endpoint.url } : {}),
      ...(oauthClient ? { oauth_client: oauthClient } : {}),
    },
    auth: manifest.auth.kind,
    oauth_strategy: oauthStrategyOf(manifest),
    description: manifest.description,
    limitations: manifest.limitations ?? null,
    setup_hint: manifest.setup_hint ?? null,
    enabled: row.enabled,
    source: row.source,
    version: row.version,
    verified: row.verified,
    experimental: row.experimental,
    publisher: row.publisher,
    manifest,
    upstream,
    overrides,
    created_at: row.installed_at,
    updated_at: row.updated_at,
  };
}

/** The effective manifest of a server row: the loaded one, else its installed connector's. */
export function serverManifest(server: LoadedConnector): Manifest | null {
  const loaded = server.manifest;
  if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
    return loaded as Manifest;
  }
  return installedConnectors().forServer(server)?.manifest ?? null;
}

function serverOverrides(server: LoadedConnector): Overrides {
  return overridesOf(server.overrides);
}

/** Whether the manifest itself starts the tool Off: it is mutating, or a `policy.default_off` pattern matches. */
export function manifestDefaultOff(manifest: Manifest | null, name: string): boolean {
  if (manifest === null) {
    return false;
  }
  if (manifest.tools?.some((tool) => tool.name === name && tool.mutating)) {
    return true;
  }
  return matchesPattern(name, manifest.policy?.default_off ?? []);
}

/** Whether the manifest leaves a listed tool out of every login's catalog: a `policy.exclude` pattern matches it. */
export function manifestExcludes(manifest: Manifest | null, name: string): boolean {
  return matchesPattern(name, manifest?.policy?.exclude ?? []);
}

/**
 * Whether a tool of this server starts Off at a new login's owner. An admin's default wins; a
 * manifest tool starts Off when it is mutating or matched by `policy.default_off`. A listed tool
 * the manifest does not name starts Off when a `policy.default_off` pattern matches it, its
 * listing marks it `destructiveHint`, or its name carries a writing verb, and On otherwise: an
 * absent hint decides nothing, and `readOnlyHint` never turns a tool On.
 */
export function toolStartsOff(
  server: LoadedConnector,
  name: string,
  listing: { destructiveHint?: boolean | null } = {},
): boolean {
  const override = serverOverrides(server).tools?.[name]?.default;
  if (typeof override === "boolean") {
    return !override;
  }
  const manifest = serverManifest(server);
  if (manifestDefaultOff(manifest, name)) {
    return true;
  }
  if (manifest?.tools?.some((tool) => tool.name === name)) {
    return false;
  }
  return listing.destructiveHint === true || nameMutates(name);
}

/** A listed tool with the admin's edits to its copy and schema. */
export function overriddenTool<T extends { remote_name: string; description: string; input_schema: ToolInputSchema }>(
  server: LoadedConnector,
  tool: T,
): T {
  const edit = serverOverrides(server).tools?.[tool.remote_name];
  if (!edit) {
    return tool;
  }
  return {
    ...tool,
    ...(edit.description !== undefined ? { description: edit.description } : {}),
    ...(edit.input_schema !== undefined ? { input_schema: edit.input_schema } : {}),
  };
}

export type CatalogTool = {
  remote_name: string;
  namespaced_name: string;
  description: string;
  input_schema: ToolInputSchema;
  mutating: boolean;
  default_enabled: boolean;
};

/** The tools a server's manifest names, by namespaced name, as the builder and the access views show them. */
export function manifestTools(server: LoadedConnector): CatalogTool[] {
  const manifest = serverManifest(server);
  const prefix = String(server.tool_prefix || server.slug);
  return (manifest?.tools ?? []).map((tool: ManifestTool) => ({
    remote_name: tool.name,
    namespaced_name: namespacedName(prefix, tool.name),
    description: tool.description,
    input_schema: tool.input_schema,
    mutating: tool.mutating === true,
    default_enabled: !toolStartsOff(server, tool.name),
  })).sort((left, right) => left.namespaced_name.localeCompare(right.namespaced_name));
}
