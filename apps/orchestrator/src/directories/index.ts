import { omitMemoryArchive } from "../memory/archive.js";
import { environmentCatalog } from "../scripts/validation.js";

export type DirectoryNotes = {
  listPrivateNotes(orgSlug: string, guildName: string, agentName: string, prefix: string): string[];
  listSharedNotes(orgSlug: string, guildName: string, prefix: string): string[];
};

export function collectDirectoryListing(
  notes: DirectoryNotes,
  orgSlug: string,
  guildName: string,
  agentName: string,
  options: {
    secrets?: Array<Record<string, unknown>> | null | undefined;
    scripts?: unknown[] | null | undefined;
  } = {},
): Record<string, unknown> {
  return {
    private: omitMemoryArchive(notes.listPrivateNotes(orgSlug, guildName, agentName, "")),
    shared: notes.listSharedNotes(orgSlug, guildName, ""),
    scripts: [...(options.scripts ?? [])],
    environment: environmentCatalog(options.secrets),
  };
}
