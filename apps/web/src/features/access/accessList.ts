import type { AccessEntry, AccessListMode, AccessRow, AccessSubjectType } from "../../api/types";

/** The modes a row of each subject type takes: only an agent row can shut its agent out. */
export const accessModes: Record<AccessSubjectType, readonly AccessListMode[]> = {
  org: ["read", "write"],
  guild: ["read", "write"],
  agent: ["none", "read", "write"],
};

export const accessModeLabel: Record<AccessListMode, string> = {
  none: "None",
  read: "Read",
  write: "Read & write",
};

type Subject = { type: AccessSubjectType; id: string };

/** One key per subject, as an access list holds at most one row for each. */
export function subjectKey(subject: Subject): string {
  return `${subject.type}:${subject.id}`;
}

function isSubject(row: Subject, subject: Subject): boolean {
  return subjectKey(row) === subjectKey(subject);
}

/** The rows a list sends, without the names it was read with. */
function rowsOf(entries: readonly AccessEntry[]): AccessRow[] {
  return entries.map(({ type, id, mode }) => ({ type, id, mode }));
}

/** The full list with one subject's mode changed. */
export function withMode(
  entries: readonly AccessEntry[],
  subject: Subject,
  mode: AccessListMode,
): AccessRow[] {
  return rowsOf(entries).map((row) => (isSubject(row, subject) ? { ...row, mode } : row));
}

/** The full list without one subject's row. */
export function withoutSubject(entries: readonly AccessEntry[], subject: Subject): AccessRow[] {
  return rowsOf(entries).filter((row) => !isSubject(row, subject));
}

/** The full list with a new row; a subject already on it takes the new row's mode. */
export function withSubject(entries: readonly AccessEntry[], added: AccessRow): AccessRow[] {
  const rows = withoutSubject(entries, added);
  return [...rows, added];
}

/** The mode a row of this type takes: the one asked for when the type allows it, else read. */
export function modeForType(type: AccessSubjectType, mode: AccessListMode): AccessListMode {
  return accessModes[type].includes(mode) ? mode : "read";
}

/** A subject the add picker offers, keyed by `subjectKey`. */
export type AccessCandidate = Subject & { value: string; label: string; description?: string };

export type AccessCandidateGroup = { label: string; options: AccessCandidate[] };

type Named = { id: string; name: string };

function candidate(type: AccessSubjectType, item: Named, description?: string): AccessCandidate {
  return {
    type,
    id: item.id,
    value: subjectKey({ type, id: item.id }),
    label: item.name,
    ...(description ? { description } : {}),
  };
}

type CandidateSource = {
  org: Named;
  guilds: readonly Named[];
  agentsByGuild: ReadonlyMap<string, readonly Named[]>;
  taken: readonly AccessEntry[];
  /** The agent that owns the note; it always writes its own note, so no row names it. */
  ownerAgentId: string | null;
};

/** The subjects the picker never offers: those on the list, and the note's owner agent. */
function hiddenSubjects(input: CandidateSource): Set<string> {
  const hidden = new Set(input.taken.map(subjectKey));
  if (input.ownerAgentId) hidden.add(subjectKey({ type: "agent", id: input.ownerAgentId }));
  return hidden;
}

/**
 * The subjects not yet on the list, by kind: the organisation, the guilds, then each guild's
 * agents, the note's owner agent left out. Empty groups are left out.
 */
export function accessCandidates(input: CandidateSource): AccessCandidateGroup[] {
  const hidden = hiddenSubjects(input);
  const groups: AccessCandidateGroup[] = [
    { label: "Organisation", options: [candidate("org", input.org, "Every agent")] },
    {
      label: "Guilds",
      options: input.guilds.map((guild) => candidate("guild", guild, "Every agent in the guild")),
    },
    ...input.guilds.map((guild) => ({
      label: `Agents · ${guild.name}`,
      options: (input.agentsByGuild.get(guild.id) ?? []).map((agent) => candidate("agent", agent)),
    })),
  ];
  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => !hidden.has(option.value)),
    }))
    .filter((group) => group.options.length > 0);
}

/** The candidate a picked value names, or undefined when none does. */
export function findCandidate(
  groups: readonly AccessCandidateGroup[],
  value: string,
): AccessCandidate | undefined {
  return groups.flatMap((group) => group.options).find((option) => option.value === value);
}

/** What a row says under its subject's name: what the row covers. */
export function subjectCaption(entry: AccessEntry): string {
  const captions: Record<AccessSubjectType, string> = {
    org: "Organisation · every agent",
    guild: "Guild · every agent in it",
    agent: `Agent · ${entry.guild_name ?? "another guild"}`,
  };
  return captions[entry.type];
}
