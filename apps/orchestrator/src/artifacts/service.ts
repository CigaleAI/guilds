import type { AgentRow } from "../db/agents.js";
import type { HashedArtifactRow, ArtifactRow } from "../db/artifacts.js";
import type { RunTaskSource, TaskEmbedSnapshot } from "../db/schema/index.js";
import {
  collectTaskEmbeds,
  EMBED_DEPTH,
  embedSource,
  inlineTaskEmbeds,
  inspectEmbed,
  inspectTaskEmbeds,
  noteReader,
  reachEmbeds,
  snapshotTaskCollections,
  snapshotTaskEmbeds,
  taskEmbedActor,
  walkTaskEmbeds,
  type EmbedReach,
  type EmbedStep,
} from "./embeds.js";
import { ArtifactError } from "./errors.js";
import { getMemoryRow, listRevisions, storedMemoryText } from "./memory.js";
import { buildMemoryTimeline, type MemoryTimelineEntry } from "./memory-timeline.js";
import { getByDisplayPath, upsertNote } from "./notes.js";
import {
  assertNoteKeyFree,
  displayPathFor,
  MEMORY_KEY,
  normalizeNoteKey,
  parseDisplayPath,
  type ParsedDisplayPath,
} from "./paths.js";
import {
  assertBytes,
  assertLiveCount,
  hashArtifactContent,
  ownerFor,
  rowDisplayPath,
  type ArtifactOwnerRef,
  type ArtifactStore,
} from "./store.js";
import { taskDisplayPath } from "./task.js";
import { EMBED_BUDGET, SEARCH_TEXT_MAX, type ArtifactActor, type ArtifactLevel } from "./types.js";

/** A Task's text with its embeds inlined, or why the store refuses to inline them. */
export type TaskExpansion = { ok: true; text: string } | { ok: false; error: string };

/** An agent's Task as its next run reads it, and the Memory the run reads beside it. */
export type AgentTaskView = {
  /** The Task as the operator wrote it. */
  text: string;
  version: number;
  /** The hash of `text`. */
  hash: string;
  displayPath: string;
  /** Whether `text` embeds a note or a table. */
  hasEmbeds: boolean;
  /** `text` with its embeds inlined as the agent reads them. */
  expanded: TaskExpansion;
  /** The agent's Memory as stored; null when it has none. */
  memory: HashedArtifactRow | null;
  /** The Memory text a prompt reads. */
  memoryText: string;
};

/** What a display path holds for an actor: a row, live or deleted, or an archived Memory revision. */
export type ArtifactView =
  | { kind: "row"; row: ArtifactRow; deleted: boolean }
  | { kind: "revision"; content: string; displayPath: string };

/** `text` as the agent's run would read it as its Task: its embeds inlined as the agent reads them. ArtifactError past the embed budget. */
export async function expandTaskText(store: ArtifactStore, agent: AgentRow, text: string): Promise<string> {
  return inlineTaskEmbeds(embedSource(store), taskEmbedActor(agent.org_id, agent), text);
}

/** The agent's Task, inlined as its next run reads it, with the agent's Memory. */
export async function agentTask(store: ArtifactStore, agent: AgentRow): Promise<AgentTaskView> {
  let expanded: TaskExpansion;
  try {
    expanded = { ok: true, text: await expandTaskText(store, agent, agent.task) };
  } catch (error) {
    if (!(error instanceof ArtifactError)) {
      throw error;
    }
    expanded = { ok: false, error: error.message };
  }
  const memory = await getMemoryRow(store, taskEmbedActor(agent.org_id, agent), agent.id);
  return {
    text: agent.task,
    version: agent.task_version,
    hash: agent.task_hash,
    displayPath: taskDisplayPath(agent.org_id, agent.id),
    hasEmbeds: collectTaskEmbeds(agent.task).length > 0,
    expanded,
    memory,
    memoryText: storedMemoryText(memory),
  };
}

/**
 * Where a run's Task comes from: its version, hash and display path, and the notes and
 * collections it embeds as the agent reads them. A walk the store refuses keeps what it
 * snapshotted before the refusal.
 */
export async function taskSnapshot(store: ArtifactStore, agent: AgentRow): Promise<RunTaskSource> {
  const source = embedSource(store);
  const actor = taskEmbedActor(agent.org_id, agent);
  let embeds: TaskEmbedSnapshot[] = [];
  let collections: string[] = [];
  try {
    embeds = await snapshotTaskEmbeds(source, actor, agent.task);
    collections = await snapshotTaskCollections(source, actor, agent.task);
  } catch (error) {
    if (!(error instanceof ArtifactError)) {
      throw error;
    }
  }
  return {
    version: agent.task_version,
    hash: agent.task_hash,
    display_path: taskDisplayPath(agent.org_id, agent.id),
    embeds,
    collections,
    has_embeds: collectTaskEmbeds(agent.task).length > 0,
  };
}

/**
 * A display path the actor may name, parsed. ArtifactError when it is malformed, when it lies
 * outside the actor's organisation, or when it names the Memory archive to an agent: the archive
 * is the operator's, so its paths are unknown to an agent.
 */
export function parseActorPath(actor: ArtifactActor, href: string): ParsedDisplayPath {
  const parsed = parseDisplayPath(href);
  if (parsed.kind === "revision" && !actor.operator) {
    throw new ArtifactError("unknown artifact path", 404);
  }
  if (parsed.orgId !== actor.orgId) {
    throw new ArtifactError("artifact is not in this organisation", 404);
  }
  return parsed;
}

/**
 * What a display path holds for the actor. ArtifactError when `parseActorPath` refuses the path,
 * when it names a collection, and when it holds nothing the actor reads.
 */
export async function artifactAt(store: ArtifactStore, actor: ArtifactActor, href: string): Promise<ArtifactView> {
  parseActorPath(actor, href);
  const read = await getByDisplayPath(store, actor, href);
  if (read.revision) {
    return { kind: "revision", content: read.revision.content, displayPath: read.revision.display_path };
  }
  if (!read.row) {
    throw new ArtifactError("artifact not found", 404);
  }
  return { kind: "row", row: read.row, deleted: read.tombstone === true };
}

/** A note as a write sets it: its file name at a level, its title and text, and the version it replaces when the writer read one. */
export type NoteDraft = {
  level: ArtifactLevel;
  key: string;
  title?: string;
  content: string;
  expectedVersion?: number;
};

/** A note as written: its display path and its row. */
export type NoteWrite = { href: string; row: ArtifactRow };

/** Where a draft lands before it is written: its display path, its file name as written, and the hash of its title and text. */
export type PlannedNote = { href: string; key: string; hash: string };

/**
 * Where a draft lands under `owner`, the owner its level names, before anything writes it.
 * ArtifactError when its key is not a note file name or is reserved at its level.
 */
export function planNote(owner: Pick<ArtifactOwnerRef, "orgId" | "ownerId">, note: NoteDraft): PlannedNote {
  const key = normalizeNoteKey(note.key);
  assertNoteKeyFree(note.level, key);
  return {
    href: displayPathFor({ orgId: owner.orgId, level: note.level, ownerId: owner.ownerId, kind: "note", path: "", key }),
    key,
    hash: hashArtifactContent(JSON.stringify([note.title ?? null, hashArtifactContent(note.content)])),
  };
}

/**
 * Writes a note directly under the owner its level names for the actor. An existing note is
 * written with write access to it, and is otherwise refused as not writable; a new one only where
 * its starting access lets the writer write it.
 */
export async function writeNote(store: ArtifactStore, actor: ArtifactActor, note: NoteDraft): Promise<NoteWrite> {
  const key = normalizeNoteKey(note.key);
  assertNoteKeyFree(note.level, key);
  assertBytes(note.content);
  const owner = ownerFor(actor, note.level);
  await assertLiveCount(store, owner.orgId, note.level, owner.ownerId);
  const searchText = [note.title ?? "", key].filter(Boolean).join(" ").slice(0, SEARCH_TEXT_MAX);
  const row = await upsertNote(store, actor, {
    level: note.level,
    owner,
    path: "",
    key,
    title: note.title ?? null,
    contentText: note.content,
    searchText,
    ...(note.expectedVersion !== undefined ? { expectedVersion: note.expectedVersion } : {}),
  });
  return { href: rowDisplayPath(row), row };
}

/** What texts embed as a reader reads them, with how many embed levels a run inlines and how many bytes of note text at most. */
export type EmbedGraph = EmbedReach & { depth: number; budget: number };

/**
 * What `roots` embed as the actor reads them, followed one level past what a run inlines. The
 * walk neither resolves nor follows the display paths in `known`.
 */
export async function embedGraph(
  store: ArtifactStore,
  actor: ArtifactActor,
  roots: string[],
  known: ReadonlySet<string>,
): Promise<EmbedGraph> {
  const reach = await reachEmbeds(embedSource(store), actor, roots, known);
  return { ...reach, depth: EMBED_DEPTH, budget: EMBED_BUDGET };
}

/** The embeds an agent's run meets in its Task, one level past what it inlines, and the inlined ones the agent cannot read. */
export type TaskEmbedRun = { steps: EmbedStep[]; unreachable: Set<string> };

/** How the agent's run walks the embeds of its Task, as the agent reads them. */
export async function taskEmbedRun(
  store: ArtifactStore,
  agent: Pick<AgentRow, "org_id" | "id" | "guild_id" | "name" | "task">,
): Promise<TaskEmbedRun> {
  const source = embedSource(store);
  const actor = taskEmbedActor(agent.org_id, agent);
  const steps = await walkTaskEmbeds(agent.task, noteReader(source, actor), EMBED_DEPTH + 1);
  const hrefs = [...new Set(steps.filter((step) => step.inlined).map((step) => step.href))];
  const inspected = await Promise.all(hrefs.map((href) => inspectEmbed(source, actor, href)));
  return { steps, unreachable: new Set(inspected.filter((item) => !item.ok).map((item) => item.href)) };
}

/** The embeds of the agent's Task, and of the notes its run inlines, that do not resolve as the agent reads them. */
export async function brokenTaskEmbeds(
  store: ArtifactStore,
  agent: Pick<AgentRow, "org_id" | "id" | "guild_id" | "name" | "task">,
): Promise<string[]> {
  const inspected = await inspectTaskEmbeds(embedSource(store), taskEmbedActor(agent.org_id, agent), agent.task);
  return inspected.filter((item) => !item.ok).map((item) => item.href);
}

/** Every version an agent's Memory has held, newest first, with its display path and the live version and hash. */
export type MemoryTimeline = {
  displayPath: string;
  /** The live Memory's version and the hash of its text; null when the agent has no Memory. */
  live: { version: number; contentHash: string } | null;
  entries: MemoryTimelineEntry[];
};

/** The agent's Memory as the actor reads its versions: the archived ones only reach an operator. */
export async function memoryTimeline(store: ArtifactStore, actor: ArtifactActor, agentId: string): Promise<MemoryTimeline> {
  const live = await getMemoryRow(store, actor, agentId);
  const revisions = await listRevisions(store, actor, agentId);
  return {
    displayPath: displayPathFor({ orgId: actor.orgId, level: "agent", ownerId: agentId, kind: "memory", path: "", key: MEMORY_KEY }),
    live: live ? { version: live.version, contentHash: live.content_hash } : null,
    entries: buildMemoryTimeline({ live: { content: live?.content_text ?? "" }, revisions }),
  };
}
