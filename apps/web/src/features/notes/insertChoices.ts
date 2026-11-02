import type { AgentViewerMode, InsertKind } from "@guildsrun/ui";
import type { EmbeddableNote, EmbeddableNotes, ListedEmbeddableNote } from "../../api/types/notes";
import type { Collection } from "../../api/types/tables";
import { homeLabel } from "../access/listedItems";
import { collectionDisplayPath } from "./embeds";

/** One note or table the insert picker offers, by its display path. */
export type Choice = {
  path: string;
  title: string;
  meta: string;
  note?: EmbeddableNote;
  collection?: Collection;
  /** How the Task's agent reaches the note, when the picker lists the agent's sections. */
  mode?: AgentViewerMode;
};

/** A named group of choices; a section says `empty` when it holds none. */
export type ChoiceGroup = { label: string; empty?: string; choices: Choice[] };

/**
 * The choices the picker shows: as a list, which leaves out a group with no choice, or as an
 * agent's page's two sections, which keeps both whether or not they hold a choice.
 */
export type ChoiceGroups = { layout: "list" | "sections"; groups: ChoiceGroup[] };

/** What the picker lists: the notes the Task or note can embed, and the organisation's tables. */
export type ChoiceSources = {
  notes: EmbeddableNotes | undefined;
  collections: readonly Collection[] | undefined;
  orgId: string;
};

/** Why a note the Task's agent does not reach cannot be inserted, as its greyed row says. */
export const unreachedChoiceReason =
  "No row reaches this agent: give it access from the note's access list to insert it.";

/** Whether a choice can be inserted: every one but a note the Task's agent does not reach. */
export function isInsertable(choice: Choice): boolean {
  return choice.mode !== "none";
}

function matches(choice: Choice, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${choice.title} ${choice.meta}`.toLowerCase().includes(needle);
}

function noteChoice(note: EmbeddableNote): Choice {
  return { path: note.display_path, title: note.key, meta: note.title ?? "", note };
}

/** A note homed in the agent's guild, with the agent's mode. */
function ownNoteChoice(note: ListedEmbeddableNote): Choice {
  return { ...noteChoice(note), mode: note.viewer_mode };
}

/** A note shared with the agent's guild, with the agent's mode, naming its home after its title. */
function sharedNoteChoice(note: ListedEmbeddableNote): Choice {
  const meta = [note.title, homeLabel(note)].filter(Boolean).join(" · ");
  return { ...noteChoice(note), meta, mode: note.viewer_mode };
}

function tableGroups(collections: readonly Collection[], orgId: string): ChoiceGroups {
  const choices = collections.map((collection) => ({
    path: collectionDisplayPath(orgId, collection),
    title: collection.name,
    meta: collection.purpose,
    collection,
  }));
  return { layout: "list", groups: [{ label: "Tables", choices }] };
}

function noteGroups(notes: EmbeddableNotes): ChoiceGroups {
  if (!("own" in notes)) {
    return { layout: "list", groups: [{ label: "Notes", choices: notes.map(noteChoice) }] };
  }
  return {
    layout: "sections",
    groups: [
      {
        label: "Guild notes",
        empty: "Notes made in this agent's guild appear here.",
        choices: notes.own.map(ownNoteChoice),
      },
      {
        label: "Shared with this guild",
        empty:
          "Notes from elsewhere that a row for this guild, its agents or the organisation reaches appear here.",
        choices: notes.shared.map(sharedNoteChoice),
      },
    ],
  };
}

/** The choices for a kind that match the query; undefined while they load. */
export function choiceGroups(
  kind: InsertKind | null,
  sources: ChoiceSources,
  query: string,
): ChoiceGroups | undefined {
  const listed =
    kind === "note"
      ? sources.notes && noteGroups(sources.notes)
      : sources.collections && tableGroups(sources.collections, sources.orgId);
  if (!listed) return undefined;
  const groups = listed.groups.map((group) => ({
    ...group,
    choices: group.choices.filter((choice) => matches(choice, query)),
  }));
  return {
    layout: listed.layout,
    groups: listed.layout === "list" ? groups.filter((group) => group.choices.length > 0) : groups,
  };
}

/** Whether the groups shown hold no choice at all. */
export function holdsNoChoice(groups: ChoiceGroups): boolean {
  return groups.groups.every((group) => group.choices.length === 0);
}

/**
 * The insertable choice at the selected path among the groups shown; undefined when none is
 * selected or shown, or the one selected cannot be inserted.
 */
export function selectedChoice(
  groups: ChoiceGroups | undefined,
  selected: string | null,
): Choice | undefined {
  return groups?.groups
    .flatMap((group) => group.choices)
    .find((choice) => choice.path === selected && isInsertable(choice));
}
