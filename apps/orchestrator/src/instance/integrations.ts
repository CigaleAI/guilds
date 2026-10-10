// The registry of instance keys (docs/architecture/extension-points.md): every optional integration of the
// box, the environment variables it reads, and what it switches on. A module that needs an
// instance key asks here, so one list says what the box can be given and what it has.

import { installedConnectors } from "../connectors/index.js";
import type { ConnectorRegistry } from "../connectors/registry.js";

export type IntegrationVariable = {
  name: string;
  /** Tunes the integration; leaving it unset does not switch the integration off. */
  optional?: boolean;
  /** The value an unset variable takes; set empty, the variable is missing. */
  default?: string;
};

/** A variable's trimmed value: its default while unset, empty when set empty. */
function variableValue(variable: IntegrationVariable, env: NodeJS.ProcessEnv): string {
  const value = env[variable.name];
  return (value === undefined ? (variable.default ?? "") : value).trim();
}

/** The parts of the product an integration switches on, by id, for a client that lists them. */
export type IntegrationProvides = {
  nativeTools?: readonly string[];
};

export type Integration = {
  id: string;
  label: string;
  /** What the box gains while the integration is on. */
  enables: string;
  variables: readonly IntegrationVariable[];
  provides?: IntegrationProvides;
};

/** `incomplete`: some of its required variables are set and others are missing. */
export type IntegrationState = "on" | "off" | "incomplete";

export type IntegrationStatus = {
  id: string;
  label: string;
  enables: string;
  state: IntegrationState;
  variables: Array<{ name: string; optional: boolean; set: boolean }>;
  provides: { native_tools: string[]; connectors: string[] };
};

type VariableName<I extends Integration> = I["variables"][number]["name"];

function integration<const V extends readonly IntegrationVariable[]>(definition: {
  id: string;
  label: string;
  enables: string;
  variables: V;
  provides?: IntegrationProvides;
}): { id: string; label: string; enables: string; variables: V; provides?: IntegrationProvides } {
  return definition;
}

export const WEB_SEARCH = integration({
  id: "web-search",
  label: "Web search",
  enables: "Web search on the platform's Tavily key, for every organisation without a key of its own",
  variables: [{ name: "TAVILY_API_KEY" }],
});

export const GROUP_ROUTING = integration({
  id: "group-routing",
  label: "Group routing",
  enables: "Recipient and history selection in group chat, beyond tag rules",
  variables: [{ name: "TYPESAFE_API_KEY" }, { name: "TYPESAFE_MODEL", optional: true }],
});

export const GITHUB_APP = integration({
  id: "github-app",
  label: "GitHub App",
  enables: "The GitHub connector and a guild's repositories",
  variables: [
    { name: "GITHUB_APP_ID" },
    { name: "GITHUB_APP_SLUG" },
    { name: "GITHUB_APP_PRIVATE_KEY" },
    { name: "GITHUB_APP_CLIENT_ID" },
    { name: "GITHUB_APP_CLIENT_SECRET" },
  ],
});

export const GOOGLE_CONNECTORS = integration({
  id: "google-connectors",
  label: "Google connectors",
  enables: "The Gmail and Drive connectors",
  variables: [{ name: "GMAIL_OAUTH_CLIENT_ID" }, { name: "GMAIL_OAUTH_CLIENT_SECRET" }],
});

export const ERROR_REPORTING = integration({
  id: "error-reporting",
  label: "Error reporting",
  enables: "Errors and traces sent to Sentry",
  variables: [{ name: "SENTRY_DSN" }],
});

/** Where connectors and recipes are installed from; `REGISTRY_URL` set empty keeps the box offline. */
export const REGISTRY = integration({
  id: "registry",
  label: "Registry",
  enables: "Installing connectors and recipes from a registry",
  variables: [
    { name: "REGISTRY_URL", default: "https://registry.guilds.run" },
    { name: "REGISTRY_PUBLIC_KEY", optional: true },
  ],
});

/** Connectors with code installed at runtime: an opt-in, because their adapter runs in this process. */
export const CONNECTOR_CODE = integration({
  id: "connector-code",
  label: "Connector code",
  enables: "Installing registry connectors that carry adapter code, from an index REGISTRY_PUBLIC_KEY verifies",
  variables: [{ name: "CONNECTORS_CODE_TIER" }, { name: "CONNECTORS_ROOT", optional: true }],
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

/** The integrations this box reads: core's, then an extension's. */
export function installedIntegrations(): readonly Integration[] {
  return installed;
}

/** Lists an extension's integrations after core's. */
export function installIntegrations(extra: readonly Integration[]): void {
  installed = [...CORE_INTEGRATIONS, ...extra];
}

/** One variable's trimmed value: its default while unset, empty when unset with none. */
export function integrationVariable<const I extends Integration>(
  integration: I,
  name: VariableName<I>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const variable = integration.variables.find((item) => item.name === name);
  return variable ? variableValue(variable, env) : (env[name] ?? "").trim();
}

/** The required variables that are unset. */
export function missingVariables(integration: Integration, env: NodeJS.ProcessEnv = process.env): string[] {
  return integration.variables
    .filter((variable) => !variable.optional && !variableValue(variable, env))
    .map((variable) => variable.name);
}

export function integrationState(
  integration: Integration,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationState {
  const required = integration.variables.filter((variable) => !variable.optional);
  const missing = missingVariables(integration, env);
  if (missing.length === 0) {
    return "on";
  }
  return missing.length === required.length ? "off" : "incomplete";
}

/** Every variable's trimmed value while the integration is on, else null. */
export function integrationValues<const I extends Integration>(
  integration: I,
  env: NodeJS.ProcessEnv = process.env,
): Record<VariableName<I>, string> | null {
  if (integrationState(integration, env) !== "on") {
    return null;
  }
  return Object.fromEntries(
    integration.variables.map((variable) => [variable.name, variableValue(variable, env)]),
  ) as Record<VariableName<I>, string>;
}

/**
 * What the box has, for the operator: each integration's state and which variables are set, never
 * a value. Its connectors are the installed ones whose manifest requires it or takes its key.
 */
export function integrationStatuses(
  integrations: readonly Integration[],
  env: NodeJS.ProcessEnv = process.env,
  connectors: ConnectorRegistry = installedConnectors(),
): IntegrationStatus[] {
  const connectorsOf = (id: string) =>
    connectors
      .entries()
      .filter((entry) => entry.manifest.requires?.integration === id || entry.manifest.auth.instance?.integration === id)
      .map((entry) => entry.manifest.slug);
  return integrations.map((integration) => ({
    id: integration.id,
    label: integration.label,
    enables: integration.enables,
    state: integrationState(integration, env),
    variables: integration.variables.map((variable) => ({
      name: variable.name,
      optional: Boolean(variable.optional),
      set: Boolean((env[variable.name] ?? "").trim()),
    })),
    provides: {
      native_tools: [...(integration.provides?.nativeTools ?? [])],
      connectors: connectorsOf(integration.id),
    },
  }));
}
