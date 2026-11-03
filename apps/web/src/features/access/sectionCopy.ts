import type { ListedKind, ReachSubject } from "../../api/types/access";

/** The words of a page's two sections of notes or files: their labels, and what each says when it holds nothing. */
type SectionCopy = {
  /** The section of the items homed in the page's guild. */
  ownLabel: string;
  ownEmpty: string;
  /** The section of the items homed elsewhere that a row for the guild reaches. */
  sharedLabel: string;
  sharedEmpty: string;
  /** What a section says when a search leaves nothing in it. */
  noMatch: string;
};

const itemWords: Record<ListedKind, { plural: string; capitalised: string }> = {
  note: { plural: "notes", capitalised: "Notes" },
  file: { plural: "files", capitalised: "Files" },
};

/** Where the items of the own section were made, as a guild's or an agent's page names it. */
const homeWords: Record<ReachSubject["type"], string> = {
  guild: "this guild",
  agent: "this agent's guild",
};

/** The section words for a kind of item on a guild's or an agent's page. */
export function sectionCopy(kind: ListedKind, page: ReachSubject["type"]): SectionCopy {
  const { plural, capitalised } = itemWords[kind];
  return {
    ownLabel: `Guild ${plural}`,
    ownEmpty: `${capitalised} made in ${homeWords[page]} appear here.`,
    sharedLabel: "Shared with this guild",
    sharedEmpty: `${capitalised} from elsewhere that a row for this guild, its agents or the organisation reaches appear here.`,
    noMatch: `No ${plural} match.`,
  };
}
