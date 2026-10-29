import { existsSync } from "node:fs";
import path from "node:path";
import {
  getConnector,
  getConnectorBySlug,
  listOrgConnectors,
  setConnectorOauthClient,
  type ConnectorRow,
} from "../db/connectors.js";
import type { McpToolRow } from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";
import type {
  AuthField,
  ConnectionSettings,
  Manifest,
  OAuthClient,
  Overrides,
  ToolInputSchema,
} from "../db/schema/index.js";
import { installedConnectors } from "./index.js";
import { authFields, matchesPattern } from "./manifest.js";
import { nameMutates, namespacedName } from "./naming.js";
import type { ConnectorEntry, ConnectorSource } from "./registry.js";
import { settingsComplete, validateSettings } from "./settings.js";
import type { Adapter, ConnectorTool } from "./types.js";

/** The copy fields an override may replace. */
const OVERRIDE_FIELDS = ["display_name", "description", "limitations", "setup_hint"] as const;

/** A copy field of a connector that an admin's override may replace. */
export type CopyField = (typeof OVERRIDE_FIELDS)[number];

/** The manifest with the admin's overrides applied. */
function applyOverrides(manifest: Manifest, overrides: Overrides): Manifest {
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
  /** The effective manifest: the stored one with the admin's overrides applied. */
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

/**
 * Which connectors a listing holds. `owner`: `"platform"`, the platform's alone; `{ orgId }`, that
 * organisation's own alone; `{ visibleTo }`, what an organisation sees, the platform's and its own
 * (with null, no organisation: the platform's alone). `enabled`: only the ones switched on.
 * `source`: only the ones installed from a registry.
 */
export type ServerScope = {
  owner: "platform" | { orgId: string } | { visibleTo: string | null };
  enabled?: true;
  source?: "registry";
};

/** The connectors in `scope`, loaded with their overrides, by slug. */
export async function listServers(db: Queryable, scope: ServerScope): Promise<LoadedConnector[]> {
  const { owner } = scope;
  const ownOnly = owner !== "platform" && "orgId" in owner;
  const orgId = owner === "platform" ? null : "orgId" in owner ? owner.orgId : owner.visibleTo;
  return (await listOrgConnectors(db, orgId))
    .filter(
      (row) =>
        (!ownOnly || row.owner_org_id === orgId) &&
        (scope.enabled === undefined || row.enabled) &&
        (scope.source === undefined || row.source === scope.source),
    )
    .map((row) => loadConnector(row));
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

/** Stores the OAuth client a connector registered with its authorization server. */
export async function saveOauthClient(
  db: Queryable,
  serverId: string,
  client: OAuthClient,
  now: Date,
): Promise<LoadedConnector | null> {
  const row = await setConnectorOauthClient(db, serverId, client, now);
  return row === null ? null : loadConnector(row);
}

/** The copy fields the admin's overrides replace on this connector. */
export function overriddenCopyFields(server: LoadedConnector): CopyField[] {
  return OVERRIDE_FIELDS.filter((field) => typeof server.overrides[field] === "string");
}

/**
 * The overrides with an admin's edit of the copy fields applied: for each copy field `edit` names,
 * null clears the override, and any other value replaces it with what that field's check makes of it.
 */
export function editCopyOverrides(
  overrides: Overrides,
  edit: Readonly<Record<string, unknown>>,
  checks: Readonly<Record<CopyField, (value: unknown) => string>>,
): Overrides {
  const next: Overrides = { ...overrides };
  for (const field of OVERRIDE_FIELDS) {
    const value = edit[field];
    if (value === null) {
      delete next[field];
    } else if (value !== undefined) {
      next[field] = checks[field](value);
    }
  }
  return next;
}

/**
 * The manifest of a server as its sign-in, its endpoint, and its listing policy read it: the
 * connector this box runs for it, else the row's.
 */
export function serverManifest(server: LoadedConnector): Manifest {
  return installedConnectors().forServer(server)?.manifest ?? server.manifest;
}

/**
 * One tool a server offers, as the Admin tab and the builder see it: its names, its copy and
 * schema after the admin's edits, and whether it starts On at a new login's owner.
 */
export type ServerTool = {
  remote_name: string;
  namespaced_name: string;
  description: string;
  input_schema: ToolInputSchema;
  /** The manifest marks it mutating, or for a listed tool, the listing does. */
  mutating: boolean;
  default_enabled: boolean;
  /** The admin's choice of whether it starts On; null when the admin made none. */
  default_override: boolean | null;
  /** Whether the admin edited the tool. */
  overridden: boolean;
};

/** A tool a login lists, as the box offers it, with the hints its listing gave. */
export type ListedServerTool = ServerTool & {
  /** The listing's `readOnlyHint`; null when it gave none. */
  read_only_hint: boolean | null;
  /** The listing's `destructiveHint`; null when it gave none. */
  destructive_hint: boolean | null;
};

function toolPrefix(server: LoadedConnector): string {
  return server.tool_prefix || server.slug;
}

/** Whether the manifest itself starts the tool Off: it is mutating, or a `policy.default_off` pattern matches. */
function manifestStartsOff(manifest: Manifest, name: string): boolean {
  if (manifest.tools?.some((tool) => tool.name === name && tool.mutating)) {
    return true;
  }
  return matchesPattern(name, manifest.policy?.default_off ?? []);
}

/**
 * Whether a tool of this server starts Off at a new login's owner. An admin's default wins; a
 * manifest tool starts Off when it is mutating or matched by `policy.default_off`. A listed tool
 * the manifest does not name starts Off when a `policy.default_off` pattern matches it, its
 * listing marks it `destructiveHint`, or its name carries a writing verb, and On otherwise: an
 * absent hint decides nothing, and `readOnlyHint` never turns a tool On.
 */
function toolStartsOff(server: LoadedConnector, name: string, destructiveHint: boolean | null): boolean {
  const override = server.overrides.tools?.[name]?.default;
  if (typeof override === "boolean") {
    return !override;
  }
  if (manifestStartsOff(server.manifest, name)) {
    return true;
  }
  if (server.manifest.tools?.some((tool) => tool.name === name)) {
    return false;
  }
  return destructiveHint === true || nameMutates(name);
}

function defaultOverride(server: LoadedConnector, name: string): boolean | null {
  const choice = server.overrides.tools?.[name]?.default;
  return typeof choice === "boolean" ? choice : null;
}

/** The tools a server offers before any login lists them: the ones its manifest names, by namespaced name. */
export function serverTools(server: LoadedConnector): ServerTool[] {
  const edits = server.overrides.tools ?? {};
  const prefix = toolPrefix(server);
  return (server.manifest.tools ?? [])
    .map((tool) => ({
      remote_name: tool.name,
      namespaced_name: namespacedName(prefix, tool.name),
      description: tool.description,
      input_schema: tool.input_schema,
      mutating: tool.mutating === true,
      default_enabled: !toolStartsOff(server, tool.name, null),
      default_override: defaultOverride(server, tool.name),
      overridden: tool.name in edits,
    }))
    .sort((left, right) => left.namespaced_name.localeCompare(right.namespaced_name));
}

/**
 * The tools the admin edits on a server: the ones it offers before any login lists them
 * (`serverTools`), then the ones only the admin's overrides name, which a login listed.
 */
export function editableTools(server: LoadedConnector): ServerTool[] {
  const named = serverTools(server);
  const prefix = toolPrefix(server);
  const names = new Set(named.map((tool) => tool.remote_name));
  const overrideOnly = Object.entries(server.overrides.tools ?? {})
    .filter(([name]) => !names.has(name))
    .map(([name, edit]) => ({
      remote_name: name,
      namespaced_name: namespacedName(prefix, name),
      description: edit.description ?? "",
      input_schema: edit.input_schema ?? { type: "object" },
      mutating: false,
      default_enabled: !toolStartsOff(server, name, null),
      default_override: defaultOverride(server, name),
      overridden: true,
    }));
  return [...named, ...overrideOnly];
}

/**
 * One entry of a server's remote listing as the box offers it: null when a `policy.exclude`
 * pattern of its manifest (`serverManifest`) leaves it out of every login's catalog, else with
 * the admin's edits to its copy and schema and whether it starts On.
 */
export function effectiveTool(server: LoadedConnector, remote: ConnectorTool): ListedServerTool | null {
  if (matchesPattern(remote.name, serverManifest(server).policy?.exclude ?? [])) {
    return null;
  }
  const edit = server.overrides.tools?.[remote.name];
  const destructiveHint = remote.destructive_hint ?? null;
  return {
    remote_name: remote.name,
    namespaced_name: namespacedName(toolPrefix(server), remote.name),
    description: edit?.description ?? remote.description,
    input_schema: edit?.input_schema ?? remote.input_schema,
    mutating: remote.mutating === true,
    read_only_hint: remote.read_only_hint ?? null,
    destructive_hint: destructiveHint,
    default_enabled: !toolStartsOff(server, remote.name, destructiveHint),
    default_override: defaultOverride(server, remote.name),
    overridden: edit !== undefined,
  };
}

/**
 * A tool a login's stored listing holds, as the box offers it: the names it was stored under, the
 * admin's edit to its copy, and whether it starts On. The listing left out what the manifest
 * excludes when it was stored.
 */
export function listedTool(server: LoadedConnector, row: McpToolRow): ServerTool {
  const edit = server.overrides.tools?.[row.remote_name];
  return {
    remote_name: row.remote_name,
    namespaced_name: row.namespaced_name,
    description: edit?.description ?? row.description,
    input_schema: edit?.input_schema ?? row.input_schema,
    mutating: false,
    default_enabled: !toolStartsOff(server, row.remote_name, row.destructive_hint),
    default_override: defaultOverride(server, row.remote_name),
    overridden: edit !== undefined,
  };
}

/**
 * Whether Studio may proxy a remote tool of this server on an operator-granted login. A tool the
 * manifest of the connector this box runs under the server's slug starts Off is never readable;
 * any other tool that manifest names is. A listed tool's `readOnlyHint` counts only on a verified
 * connector; any other tool is classified by the verbs in its name.
 */
export function isReadOnlyRemote(server: LoadedConnector, remoteName: string, readOnlyHint: boolean | null): boolean {
  const manifest = installedConnectors().bySlug(server.slug)?.manifest;
  if (manifest && manifestStartsOff(manifest, remoteName)) {
    return false;
  }
  if (manifest?.tools?.some((tool) => tool.name === remoteName)) {
    return true;
  }
  if (server.verified && readOnlyHint === true) {
    return true;
  }
  return !nameMutates(remoteName);
}

/** The JSON Schema of the settings a login of a server stores, as the server's manifest declares it. */
export type SettingsSchema = NonNullable<Manifest["settings_schema"]>;

/** The JSON Schema of the settings a login of this server stores: its installed connector's, or null when it takes none. */
export function serverSettings(server: LoadedConnector): SettingsSchema | null {
  return installedConnectors().forServer(server)?.manifest.settings_schema ?? null;
}

/** Whether a login's settings hold every property the server's settings schema (`serverSettings`) requires. */
export function holdsRequiredSettings(server: LoadedConnector, settings: ConnectionSettings): boolean {
  return settingsComplete(serverSettings(server) ?? undefined, settings);
}

/**
 * Where a new login of a server stands with the settings its form gave: `complete` once they hold
 * every property the server's settings schema requires, so the login connects; `awaiting` while
 * it waits for them.
 */
export type SettingsOutcome = { kind: "complete" | "awaiting"; values: ConnectionSettings };

/**
 * Where a new login of `server` stands with the settings `values`. Settings given are checked in
 * full against the server's settings schema (`serverSettings`), and a `SettingsError` names the
 * first problem. A server with no schema takes the values as they are.
 */
export function settingsOutcome(server: LoadedConnector, values: ConnectionSettings): SettingsOutcome {
  const schema = serverSettings(server);
  if (schema && Object.keys(values).length) {
    validateSettings(schema, values);
  }
  return { kind: holdsRequiredSettings(server, values) ? "complete" : "awaiting", values };
}

/**
 * The code that serves a server: the manifest and the adapter of the connector this box runs for
 * it, and whether the box calls the server's endpoint.
 */
export type ConnectorCode = { manifest: Manifest | null; adapter: Adapter; endpoint: boolean };

/**
 * The code that serves a server: the connector this box runs for it, with calls going to its
 * endpoint when its manifest has one. A server the box runs no connector for (made by hand, or a
 * registry connector without code) has no manifest or adapter here and is its endpoint alone.
 */
export function connectorCode(server: LoadedConnector): ConnectorCode {
  const entry = installedConnectors().forServer(server);
  if (entry === null) {
    return { manifest: null, adapter: {}, endpoint: true };
  }
  return { manifest: entry.manifest, adapter: entry.adapter, endpoint: Boolean(entry.manifest.endpoint) };
}

/** A connector's State hook: the server it reads with, its connector's manifest, the State key it fills, and the hook. */
export type StateHook = { serverId: string; manifest: Manifest; key: string; read: NonNullable<Adapter["state"]> };

/** The State hooks of the connectors this box runs, in the order it runs them. */
export function stateHooks(): StateHook[] {
  return installedConnectors()
    .entries()
    .flatMap((entry) =>
      entry.manifest.state && entry.adapter.state
        ? [{ serverId: entry.id, manifest: entry.manifest, key: entry.manifest.state.key, read: entry.adapter.state }]
        : [],
    );
}

/** The manifests of the connectors this box runs: core's, then an extension's and the registry's with code. */
export function installedManifests(): Manifest[] {
  return installedConnectors()
    .entries()
    .map((entry) => entry.manifest);
}

/** The connector this box runs under `slug`: its server id and display name, or null when it runs none. */
export function installedConnectorBySlug(slug: string): { id: string; display_name: string } | null {
  const entry = installedConnectors().bySlug(slug);
  return entry === null ? null : { id: entry.id, display_name: entry.manifest.display_name };
}

/** What the API says about a server beside its row: how to sign in, where it came from, and its mark. */
export type ConnectorFacts = {
  auth_fields: AuthField[];
  /** The JSON Schema of what a login stores beside its credentials, or null when it stores nothing. */
  settings_schema: SettingsSchema | null;
  source: ConnectorSource;
  verified: boolean;
  /** The registry's mark for a connector still being tried out. */
  experimental: boolean;
  publisher: string;
  logo_url: string | null;
};

const LOGO = "logo.svg";

function entryLogo(entry: ConnectorEntry): string | null {
  if (!entry.folder) {
    return null;
  }
  const file = path.join(entry.folder, LOGO);
  return existsSync(file) ? file : null;
}

/** The `logo.svg` on disk of the connector this box runs under a server id, or null when it has none. */
export function logoPath(serverId: string): string | null {
  const entry = installedConnectors().byId(serverId);
  return entry === null ? null : entryLogo(entry);
}

/**
 * The facts of a server: from its installed entry (a folder in the image, or a registry connector
 * with code), else from its row (a registry connector without code, or one made on this box).
 */
export function connectorFacts(server: LoadedConnector): ConnectorFacts {
  const entry = installedConnectors().forServer(server);
  const experimental = server.experimental;
  if (entry === null) {
    const source: ConnectorSource = server.source === "registry" ? "registry" : "local";
    return {
      auth_fields: authFields(server.manifest),
      settings_schema: server.manifest.settings_schema ?? null,
      source,
      verified: source === "registry" && server.verified,
      experimental,
      publisher: source === "registry" ? server.publisher : "",
      logo_url: null,
    };
  }
  return {
    auth_fields: authFields(entry.manifest),
    settings_schema: entry.manifest.settings_schema ?? null,
    source: entry.source,
    verified: entry.verified,
    experimental,
    publisher: entry.publisher,
    logo_url: entryLogo(entry) ? `/api/mcp/servers/${encodeURIComponent(entry.id)}/logo` : null,
  };
}
