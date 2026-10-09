import type { CatalogModel, Instance, InstanceIntegration, McpServerAccess } from "../../api/types";

type Provided = keyof InstanceIntegration["provides"];

const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const alternatives = new Intl.ListFormat("en", { style: "long", type: "disjunction" });

/** The integration that switches on a model provider, native tool, or connector, when one does. */
export function integrationFor(
  instance: Instance | undefined,
  kind: Provided,
  id: string,
): InstanceIntegration | undefined {
  return instance?.integrations.find((item) => item.provides[kind].includes(id));
}

/** The required variables an integration still lacks. */
export function missingVariables(integration: InstanceIntegration): string[] {
  return integration.variables
    .filter((variable) => !variable.optional && !variable.set)
    .map((variable) => variable.name);
}

/** The variables that would switch an integration on, as a phrase: `A`, `A and B`, `A, B, and C`. */
export function missingVariablesPhrase(integration: InstanceIntegration): string {
  return names.format(missingVariables(integration));
}

/**
 * The integration a native tool waits for on this server, or null when the tool is offered. Until
 * the integration is on the server leaves the tool out of every run.
 */
export function toolIntegrationGap(
  instance: Instance | undefined,
  toolName: string,
): InstanceIntegration | null {
  const integration = integrationFor(instance, "native_tools", toolName);
  return integration && integration.state !== "on" ? integration : null;
}

/**
 * The integration whose key a model would run on, when the organisation has no key for the
 * model's provider and the server has none either. Null while either is still loading, and for a
 * provider the server never holds a key for.
 */
export function modelKeyGap(
  model: Pick<CatalogModel, "provider"> | undefined,
  connected: readonly string[] | undefined,
  instance: Instance | undefined,
): InstanceIntegration | null {
  if (!model || !connected || connected.includes(model.provider)) return null;
  const integration = integrationFor(instance, "model_providers", model.provider);
  return integration && integration.state !== "on" ? integration : null;
}

/**
 * Whether a model can run: the organisation has any key, or the server has a model-provider
 * integration on. Null while either is still loading.
 */
export function hasModelKey(
  connected: readonly string[] | undefined,
  instance: Instance | undefined,
): boolean | null {
  if (!connected || !instance) return null;
  if (connected.length > 0) return true;
  return instance.integrations.some(
    (item) => item.provides.model_providers.length > 0 && item.state === "on",
  );
}

/** The instance variables that would give a model key, as a phrase: `A`, `A or B`. */
export function missingModelKeyPhrase(instance: Instance): string {
  return alternatives.format(
    instance.integrations
      .filter((item) => item.provides.model_providers.length > 0 && item.state !== "on")
      .flatMap(missingVariables),
  );
}

/** Why a connector's sign-in cannot start on this server, or null when it can. */
export function connectorSetupGap(
  server: Pick<McpServerAccess, "slug" | "oauth_setup_state">,
  instance: Instance | undefined,
): string | null {
  if (server.oauth_setup_state !== "unsupported") return null;
  const integration = integrationFor(instance, "connectors", server.slug);
  if (!integration || integration.state === "on") {
    return "This server has no OAuth client for this connector.";
  }
  return `Needs ${missingVariablesPhrase(integration)} set on this server.`;
}
