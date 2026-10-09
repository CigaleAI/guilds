import { omitMemoryArchive } from "../memory/archive.js";
import { environmentCatalog } from "../scripts/validation.js";

export type DirectoryNotes = {
  listNotes(
    scope: "private" | "shared",
    orgSlug: string,
    guildName: string,
    agentName: string,
    prefix: string,
  ): string[];
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
    private: omitMemoryArchive(notes.listNotes("private", orgSlug, guildName, agentName, "")),
    shared: notes.listNotes("shared", orgSlug, guildName, agentName, ""),
    scripts: [...(options.scripts ?? [])],
    environment: environmentCatalog(options.secrets),
  };
}
