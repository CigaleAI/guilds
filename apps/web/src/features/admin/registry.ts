import type { RegistryConnector } from "../../api/types";

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
