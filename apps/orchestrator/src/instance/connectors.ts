import { installedConnectors } from "../connectors/index.js";
import { serverManifest } from "../connectors/load.js";
import { authFields } from "../connectors/manifest.js";
import type { AuthField, Manifest } from "../db/schema/index.js";
import {
  connectorIntegrationId,
  setConnectorIntegrations,
  type Integration,
  type IntegrationField,
} from "./integrations.js";
import { listMcpServers } from "../db/connectors.js";
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

export type PlatformConnector = { id: string; slug: string; manifest: Manifest };

let rows: PlatformConnector[] = [];

/**
 * The box's connectors with their effective manifests: the installed ones, and the platform rows
 * the database holds beside them (registry installs without code, hand-made servers), as of the
 * last refresh.
 */
export function platformConnectors(): PlatformConnector[] {
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
  const listed = (await listMcpServers(db)).filter((row) => !row.owner_org_id);
  const next: PlatformConnector[] = [];
  for (const row of listed) {
    const manifest = serverManifest(row);
    if (manifest) {
      next.push({ id: String(row.id), slug: String(row.slug), manifest });
    }
  }
  rows = next;
  setConnectorIntegrations(
    platformConnectors().flatMap((item) => {
      const integration = connectorIntegration(item.manifest);
      return integration ? [integration] : [];
    }),
  );
}
