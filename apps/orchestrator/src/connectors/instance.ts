import { encryptPayload } from "../credentials/crypto.js";
import type { AuthField, Manifest } from "../db/schema/index.js";
import { replacesGithubApp } from "../instance/changes.js";
import {
  connectorIntegrationId,
  GITHUB_APP,
  GITHUB_SERVER_ID,
  installedIntegrations,
  integrationState,
  integrationValue,
  integrationValues,
  setConnectorIntegrations,
  type Integration,
  type IntegrationField,
  type IntegrationSources,
} from "../instance/integrations.js";
import { newId } from "../lib/ids.js";
import { installedConnectors } from "./index.js";
import { authFields } from "./manifest.js";
import { listServers } from "./servers.js";
import type { Credentials } from "./types.js";
import { connectMcp, disconnectServerConnections, getMcpConnectionForOwner, saveMcpConnection } from "../db/mcp.js";
import type { Queryable } from "../db/pg.js";

/**
 * What a connector's manifest holds at instance level of its own: a platform key (token auth
 * with `auth.instance.own`) or an OAuth client (`configured` with no provider). A connector the
 * box ships may instead name one of the box's integrations; that is not "own".
 */
export function ownInstanceKind(manifest: Manifest): "key" | "client" | null {
  const instance = manifest.auth.instance;
  if (instance && "own" in instance) {
    return "key";
  }
  const oauth = manifest.auth.oauth;
  if (manifest.auth.kind === "oauth" && oauth?.strategy === "configured" && !oauth.provider) {
    return "client";
  }
  return null;
}

function fieldOf(field: AuthField): IntegrationField {
  return {
    name: field.name,
    label: field.label,
    secret: field.secret !== false,
    ...(field.optional ? { optional: true } : {}),
    ...(field.multiline ? { multiline: true } : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
  };
}

/**
 * The integration a connector declares of its own, `connector:<slug>`: its login fields as a
 * platform key, or the client id and secret of its OAuth client. Null for a connector that
 * declares none.
 */
export function connectorIntegration(manifest: Manifest): Integration | null {
  const kind = ownInstanceKind(manifest);
  if (kind === null) {
    return null;
  }
  const id = connectorIntegrationId(manifest.slug);
  const name = manifest.display_name;
  if (kind === "key") {
    return {
      id,
      label: name,
      enables: `${name}'s platform login, for every organisation without a login of its own`,
      source: "store",
      fields: authFields(manifest).map(fieldOf),
      provides: { connectors: [manifest.slug] },
    };
  }
  return {
    id,
    label: `${name} OAuth client`,
    enables: `${name} logins, through an OAuth client registered for this box`,
    source: "store",
    fields: [
      { name: "client_id", label: "Client ID" },
      { name: "client_secret", label: "Client secret", secret: true },
    ],
    provides: { connectors: [manifest.slug] },
  };
}

type PlatformConnector = { id: string; slug: string; manifest: Manifest };

let rows: PlatformConnector[] = [];

/**
 * The box's connectors with their effective manifests: the installed ones, and the platform rows
 * the database holds beside them (registry installs without code, hand-made servers), as of the
 * last refresh.
 */
function platformConnectors(): PlatformConnector[] {
  const seen = new Map<string, PlatformConnector>();
  for (const entry of installedConnectors().entries()) {
    seen.set(entry.id, { id: entry.id, slug: entry.manifest.slug, manifest: entry.manifest });
  }
  for (const row of rows) {
    if (!seen.has(row.id)) {
      seen.set(row.id, row);
    }
  }
  return [...seen.values()];
}

/**
 * Reads the platform rows and lists the integrations their manifests declare of their own, so
 * Platform keys offers them. Runs at boot and after a connector is installed, changed, or removed.
 */
export async function refreshConnectorIntegrations(db: Queryable): Promise<void> {
  rows = (await listServers(db, { owner: "platform" })).map((row) => ({ id: row.id, slug: row.slug, manifest: row.manifest }));
  setConnectorIntegrations(
    platformConnectors().flatMap((item) => {
      const integration = connectorIntegration(item.manifest);
      return integration ? [integration] : [];
    }),
  );
}

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
          ciphertext: login.ciphertext,
          nonce: login.nonce,
          status,
          accountHint: login.account_hint ?? "",
          oauthState: null,
        },
        now,
      );
    }
  }
}

/** The pool whose tool listings an instance key change makes stale. */
export type ToolListings = { forgetListings(): void };

/** The services an instance key change is applied with: the key platform logins are sealed with, and the pool. */
export type PlatformLoginServices = { masterKey?: Buffer | undefined; mcp?: ToolListings | undefined };

/** An integration's values before and after a write or a removal, null where it has none. */
export type IntegrationValuesChange = {
  integrationId: string;
  previous: Record<string, string> | null;
  next: Record<string, string> | null;
};

/**
 * What the process does once an instance key changed: platform logins follow their integration,
 * and a GitHub App that is replaced or removed disconnects every login installed with it, since
 * their installations belong to the old App. The pool lists every login's tools again. Returns
 * how many logins it disconnected.
 */
export async function applyKeyChange(
  db: Queryable,
  services: PlatformLoginServices,
  change: IntegrationValuesChange,
  now = new Date(),
): Promise<{ disconnected: number }> {
  await syncInstanceLogins(db, services.masterKey, now);
  let disconnected = 0;
  if (change.integrationId === GITHUB_APP.id && replacesGithubApp(change.previous, change.next)) {
    disconnected = await disconnectServerConnections(db, GITHUB_SERVER_ID, now);
  }
  services.mcp?.forgetListings();
  return { disconnected };
}
