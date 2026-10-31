import type { RunKind } from "./runs";

/**
 * Shapes of the orchestrator's JSON API for notes, Tasks, memory and their embeds, as the app reads
 * them. Timestamps are ISO-8601 in UTC.
 */

/** A Task version the save replaced; kept so it can be restored. */
export type TaskRevision = {
  version: number;
  content: string;
  replaced_at: string;
  replaced_by_name: string | null;
};

/**
 * An agent's Task (`task.md`), the operator's part of its system prompt. Without the artifact
 * store it carries only `path` and `content`, and has no versions.
 */
export type TaskFile = {
  path: string;
  content: string;
  display_path?: string;
  version?: number;
  /** Newest first. */
  revisions?: TaskRevision[];
};

/** A Task's new text; with `expected_version`, a save over a version written since is refused. */
export type TaskInput = { content: string; expected_version?: number };

export type NoteLevel = "org" | "guild" | "agent";

/** A note a Task can embed as `![[display_path]]`. */
export type EmbeddableNote = {
  display_path: string;
  kind: "note";
  level: NoteLevel;
  /** The note's file name, such as `process.md`. */
  key: string;
  title: string | null;
  author: string | null;
  version: number;
  updated_at: string;
  content: string;
};

/** Per agent, the Task embeds that do not resolve to a file that agent can read; its runs get a marker in their place. */
export type EmbedStatus = { agents: { id: string; broken_embeds: string[] }[] };

/** One recorded write to a file: who made it, and the run and tool call when an agent did. */
export type FileChange = {
  id: string;
  display_path: string;
  operation: string;
  version: number;
  actor: { type: "user" | "agent" | "run" | "unknown"; id: string | null; name: string | null };
  run: { id: string; agent_id: string; guild_id?: string; kind: RunKind } | null;
  tool: { name: string; call_id: string | null } | null;
  created_at: string;
  /** False for a file saved before the change log started. */
  recorded?: boolean;
};

/** A note in a notes scope; `path` is its file name, such as `process.md`. */
export type NoteItem = {
  /** The note's id, which names it to the access API. */
  id: string;
  path: string;
  display_path: string;
  kind: "note";
  title: string | null;
  version: number;
};

/** A file's text; `id` is set for a note, not for task.md or memory.md. */
export type FileContent = {
  id?: string;
  path: string;
  content: string;
  display_path: string;
  version?: number;
};

/** A note's text, by its path in its scope. */
export type NoteInput = { path: string; content: string };

/** Who wrote a memory version. */
export type MemoryActor = {
  type: "run" | "user" | "agent" | "unknown";
  id: string | null;
  name: string | null;
  detail: string | null;
};

/** One version of an agent's memory, newest first, with the change from the one before. */
export type MemoryVersion = {
  index: number;
  /** Null for the live version. */
  revision_id: string | null;
  archive_display_path: string | null;
  written_at: string | null;
  actor: MemoryActor;
  run_id: string | null;
  content: string;
  content_hash: string;
  /** Null for the oldest version on record. */
  previous_content: string | null;
  stats: { added: number; removed: number };
  run: {
    id: string;
    exists: boolean;
    kind?: RunKind;
    status?: string;
    schedule_id?: string | null;
    created_at?: string;
    memory_write?: { call_id: string | null; name: string } | null;
  } | null;
};

/** An agent's memory versions, as the agent's and Studio's Memory tabs read them. */
export type MemoryTimeline = {
  agent: { id: string; name: string };
  display_path: string;
  live: { version: number | string; content_hash: string } | null;
  entries: MemoryVersion[];
};

/**
 * Studio's activity ledger for one window of the session's guild: one entry per wake (a run of any
 * kind) with what started it and what it produced. The window runs `hours` back from `until`.
 * Timestamps are ISO-8601 in UTC.
 */
