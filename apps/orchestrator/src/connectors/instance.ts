import { installedIntegrations, integrationState } from "../instance/integrations.js";
import { installedConnectors } from "./index.js";
import { authFields, type Manifest } from "./manifest.js";
import type { Credentials } from "./types.js";

/**
 * The instance key that serves a connector's platform login: the variable its manifest's
 * `auth.instance` names, while that integration is on. Null otherwise.
 */
export function instanceKey(manifest: Manifest, env: NodeJS.ProcessEnv = process.env): string | null {
  const instance = manifest.auth.instance;
  if (!instance) {
    return null;
  }
  const integration = installedIntegrations().find((item) => item.id === instance.integration);
  if (!integration || integrationState(integration, env) !== "on") {
    return null;
  }
  const value = (env[instance.variable] ?? "").trim();
  return value || null;
}

/** A platform login's credentials, resolved from the instance key at call time; empty while it is off. */
export function instanceCredentials(manifest: Manifest, env: NodeJS.ProcessEnv = process.env): Credentials {
  const key = instanceKey(manifest, env);
  const field = authFields(manifest)[0]?.name ?? "token";
  return key ? { [field]: key } : {};
}

/** Every instance key a connector's platform login uses, for run redaction: `platform_<variable>`. */
export function instanceRedactions(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const redactions: Record<string, string> = {};
  for (const entry of installedConnectors().entries()) {
    const instance = entry.manifest.auth.instance;
    const key = instance ? instanceKey(entry.manifest, env) : null;
    if (instance && key) {
      redactions[`platform_${instance.variable.toLowerCase()}`] = key;
    }
  }
  return redactions;
}
