import type { EmbeddableNote, NoteLevel } from "../../api/types/notes";
import type { Collection } from "../../api/types/tables";
import { embedKind, embedMarkup, linkMarkup } from "@guildsrun/ui";
import type { EmbedMode, InsertKind } from "@guildsrun/ui";

export type NoteGroup = { level: NoteLevel; label: string; notes: EmbeddableNote[] };

const levelLabel: Record<NoteLevel, string> = {
  agent: "This agent",
  guild: "Guild",
  org: "Organisation",
};

/** Where an agent sits: its organisation, its guild, and its own id. */
export type AgentLocation = { orgId: string; guildId: string; agentId: string };

/** The notes a Task can embed: the agent's own, its guild's and the organisation's. */
export function pickableNotes(notes: readonly EmbeddableNote[], scope: AgentLocation): NoteGroup[] {
  const prefix: Record<NoteLevel, string> = {
    agent: `org/${scope.orgId}/agents/${scope.agentId}/`,
    guild: `org/${scope.orgId}/guilds/${scope.guildId}/`,
    org: `org/${scope.orgId}/`,
  };
  const groups: NoteGroup[] = (["agent", "guild", "org"] as const).map((level) => ({
    level,
    label: levelLabel[level],
    notes: [],
  }));
  for (const note of notes) {
    if (!note.display_path.startsWith(prefix[note.level])) continue;
    if (!note.key.endsWith(".md")) continue;
    groups.find((group) => group.level === note.level)?.notes.push(note);
  }
  return groups.filter((group) => group.notes.length > 0);
}

export function collectionDisplayPath(orgId: string, collection: Pick<Collection, "name">): string {
  return `org/${orgId}/collections/${collection.name}`;
}

/** A column as a Task names it: `table.column` in code, so the agent reads it as a machine name. */
export function columnMarkup(table: string, column: string): string {
  return `\`${table}.${column}\``;
}

/** What the operator chose in the insert picker: a note's or table's path, and for a column its table's name. */
export type InsertPick = { path: string; table: string; column: string | null; mode: EmbedMode };

const markupByKind: Record<InsertKind, (pick: InsertPick) => string | null> = {
  note: (pick) => linkMarkup(pick.path, pick.mode),
  table: (pick) => embedMarkup(pick.path),
  column: (pick) => (pick.column ? columnMarkup(pick.table, pick.column) : null),
};

/** The text a pick inserts: a note embedded or referenced, a table embedded, a column by name. */
export function insertMarkup(kind: InsertKind, pick: InsertPick): string | null {
  return markupByKind[kind](pick);
}

/** The server lists at most this many notes; past it, a note missing from the list may still exist. */
const noteListLimit = 500;

/**
 * What is known of where a Task's embeds lead: the embeds the server found broken in the saved
 * Task, and the notes and tables the operator can see in the organisation (each `undefined` until
 * it loads).
 */
export type KnownEmbeds = {
  serverBroken: readonly string[];
  notes: readonly EmbeddableNote[] | undefined;
  collections: readonly Pick<Collection, "name">[] | undefined;
  orgId: string;
};

/**
 * Whether an embed is not reachable. The server's check of the saved Task, made as the agent,
 * decides; embeds only in the draft are checked against the notes and tables the operator can see.
 */
export function embedIsBroken(path: string, known: KnownEmbeds): boolean {
  if (known.serverBroken.includes(path)) return true;
  if (embedKind(path) === "table") {
    return known.collections
      ? !known.collections.some(
          (collection) => collectionDisplayPath(known.orgId, collection) === path,
        )
      : false;
  }
  if (!known.notes || known.notes.length >= noteListLimit) return false;
  return !known.notes.some((note) => note.display_path === path);
}
