import { installedConnectors } from "./index.js";
import type { ConnectorEntry } from "./registry.js";

/** The role of a connector that holds the operator's long-lived records. */
export const SYSTEM_OF_RECORD = "system_of_record";

function entryOf(serverRef: string | Record<string, unknown>): ConnectorEntry | null {
  const connectors = installedConnectors();
  if (typeof serverRef !== "string") {
    return connectors.forServer(serverRef);
  }
  return connectors.bySlug(serverRef) ?? connectors.byId(serverRef);
}

/** Whether the builder may search a connected login of this server. */
export function isSearchable(serverRef: string | Record<string, unknown>): boolean {
  return entryOf(serverRef)?.manifest.builder?.searchable === true;
}

/** Whether the server holds the operator's long-lived records. */
export function isSystemOfRecord(serverRef: string | Record<string, unknown>): boolean {
  return entryOf(serverRef)?.manifest.builder?.role === SYSTEM_OF_RECORD;
}

/** The connector the builder searches when it names none: the first searchable one. */
export function defaultSearchServer(): string {
  return installedConnectors().entries().find((entry) => entry.manifest.builder?.searchable)?.manifest.slug ?? "";
}

function names(predicate: (entry: ConnectorEntry) => boolean): string {
  const found = installedConnectors().entries().filter(predicate).map((entry) => entry.manifest.display_name);
  return found.length ? found.join(", ") : "none installed";
}

/** The display names of the searchable workspaces, for the builder prompt. */
export function searchableNames(): string {
  return names((entry) => entry.manifest.builder?.searchable === true);
}

/** The display names of the systems of record, for the builder prompt. */
export function systemOfRecordNames(): string {
  return names((entry) => entry.manifest.builder?.role === SYSTEM_OF_RECORD);
}

/** One line per connector that gives the builder guidance, for the builder prompt. */
export function builderGuidance(): string {
  return installedConnectors()
    .entries()
    .flatMap((entry) => (entry.manifest.builder?.guidance ? [`- ${entry.manifest.display_name}: ${entry.manifest.builder.guidance}`] : []))
    .join("\n");
}

/** Where a guild keeps what, told when the builder searches or connects a workspace. */
export function storageHint(): string {
  const systems = systemOfRecordNames();
  const examples = systems === "none installed" ? "" : ` such as ${systems}`;
  return `External workspaces${examples} hold long-lived records the operator already owns (CRM rows, wikis, canonical project tables). Queues, seen-sets, wake state, drafts, playbooks the guild revises, and Memory stay local: notes at organisation, guild, or agent scope, and typed collections at the organisation that the guild or its agents are granted.`;
}
