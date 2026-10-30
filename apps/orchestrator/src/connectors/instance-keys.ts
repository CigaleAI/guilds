import type { Queryable } from "../db/pg.js";
import { assertKeyChangeConfirmed } from "../instance/changes.js";
import {
  installedIntegrations,
  integrationStatuses,
  type Integration,
  type IntegrationStatus,
} from "../instance/integrations.js";
import { InstanceKeyError, validateKeyValues, type InstanceKeys } from "../instance/keys.js";
import { applyKeyChange } from "./instance.js";
import { installedManifests } from "./servers.js";

/** The pool whose tool listings an instance key change makes stale. */
export type ToolListings = { forgetListings(): void };

/**
 * The services an instance key write runs with: the encrypted store, the integrations the box may
 * switch on (the installed ones when absent), the key platform logins are sealed with, and the pool.
 */
export type InstanceKeyServices = {
  keys: InstanceKeys;
  integrations?: readonly Integration[] | undefined;
  masterKey?: Buffer | undefined;
  mcp?: ToolListings | undefined;
};

/** A store integration's values as the instance admin sends them, and whether they confirmed stranding logins. */
export type InstanceKeyWrite = { integrationId: string; values: unknown; confirmed: boolean };

/** A store integration whose values the instance admin removes, and whether they confirmed stranding logins. */
export type InstanceKeyRemoval = { integrationId: string; confirmed: boolean };

/** A store integration and the values it is given. */
export type InstanceKeyValues = { integration: Integration; values: Record<string, string> };

/** An integration once its values changed, as the instance admin sees it, and how many logins the change disconnected. */
export type InstanceKeyChange = { integration: IntegrationStatus; disconnected: number };

function integrationsOf(services: InstanceKeyServices): readonly Integration[] {
  return services.integrations ?? installedIntegrations();
}

function integrationOf(services: InstanceKeyServices, id: string): Integration {
  const integration = integrationsOf(services).find((item) => item.id === id);
  if (!integration) {
    throw new InstanceKeyError("Not Found", 404);
  }
  return integration;
}

/** An integration's state as the instance admin sees it: with when and by whom its row was written. */
function auditedStatus(services: InstanceKeyServices, id: string): IntegrationStatus {
  const status = integrationStatuses(integrationsOf(services), installedManifests(), undefined, {
    audit: true,
  }).find((item) => item.id === id);
  if (!status) {
    throw new InstanceKeyError("Not Found", 404);
  }
  return status;
}

/**
 * Stores an integration's values for `userId` and applies the change in this process: platform
 * logins follow it, and a replaced GitHub App disconnects the logins installed with the old one.
 */
export async function storeInstanceKey(
  db: Queryable,
  services: InstanceKeyServices,
  key: InstanceKeyValues,
  userId: string,
): Promise<{ disconnected: number }> {
  const { previous } = await services.keys.put(key.integration, key.values, userId);
  const ctx = { db, masterKey: services.masterKey, mcp: services.mcp };
  return applyKeyChange(ctx, key.integration.id, previous, key.values);
}

/**
 * Writes a store integration's values for `userId`: checked against its fields, refused unconfirmed
 * while it strands logins, stored and applied in this process.
 */
export async function writeInstanceKey(
  db: Queryable,
  services: InstanceKeyServices,
  write: InstanceKeyWrite,
  userId: string,
): Promise<InstanceKeyChange> {
  const integration = integrationOf(services, write.integrationId);
  const values = validateKeyValues(integration, write.values ?? {});
  if (!write.confirmed) {
    await assertKeyChangeConfirmed(db, integration, services.keys.current(integration.id), values);
  }
  const { disconnected } = await storeInstanceKey(db, services, { integration, values }, userId);
  return { integration: auditedStatus(services, integration.id), disconnected };
}

/**
 * Removes a store integration's values: refused for one read from the environment, and
 * unconfirmed while it strands logins; the removal is applied in this process.
 */
export async function removeInstanceKey(
  db: Queryable,
  services: InstanceKeyServices,
  removal: InstanceKeyRemoval,
): Promise<InstanceKeyChange> {
  const integration = integrationOf(services, removal.integrationId);
  if (integration.source !== "store") {
    throw new InstanceKeyError(`${integration.label} is read from the environment`);
  }
  if (!removal.confirmed) {
    await assertKeyChangeConfirmed(db, integration, services.keys.current(integration.id), null);
  }
  const { previous } = await services.keys.remove(integration.id);
  const ctx = { db, masterKey: services.masterKey, mcp: services.mcp };
  const { disconnected } = await applyKeyChange(ctx, integration.id, previous, null);
  return { integration: auditedStatus(services, integration.id), disconnected };
}
