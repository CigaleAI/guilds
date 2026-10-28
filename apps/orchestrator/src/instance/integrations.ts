// The registry of instance keys (docs/architecture/extension-points.md): every optional integration of the
// box, the fields it takes, where their values come from, and what it switches on. A module that
// needs an instance key asks here, so one list says what the box can be given and what it has.

import { installedConnectors } from "../connectors/index.js";
import type { ConnectorRegistry } from "../connectors/registry.js";
import type { Manifest } from "../db/schema/index.js";

/** Where an integration's values come from: the encrypted `instance_keys` store, or the process environment. */
export type IntegrationSource = "store" | "env";

export type IntegrationField = {
  /** A store field's key in the payload; an env field's variable name. */
  name: string;
  label: string;
  /** Shown as a password field and never echoed; every store field is encrypted regardless. */
  secret?: boolean;
  /** Tunes the integration; leaving it unset does not switch the integration off. */
  optional?: boolean;
  /** Taken in a text area, for a PEM. */
  multiline?: boolean;
  placeholder?: string;
  /** An env field's value while the variable is unset; set empty, the field is missing. */
  default?: string;
};

/** A flow the operator app offers to fill an integration beside the form. */
export type IntegrationSetup = "github-app-manifest";

/** The parts of the product an integration switches on, by id, for a client that lists them. */
export type IntegrationProvides = {
  nativeTools?: readonly string[];
  connectors?: readonly string[];
};

export type Integration = {
  id: string;
  label: string;
  /** What the box gains while the integration is on. */
  enables: string;
  source: IntegrationSource;
  fields: readonly IntegrationField[];
  provides?: IntegrationProvides;
  setup?: IntegrationSetup;
};

/** `incomplete`: some of its required fields are set and others are missing. */
export type IntegrationState = "on" | "off" | "incomplete";

export type IntegrationStatus = {
  id: string;
  label: string;
  enables: string;
  source: IntegrationSource;
  state: IntegrationState;
  fields: Array<{ name: string; label: string; optional: boolean; secret: boolean; multiline: boolean; set: boolean }>;
  setup: IntegrationSetup | null;
  /** When and by whom a store integration was last written; null for the environment and for a reader without audit. */
  updated_at: string | null;
  set_by: string | null;
  provides: { native_tools: string[]; connectors: string[] };
};

/** A store integration's decrypted values with who wrote them, as the process holds them. */
export type InstanceKeyRow = { values: Record<string, string>; updated_at: string; set_by: string | null };

/** Every store integration's row, by integration id. */
export type InstanceKeySnapshot = Readonly<Record<string, InstanceKeyRow>>;

/** What readers resolve values from; each part defaults to the process's own. */
export type IntegrationSources = { env?: NodeJS.ProcessEnv; keys?: InstanceKeySnapshot };

type FieldName<I extends Integration> = I["fields"][number]["name"];

function integration<const F extends readonly IntegrationField[]>(definition: {
  id: string;
  label: string;
  enables: string;
  source: IntegrationSource;
  fields: F;
  provides?: IntegrationProvides;
  setup?: IntegrationSetup;
}): {
  id: string;
  label: string;
  enables: string;
  source: IntegrationSource;
  fields: F;
  provides?: IntegrationProvides;
  setup?: IntegrationSetup;
} {
  return definition;
}

export const WEB_SEARCH = integration({
  id: "web-search",
  label: "Web search",
  enables: "Web search on the platform's Tavily key, for every organisation without a key of its own",
  source: "store",
  fields: [{ name: "api_key", label: "Tavily API key", secret: true }],
});

export const GROUP_ROUTING = integration({
  id: "group-routing",
  label: "Group routing",
  enables: "Recipient and history selection in group chat, beyond tag rules",
  source: "store",
  fields: [
    { name: "api_key", label: "TypeSafe API key", secret: true },
    { name: "model", label: "Model", optional: true, placeholder: "jev-next" },
  ],
});

export const GITHUB_APP = integration({
  id: "github-app",
  label: "GitHub App",
  enables: "The GitHub connector and a guild's repositories",
  source: "store",
  setup: "github-app-manifest",
  fields: [
    { name: "app_id", label: "App ID" },
    { name: "slug", label: "App slug" },
    { name: "private_key", label: "Private key (PEM)", secret: true, multiline: true },
    { name: "client_id", label: "Client ID" },
    { name: "client_secret", label: "Client secret", secret: true },
  ],
});

export const GOOGLE_CONNECTORS = integration({
  id: "google-connectors",
  label: "Google connectors",
  enables: "The Gmail and Drive connectors",
  source: "store",
  fields: [
    { name: "client_id", label: "Client ID" },
    { name: "client_secret", label: "Client secret", secret: true },
  ],
});

export const ERROR_REPORTING = integration({
  id: "error-reporting",
  label: "Error reporting",
  enables: "Errors and traces sent to Sentry",
  source: "env",
  fields: [{ name: "SENTRY_DSN", label: "Sentry DSN" }],
});

/** Where connectors and recipes are installed from; `REGISTRY_URL` set empty keeps the box offline. */
export const REGISTRY = integration({
  id: "registry",
  label: "Registry",
  enables: "Installing connectors and recipes from a registry",
  source: "env",
  fields: [
    { name: "REGISTRY_URL", label: "Registry URL", default: "https://registry.guilds.run" },
    { name: "REGISTRY_PUBLIC_KEY", label: "Registry public key", optional: true },
  ],
});

/** Connectors with code installed at runtime: an opt-in, because their adapter runs in this process. */
export const CONNECTOR_CODE = integration({
  id: "connector-code",
  label: "Connector code",
  enables: "Installing registry connectors that carry adapter code, from an index REGISTRY_PUBLIC_KEY verifies",
  source: "env",
  fields: [
    { name: "CONNECTORS_CODE_TIER", label: "Code tier" },
    { name: "CONNECTORS_ROOT", label: "Connectors root", optional: true },
  ],
});

export const CORE_INTEGRATIONS: readonly Integration[] = [
  WEB_SEARCH,
  GROUP_ROUTING,
  GITHUB_APP,
  GOOGLE_CONNECTORS,
  ERROR_REPORTING,
  REGISTRY,
  CONNECTOR_CODE,
];

let installed: readonly Integration[] = CORE_INTEGRATIONS;
let derived: readonly Integration[] = [];

/** The integrations this box reads: core's, then an extension's, then those its connectors declare of their own. */
export function installedIntegrations(): readonly Integration[] {
  return derived.length ? [...installed, ...derived] : installed;
}

/** Lists an extension's integrations after core's. */
export function installIntegrations(extra: readonly Integration[]): void {
  installed = [...CORE_INTEGRATIONS, ...extra];
}

/** The id of the integration a connector declares of its own. */
export function connectorIntegrationId(slug: string): string {
  return `connector:${slug}`;
}

/** Lists the integrations the box's connectors declare of their own, after the shipped ones. */
export function setConnectorIntegrations(list: readonly Integration[]): void {
  derived = list;
}

let snapshot: InstanceKeySnapshot = {};

/** What the store holds, decrypted once at boot and again after every write; readers resolve store fields from it. */
export function instanceKeys(): InstanceKeySnapshot {
  return snapshot;
}

export function setInstanceKeys(next: InstanceKeySnapshot): void {
  snapshot = next;
}

function sourcesOf(sources?: IntegrationSources): { env: NodeJS.ProcessEnv; keys: InstanceKeySnapshot } {
  return { env: sources?.env ?? process.env, keys: sources?.keys ?? snapshot };
}

/** A field's trimmed value: an env field's default while unset, empty when set empty or absent from the store. */
function fieldValue(integration: Integration, field: IntegrationField, sources?: IntegrationSources): string {
  const { env, keys } = sourcesOf(sources);
  if (integration.source === "env") {
    const value = env[field.name];
    return (value === undefined ? (field.default ?? "") : value).trim();
  }
  return (keys[integration.id]?.values[field.name] ?? "").trim();
}

/** Whether a field was given: an env variable set non-empty, or a store value present; a default does not count. */
function fieldSet(integration: Integration, field: IntegrationField, sources?: IntegrationSources): boolean {
  const { env, keys } = sourcesOf(sources);
  if (integration.source === "env") {
    return Boolean((env[field.name] ?? "").trim());
  }
  return Boolean((keys[integration.id]?.values[field.name] ?? "").trim());
}

/** One field's trimmed value, or empty when the integration has no field of that name. */
export function integrationValue<const I extends Integration>(
  integration: I,
  name: FieldName<I>,
  sources?: IntegrationSources,
): string {
  const field = integration.fields.find((item) => item.name === name);
  return field ? fieldValue(integration, field, sources) : "";
}

/** The required fields that are unset. */
export function missingFields(integration: Integration, sources?: IntegrationSources): IntegrationField[] {
  return integration.fields.filter((field) => !field.optional && !fieldValue(integration, field, sources));
}

export function integrationState(integration: Integration, sources?: IntegrationSources): IntegrationState {
  const required = integration.fields.filter((field) => !field.optional);
  const missing = missingFields(integration, sources);
  if (missing.length === 0) {
    return "on";
  }
  return missing.length === required.length ? "off" : "incomplete";
}

/** Every field's trimmed value while the integration is on, else null. */
export function integrationValues<const I extends Integration>(
  integration: I,
  sources?: IntegrationSources,
): Record<FieldName<I>, string> | null {
  if (integrationState(integration, sources) !== "on") {
    return null;
  }
  return Object.fromEntries(
    integration.fields.map((field) => [field.name, fieldValue(integration, field, sources)]),
  ) as Record<FieldName<I>, string>;
}

/**
 * The integration a connector's manifest requires, takes its platform key from, or declares of
 * its own (a key, or an OAuth client with no provider), when it names one.
 */
export function integrationForConnector(
  manifest: Pick<Manifest, "slug" | "requires" | "auth">,
  integrations: readonly Integration[] = installedIntegrations(),
): Integration | null {
  const instance = manifest.auth.instance;
  const oauth = manifest.auth.oauth;
  let id = manifest.requires?.integration ?? null;
  if (!id && instance) {
    id = "integration" in instance ? instance.integration : connectorIntegrationId(manifest.slug);
  }
  if (!id && manifest.auth.kind === "oauth" && oauth?.strategy === "configured" && !oauth.provider) {
    id = connectorIntegrationId(manifest.slug);
  }
  return id ? (integrations.find((item) => item.id === id) ?? null) : null;
}

/**
 * What the box has, for the operator: each integration's state and which fields are set, never
 * a value. Its connectors are the installed ones whose manifest requires it or takes its key.
 * `audit` adds when and by whom a store row was written, for the instance admin.
 */
export function integrationStatuses(
  integrations: readonly Integration[],
  sources?: IntegrationSources,
  connectors: ConnectorRegistry = installedConnectors(),
  options: { audit?: boolean } = {},
): IntegrationStatus[] {
  const { keys } = sourcesOf(sources);
  const connectorsOf = (id: string) =>
    connectors
      .entries()
      .filter((entry) => integrationForConnector(entry.manifest, integrations)?.id === id)
      .map((entry) => entry.manifest.slug);
  return integrations.map((integration) => {
    const row = integration.source === "store" && options.audit ? (keys[integration.id] ?? null) : null;
    return {
      id: integration.id,
      label: integration.label,
      enables: integration.enables,
      source: integration.source,
      state: integrationState(integration, sources),
      fields: integration.fields.map((field) => ({
        name: field.name,
        label: field.label,
        optional: Boolean(field.optional),
        secret: Boolean(field.secret),
        multiline: Boolean(field.multiline),
        set: fieldSet(integration, field, sources),
      })),
      setup: integration.setup ?? null,
      updated_at: row?.updated_at ?? null,
      set_by: row?.set_by ?? null,
      provides: {
        native_tools: [...(integration.provides?.nativeTools ?? [])],
        connectors: [...new Set([...(integration.provides?.connectors ?? []), ...connectorsOf(integration.id)])],
      },
    };
  });
}
