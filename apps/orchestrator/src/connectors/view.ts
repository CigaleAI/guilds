import { existsSync } from "node:fs";
import path from "node:path";
import type { AuthField } from "../db/schema/index.js";
import { installedConnectors } from "./index.js";
import { authFields } from "./manifest.js";
import type { ConnectorEntry, ConnectorSource } from "./registry.js";
import type { LoadedConnector } from "./load.js";

/** What the API says about a server beside its row: how to sign in, where it came from, and its mark. */
export type ConnectorFacts = {
  auth_fields: AuthField[];
  /** The JSON Schema of what a login stores beside its credentials, or null when it stores nothing. */
  settings_schema: Record<string, unknown> | null;
  source: ConnectorSource;
  verified: boolean;
  /** The registry's mark for a connector still being tried out. */
  experimental: boolean;
  publisher: string;
  logo_url: string | null;
};

const LOGO = "logo.svg";

/** The connector's `logo.svg` on disk, or null when its folder has none. */
export function logoPath(entry: ConnectorEntry | null): string | null {
  if (!entry?.folder) {
    return null;
  }
  const file = path.join(entry.folder, LOGO);
  return existsSync(file) ? file : null;
}

/**
 * The facts of a server: from its installed entry (a folder in the image, or a registry connector
 * with code), else from its row (a registry connector without code, or one made on this box).
 */
export function connectorFacts(server: LoadedConnector): ConnectorFacts {
  const entry = installedConnectors().forServer(server);
  const experimental = server.experimental;
  if (entry === null) {
    const source: ConnectorSource = server.source === "registry" ? "registry" : "local";
    return {
      auth_fields: authFields(server.manifest),
      settings_schema: server.manifest.settings_schema ?? null,
      source,
      verified: source === "registry" && server.verified,
      experimental,
      publisher: source === "registry" ? server.publisher : "",
      logo_url: null,
    };
  }
  return {
    auth_fields: authFields(entry.manifest),
    settings_schema: entry.manifest.settings_schema ?? null,
    source: entry.source,
    verified: entry.verified,
    experimental,
    publisher: entry.publisher,
    logo_url: logoPath(entry) ? `/api/mcp/servers/${encodeURIComponent(entry.id)}/logo` : null,
  };
}
