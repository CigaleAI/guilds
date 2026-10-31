import type { RegistryConnector, RegistryConnectorAcceptance } from "../../api/types/admin";

/**
 * What the registry dialog offers for a connector: `install` when the box lacks it, `update` when a
 * registry install trails the newest version, `current` when it is up to date, and `elsewhere` when
 * the slug is installed from another source, which the registry leaves alone.
 */
export type RegistryAction = "install" | "update" | "current" | "elsewhere";

export function registryAction(
  entry: Pick<RegistryConnector, "version" | "installed">,
): RegistryAction {
  if (!entry.installed) return "install";
  if (entry.installed.source !== "registry") return "elsewhere";
  return entry.installed.version === entry.version ? "current" : "update";
}

/** What installing or updating a registry connector sends: its slug and what the admin accepts of it. */
export function acceptanceOf(
  entry: Pick<RegistryConnector, "slug" | "verified" | "experimental">,
): RegistryConnectorAcceptance {
  return {
    slug: entry.slug,
    unverified: !entry.verified,
    experimental: entry.experimental === true,
  };
}
