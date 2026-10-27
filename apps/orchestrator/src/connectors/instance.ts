import { encryptPayload } from "../credentials/crypto.js";
import { connectorIntegration, platformConnectors } from "../instance/connectors.js";
import {
  connectorIntegrationId,
  installedIntegrations,
  integrationState,
  integrationValue,
  integrationValues,
  type Integration,
  type IntegrationSources,
} from "../instance/integrations.js";
import { newId } from "../lib/ids.js";
import { authFields, type Manifest } from "./manifest.js";
import type { Credentials } from "./types.js";
import { connectMcp, getMcpConnectionForOwner, saveMcpConnection } from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";

/** The integration a manifest's `auth.instance` reads: a shipped one by id, or the connector's own. */
function instanceIntegration(manifest: Manifest): Integration | null {
  const instance = manifest.auth.instance;
  if (!instance) {
    return null;
  }
  const id = "integration" in instance ? instance.integration : connectorIntegrationId(manifest.slug);
  const listed = installedIntegrations().find((item) => item.id === id);
  if (listed) {
    return listed;
  }
  return "own" in instance ? connectorIntegration(manifest) : null;
}

/**
 * The instance key that serves a connector's platform login: the field its manifest's
 * `auth.instance` names on that integration, or the first login field of its own key, while
 * the integration is on. Null otherwise.
 */
export function instanceKey(manifest: Manifest, sources?: IntegrationSources): string | null {
  const instance = manifest.auth.instance;
  const integration = instanceIntegration(manifest);
  if (!instance || !integration || integrationState(integration, sources) !== "on") {
    return null;
  }
  const field = "integration" in instance ? instance.field : (authFields(manifest)[0]?.name ?? "token");
  return integrationValue(integration, field, sources) || null;
}

/** A platform login's credentials, resolved from the instance key at call time; empty while it is off. */
export function instanceCredentials(manifest: Manifest, sources?: IntegrationSources): Credentials {
  const instance = manifest.auth.instance;
  if (!instance) {
    return {};
  }
  if ("integration" in instance) {
    const key = instanceKey(manifest, sources);
    const field = authFields(manifest)[0]?.name ?? "token";
    return key ? { [field]: key } : {};
  }
  const integration = instanceIntegration(manifest);
  return (integration && integrationValues(integration, sources)) || {};
}

/**
 * Every instance key a connector's platform login uses, for run redaction: `platform_<slug>_<field>`,
 * the named field of a shipped integration, or each login field of the connector's own key.
 */
export function instanceRedactions(sources?: IntegrationSources): Record<string, string> {
  const redactions: Record<string, string> = {};
  for (const item of platformConnectors()) {
    const instance = item.manifest.auth.instance;
    if (!instance) {
      continue;
    }
    if ("integration" in instance) {
      const key = instanceKey(item.manifest, sources);
      if (key) {
        redactions[`platform_${item.slug}_${instance.field}`] = key;
      }
      continue;
    }
    for (const [field, value] of Object.entries(instanceCredentials(item.manifest, sources))) {
      if (typeof value === "string" && value) {
        redactions[`platform_${item.slug}_${field}`] = value;
      }
    }
  }
  return redactions;
}

/**
 * Gives every connector an instance key serves a platform login while that integration is on:
 * an empty encrypted payload, since the key is read at call time, and an enabled platform
 * binding on it, which every scope inherits and any scope may turn off. While the integration
 * is off, that login is disconnected. Runs at boot and after every instance key write.
 */
export async function syncInstanceLogins(
  db: Queryable,
  masterKey?: Buffer,
  now = new Date(),
  sources?: IntegrationSources,
): Promise<void> {
  for (const item of platformConnectors()) {
    if (!item.manifest.auth.instance) {
      continue;
    }
    const on = instanceKey(item.manifest, sources) !== null;
    const login = await getMcpConnectionForOwner(db, item.id, "platform", null);
    if (login === null) {
      if (on) {
        const [ciphertext, nonce] = encryptPayload({}, masterKey);
        await connectMcp(db,
          {
            connectionId: newId("conn"),
            bindingId: newId("bind"),
            serverId: item.id,
            ownerScope: "platform",
            ownerId: null,
            ciphertext,
            nonce,
            status: "connected",
            accountHint: "platform key",
          },
          now,
        );
      }
      continue;
    }
    const status = on ? "connected" : "disconnected";
    if (login.status !== status) {
      await saveMcpConnection(db,
        login.id,
        {
          ciphertext: login.ciphertext as Buffer,
          nonce: login.nonce as Buffer,
          status,
          accountHint: login.account_hint ?? "",
          oauthState: null,
        },
        now,
      );
    }
  }
}
