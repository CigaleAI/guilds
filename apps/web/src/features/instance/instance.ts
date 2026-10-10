import type { Instance, InstanceIntegration, McpServerAccess } from "../../api/types";

type Provided = keyof InstanceIntegration["provides"];

const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

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
