import type { ConnectorFacts } from "./access";

/**
 * Shapes of the orchestrator's JSON API for this server, its catalog, its registry and its user
 * directory, as the app reads them. Timestamps are ISO-8601 in UTC.
 */

export type AuthMode = "compat-cookie" | "trusted-header" | "session";

/** How the server identifies a request. An extension that signs people in adds its methods to this. */
export type AuthConfig = {
  mode: AuthMode;
};

/** How far an integration is set up: `incomplete` has some of its required fields and lacks others. */
export type IntegrationState = "on" | "off" | "incomplete";

/** Where an integration's values come from: entered under Admin → Platform keys, or the server's environment. */
export type IntegrationSource = "store" | "env";

/** One value an integration takes, and whether the server holds it; never the value itself. */
export type IntegrationField = {
  name: string;
  label: string;
  optional: boolean;
  secret: boolean;
  multiline: boolean;
  set: boolean;
};

/** An optional integration of this server: what it switches on, where its values come from, and which are set. */
export type InstanceIntegration = {
  id: string;
  label: string;
  /** What the server gains while the integration is on. */
  enables: string;
  source: IntegrationSource;
  state: IntegrationState;
  fields: IntegrationField[];
  /** A guided setup the integration offers beside its form. */
  setup: "github-app-manifest" | null;
  /** When and by whom its values were last entered; null for everyone but a platform admin. */
  updated_at: string | null;
  set_by: string | null;
  /** The native tools and connector slugs it switches on. */
  provides: { native_tools: string[]; connectors: string[] };
};

/** An integration's values to enter; replacing the GitHub App while logins exist needs `confirmReplace`. */
export type InstanceKeysInput = {
  integration: string;
  values: Record<string, string>;
  confirmReplace?: boolean;
};

/** An integration whose values to delete; removing the GitHub App while logins exist needs `confirmReplace`. */
export type InstanceKeysRemoval = { integration: string; confirmReplace?: boolean };

/** `PUT`/`DELETE /api/admin/instance/keys/:integration`: the integration after the change, and the logins it dropped. */
export type InstanceKeysResult = { integration: InstanceIntegration; disconnected: number };

/** The GitHub App a manifest creates: its name, the account that owns it, and where GitHub returns to. */
export type GithubAppManifestInput = { name?: string; owner?: string; return_to?: string };

/** `POST /api/admin/instance/keys/github-app/manifest`: where the browser posts the manifest, and the manifest. */
export type GithubAppManifestStart = {
  action: string;
  manifest: Record<string, unknown>;
  state: string;
};

/** What this server is: how it identifies a request and which integrations it has. */
export type Instance = {
  auth_mode: AuthMode;
  integrations: InstanceIntegration[];
};

/** A new account, with its personal organisation. */
export type NewUser = { name: string; email: string | null };

/** The email a user signs in with behind an authenticating proxy; null clears it. */
export type UserEmailChange = { userId: string; email: string | null };

/** A tool of a catalog connector: from its manifest, or one an admin edited after a login listed it. */
export type CatalogTool = {
  remote_name: string;
  namespaced_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  mutating: boolean;
  /** Whether a new login's tool starts On. */
  default_enabled: boolean;
  /** The admin's default, or null when the manifest decides. */
  default_override: boolean | null;
  overridden: boolean;
};

/** A copy field an admin may override on a connector the box did not write. */
export type CatalogCopyField = "display_name" | "description" | "limitations" | "setup_hint";

/** An installed connector, as the instance admin sees and edits it. */
export type CatalogServer = ConnectorFacts & {
  id: string;
  slug: string;
  display_name: string;
  auth: "none" | "token" | "oauth";
  oauth_strategy: "none" | "dynamic" | "configured";
  oauth_setup_state: string;
  description: string;
  limitations: string | null;
  setup_hint: string | null;
  url: string | null;
  enabled: boolean;
  tool_prefix: string;
  version: string;
  /** `fields`: a server made on this box, edited in place. `overrides`: edits sit over its manifest. */
  editable: "fields" | "overrides";
  upstream: {
    display_name: string;
    description: string;
    limitations: string | null;
    setup_hint: string | null;
  };
  overridden: CatalogCopyField[];
  tools: CatalogTool[];
};

/** What a registry index lists for one package: its newest version, beside every version it offers. */
export type RegistryEntry = {
  version: string;
  versions: string[];
  path: string;
  sha256: string;
  size: number;
  publisher: string;
  verified: boolean;
  display_name: string;
  description: string;
};

/** A connector in `GET /api/admin/registry`, with what the box has installed under its slug. */
export type RegistryConnector = RegistryEntry & {
  slug: string;
  /** Whether the connector is still being tried out; installing or updating it needs `experimental`. */
  experimental?: boolean;
  installed: { source: string; version: string } | null;
};

/** `GET /api/admin/registry`: the registry's connectors; `offline` when `REGISTRY_URL` is set empty. */
export type RegistryConnectors = {
  offline: boolean;
  url: string | null;
  connectors: RegistryConnector[];
};

/** What installing or updating a registry connector accepts: an unverified or experimental one. */
export type RegistryAcceptance = { unverified: boolean; experimental?: boolean };

/** A registry connector to install or update, with what the admin accepts of it. */
export type RegistryConnectorAcceptance = RegistryAcceptance & { slug: string };

/** `POST /api/admin/registry/reload`: the slugs the running server loaded, dropped, or failed to load. */
export type RegistryReload = { loaded: string[]; removed: string[]; failed: string[] };

/** What the Admin form sends: a new server's fields, or a patch; null clears an override. */
export type CatalogServerInput = {
  slug?: string;
  display_name?: string | null;
  url?: string;
  auth?: "none" | "token" | "oauth";
  oauth_strategy?: "none" | "dynamic" | "configured";
  description?: string | null;
  limitations?: string | null;
  setup_hint?: string | null;
  enabled?: boolean;
};

/** An edit to one tool; null clears that part of the edit. */
export type CatalogToolInput = {
  description?: string | null;
  input_schema?: Record<string, unknown> | null;
  default?: boolean | null;
};

/** A connector's fields to save: a new connector without `id`, or a patch of the one `id` names. */
export type CatalogServerEdit = { id?: string; input: CatalogServerInput };

/** An edit to one tool of a connector. */
export type CatalogToolEdit = { serverId: string; name: string; input: CatalogToolInput };
