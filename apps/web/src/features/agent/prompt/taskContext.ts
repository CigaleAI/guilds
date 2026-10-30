import type { EmbeddableNote, FileChange, NoteLevel, TaskFile } from "../../../api/types/notes";
import type { Collection } from "../../../api/types/tables";
import { embedKind, embedMarkup, linkMarkup } from "@guildsrun/ui";
import type { ChangeActor, EmbedMode, InsertKind } from "@guildsrun/ui";
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

const runTrigger: Record<string, string> = {
  direct: "direct session",
  group: "group chat",
  schedule: "routine wake-up",
};

/** The run that made a recorded change: its id, what woke it, and the tool it changed it with. */
function runActor(change: FileChange): ChangeActor {
  const runId = change.run?.id ?? change.actor.id ?? "";
  const trigger = change.run ? runTrigger[change.run.kind] : undefined;
  return {
    kind: "run",
    runId,
    ...(trigger ? { trigger } : {}),
    ...(change.tool?.name ? { tool: change.tool.name } : {}),
  };
}

/** Who made a recorded change, as the version strip names them. */
export function changeActor(change: FileChange): ChangeActor {
  if (change.actor.type === "run") return runActor(change);
  if (change.actor.type === "agent")
    return { kind: "agent", name: change.actor.name ?? "an agent" };
  return { kind: "user", name: change.actor.name ?? "someone" };
}

/** What the operator is writing in the Task, and the version it started from. */
export type TaskDraft = { text: string; base: number | undefined };

/**
 * The Task editor against the saved Task: the saved text, the text shown, whether they differ, and
 * whether the edit started from a version older than the one saved since.
 */
export type TaskEdit = { saved: string; value: string; dirty: boolean; conflict: boolean };

/** Where the operator's draft stands against the saved Task, which is undefined while it loads. */
export function taskEdit(draft: TaskDraft | null, task: TaskFile | undefined): TaskEdit {
  const saved = task?.content ?? "";
  const value = draft?.text ?? saved;
  const dirty = value !== saved;
  const conflict =
    dirty &&
    draft?.base !== undefined &&
    task?.version !== undefined &&
    draft.base !== task.version;
  return { saved, value, dirty, conflict };
}
