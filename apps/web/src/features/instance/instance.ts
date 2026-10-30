import type { Instance, InstanceIntegration, IntegrationField } from "../../api/types/admin";
import type { McpServerAccess } from "../../api/types/access";

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

/** The required fields an integration still lacks. */
export function missingFields(integration: InstanceIntegration): IntegrationField[] {
  return integration.fields.filter((field) => !field.optional && !field.set);
}

/** The fields that would switch an integration on, by label: `A`, `A and B`, `A, B, and C`. */
export function missingFieldsPhrase(integration: InstanceIntegration): string {
  return names.format(missingFields(integration).map((field) => field.label));
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

/** Why a connector's sign-in cannot start here, and the platform key that would let it, when one does. */
export type ConnectorSetupGap = { text: string; integration: string | null };

/**
 * Why a connector's sign-in cannot start on this server, or null when it can. `integration` is
 * the platform key a platform admin enters to set it up; null when no key on this box does.
 */
export function connectorSetupGap(
  server: Pick<McpServerAccess, "slug" | "oauth_setup_state">,
  instance: Instance | undefined,
): ConnectorSetupGap | null {
  if (server.oauth_setup_state !== "unsupported") return null;
  const integration = integrationFor(instance, "connectors", server.slug);
  if (!integration || integration.state === "on") {
    return { text: "This server has no OAuth client for this connector.", integration: null };
  }
  const missing = missingFieldsPhrase(integration);
  return {
    text: `${integration.label} is not set up on this server${missing ? `: ${missing} missing` : ""}.`,
    integration: integration.id,
  };
}

/** The Admin search that opens one integration under Platform keys, and where to come back to. */
export function setupSearch(
  integrationId: string,
  returnTo?: string,
): { tab: "instance"; integration: string; return_to?: string } {
  return {
    tab: "instance",
    integration: integrationId,
    ...(returnTo ? { return_to: returnTo } : {}),
  };
}

/** A `return_to` the app may follow: a path on this origin, never another site. */
export function safeReturnTo(value: string | undefined): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : null;
}
