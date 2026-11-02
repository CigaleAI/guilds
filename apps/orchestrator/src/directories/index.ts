import type { SecretRef } from "../db/schema/index.js";
import { omitMemoryArchive } from "../memory/archive.js";
import type { ScriptCatalogItem } from "../scripts/catalog.js";
import { environmentCatalog, type EnvironmentEntry } from "../scripts/validation.js";

export type DirectoryNotes = {
  listPrivateNotes(orgSlug: string, guildName: string, agentName: string, prefix: string): string[];
  listSharedNotes(orgSlug: string, guildName: string, prefix: string): string[];
};

/**
 * What an agent can find at the start of a run: its private notes without the memory archive, its
 * guild's shared notes, its scripts and the secrets its environment holds.
 */
export type DirectoryListing = {
  private: string[];
  shared: string[];
  scripts: ScriptCatalogItem[];
  environment: EnvironmentEntry[];
};

export function collectDirectoryListing(
  notes: DirectoryNotes,
  orgSlug: string,
  guildName: string,
  agentName: string,
  options: {
    secrets?: SecretRef[] | null | undefined;
    scripts?: ScriptCatalogItem[] | null | undefined;
  } = {},
): DirectoryListing {
  return {
    private: omitMemoryArchive(notes.listPrivateNotes(orgSlug, guildName, agentName, "")),
    shared: notes.listSharedNotes(orgSlug, guildName, ""),
    scripts: [...(options.scripts ?? [])],
    environment: environmentCatalog(options.secrets),
  };
}
