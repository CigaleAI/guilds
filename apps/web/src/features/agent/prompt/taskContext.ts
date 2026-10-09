import type { Collection, EmbeddableNote, FileChange, NoteLevel } from "../../../api/types";
import { embedKind } from "@guildsrun/ui";
import type { ChangeActor } from "@guildsrun/ui";
export type NoteGroup = { level: NoteLevel; label: string; notes: EmbeddableNote[] };

const levelLabel: Record<NoteLevel, string> = {
  agent: "This agent",
  guild: "Guild",
  org: "Organisation",
};

/** The notes a Task can embed: the agent's own, its guild's and the organisation's. */
export function pickableNotes(
  notes: readonly EmbeddableNote[],
  scope: { orgId: string; guildId: string; agentId: string },
): NoteGroup[] {
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

/** The server lists at most this many notes; past it, a note missing from the list may still exist. */
const noteListLimit = 500;

/**
 * Whether an embed no longer resolves. The server's check of the saved Task decides; embeds only
 * in the draft are checked against the notes and tables the operator can see.
 */
export function embedIsBroken(
  path: string,
  known: {
    serverBroken: readonly string[];
    notes: readonly EmbeddableNote[] | undefined;
    collections: readonly Pick<Collection, "name">[] | undefined;
    orgId: string;
  },
): boolean {
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

const runTrigger: Record<string, string> = {
  direct: "direct session",
  group: "group chat",
  schedule: "routine wake-up",
};

/** Who made a recorded change, as the version strip names them. */
export function changeActor(change: FileChange): ChangeActor {
  if (change.actor.type === "run") {
    const runId = change.run?.id ?? change.actor.id ?? "";
    const trigger = change.run ? runTrigger[change.run.kind] : undefined;
    return {
      kind: "run",
      runId,
      ...(trigger ? { trigger } : {}),
      ...(change.tool?.name ? { tool: change.tool.name } : {}),
    };
  }
  if (change.actor.type === "agent")
    return { kind: "agent", name: change.actor.name ?? "an agent" };
  return { kind: "user", name: change.actor.name ?? "someone" };
}
