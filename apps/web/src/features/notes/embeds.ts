import type { EmbeddableNote, EmbeddableNotes } from "../../api/types/notes";
import type { Collection } from "../../api/types/tables";
import { embedKind, embedMarkup, linkMarkup } from "@guildsrun/ui";
import type { EmbedMode, InsertKind } from "@guildsrun/ui";
import { isUnreached, listedItems } from "../access/listedItems";

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
 * What a list of embeddable notes tells of the note an embed names: the reader reads it, and here
 * it is; the reader cannot read it; or the list cannot tell, being the operator's list at its cap
 * without the note, so only reading the note by its path tells.
 */
export type NoteEmbed =
  { state: "readable"; note: EmbeddableNote } | { state: "unreadable" } | { state: "unknown" };

/**
 * The note an embed names, as a list of embeddable notes tells it. In the operator's list, every
 * listed note is readable. In an agent's sections, a note is readable when a row reaches the
 * agent; the sections hold every note the agent reaches, so one missing from them is unreadable.
 */
export function noteEmbed(path: string, notes: EmbeddableNotes): NoteEmbed {
  if ("own" in notes) {
    const note = listedItems(notes).find((item) => item.display_path === path);
    return note && !isUnreached(note) ? { state: "readable", note } : { state: "unreadable" };
  }
  const note = notes.find((item) => item.display_path === path);
  if (note) return { state: "readable", note };
  return notes.length >= noteListLimit ? { state: "unknown" } : { state: "unreadable" };
}

/**
 * What is known of where a Task's embeds lead: the embeds the server found broken in the saved
 * Task, the notes the Task can embed, and the tables the operator can see in the organisation
 * (each `undefined` until it loads).
 */
export type KnownEmbeds = {
  serverBroken: readonly string[];
  notes: EmbeddableNotes | undefined;
  collections: readonly Pick<Collection, "name">[] | undefined;
  orgId: string;
};

/**
 * Whether an embed is not reachable. The server's check of the saved Task, made as the agent,
 * decides; embeds only in the draft are checked against the notes the Task can embed, as
 * `noteEmbed` reads them, and the tables the operator can see.
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
  return known.notes ? noteEmbed(path, known.notes).state === "unreadable" : false;
}
