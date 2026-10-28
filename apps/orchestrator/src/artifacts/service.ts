import type { AgentRow } from "../db/agents.js";
import type { HashedArtifactRow, ArtifactRow } from "../db/artifacts.js";
import type { AccessMode, CollectionColumn, RunTaskSource, TaskEmbedSnapshot } from "../db/schema/index.js";
import { grantAccess, listAccess } from "./access-lists.js";
import {
  collectionFacts,
  createCollection,
  deleteCollection,
  describeCollection,
  getCollection,
  listCollectionsWithCounts,
  updateCollection,
  validateCollectionName,
  validatePurpose,
  type CollectionChanges,
  type CollectionFacts,
  type NewCollection,
} from "./collections.js";
import { describeColumn, parseColumnChange, parseColumns, type ColumnChange } from "./columns.js";
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
import { getByDisplayPath, listEmbeddableNotes, loadParsed, upsertNote } from "./notes.js";
import {
  assertNoteKeyFree,
  collectionDisplayPath,
  displayPathFor,
  MEMORY_KEY,
  normalizeNoteKey,
  parseDisplayPath,
  type ParsedDisplayPath,
} from "./paths.js";
import { listRecords } from "./records.js";
import {
  assertBytes,
  assertLiveCount,
  assertRead,
  hashArtifactContent,
  isRecordRow,
  ownerFor,
  recordViewWithPath,
  rowDisplayPath,
  type ArtifactOwnerRef,
  type ArtifactStore,
  type CollectionView,
  type RecordView,
} from "./store.js";
import { taskDisplayPath } from "./task.js";
import {
  EMBED_BUDGET,
  isAccessMode,
  SEARCH_TEXT_MAX,
  type AccessEntry,
  type AccessGrant,
  type AccessSubject,
  type AccessTarget,
  type AgentAccessMode,
  type ArtifactActor,
  type ArtifactLevel,
} from "./types.js";

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

/**
 * What a display path holds for an actor: a row, live or deleted, with its display path and its
 * text as a reader reads it, or an archived Memory revision. A record's text is its JSON view,
 * indented; anything else's is the text it holds, empty when it holds none.
 */
export type ArtifactView =
  | { kind: "row"; row: ArtifactRow; href: string; text: string; deleted: boolean }
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
  const row = read.row;
  return {
    kind: "row",
    row,
    href: rowDisplayPath(row),
    text: isRecordRow(row) ? JSON.stringify(recordViewWithPath(row), null, 2) : (row.content_text ?? ""),
    deleted: read.tombstone === true,
  };
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

/**
 * Rewrites the live note a display path names, with write access to it. ArtifactError when the
 * path names no live note of the actor's organisation that the actor reads.
 */
export async function writeNoteAt(store: ArtifactStore, actor: ArtifactActor, href: string, content: string): Promise<NoteWrite> {
  const parsed = parseDisplayPath(href);
  if (parsed.kind !== "artifact" || parsed.orgId !== actor.orgId) {
    throw new ArtifactError("artifact not found", 404);
  }
  const live = await loadParsed(store, parsed);
  if (!live || live.kind !== "note") {
    throw new ArtifactError("artifact not found", 404);
  }
  await assertRead(store, actor, live);
  assertBytes(content);
  const row = await upsertNote(store, actor, {
    level: live.level,
    owner: { orgId: live.org_id, ownerId: live.owner_id, guildId: live.guild_id, agentId: live.agent_id },
    path: live.path,
    key: live.key,
    title: live.title,
    contentText: content,
    searchText: live.search_text,
  });
  return { href: rowDisplayPath(row), row };
}

/** A live note the actor reads, with its display path and its access list. */
export type NoteAccess = { href: string; row: ArtifactRow; access: AccessEntry[] };

/**
 * The live notes the actor reads whose display path or file name is one of `names`, in level and
 * file name order, each with its access list. Access lists are the operator's to read.
 */
export async function notesNamed(store: ArtifactStore, actor: ArtifactActor, names: ReadonlySet<string>): Promise<NoteAccess[]> {
  const notes: NoteAccess[] = [];
  for (const row of await listEmbeddableNotes(store, actor)) {
    const href = rowDisplayPath(row);
    if (names.has(href) || names.has(row.key)) {
      notes.push({ href, row, access: await listAccess(store, actor, { kind: "note", id: row.id }) });
    }
  }
  return notes;
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

/** Who an access list is read for: a guild, or one agent of that guild. */
export type AccessReader = { guildId: string; agentId: string | null };

/**
 * The mode an item's access list gives `reader`: an agent's own row when it has one, `none`
 * meaning no access; otherwise the better of its guild's row and the organisation's, `write`
 * implying `read`. Null when no row reaches it.
 */
export function effectiveAccess(entries: AccessGrant[], reader: AccessReader): AccessMode | null {
  const own = reader.agentId === null ? undefined : entries.find((entry) => entry.type === "agent" && entry.id === reader.agentId);
  if (own) {
    return isAccessMode(own.mode) ? own.mode : null;
  }
  const guild = entries.find((entry) => entry.type === "guild" && entry.id === reader.guildId)?.mode;
  const org = entries.find((entry) => entry.type === "org")?.mode;
  if (guild === "write" || org === "write") {
    return "write";
  }
  return isAccessMode(guild) || isAccessMode(org) ? "read" : null;
}

/** What an item's access list is raised to: a guild to at least `mode` when one is named, and each of `writerIds`, agents of that guild, to write. */
export type AccessRaise = { guildId: string; mode: AccessMode | null; writerIds: string[] };

/**
 * The rows that bring the guild up to `raise.mode` and each writer up to write, guild first. A
 * subject that already holds as much, its guild's row once raised included, gets no row, so a row
 * is never lowered.
 */
export function accessRaises(entries: AccessGrant[], raise: AccessRaise): AccessGrant[] {
  const held = effectiveAccess(entries, { guildId: raise.guildId, agentId: null });
  const wanted = raise.mode;
  const raisesGuild = wanted !== null && (wanted === "write" ? held !== "write" : held === null);
  const guildRows: AccessGrant[] = raisesGuild ? [{ type: "guild", id: raise.guildId, mode: wanted }] : [];
  const raised = [...guildRows, ...entries];
  const writers: AccessGrant[] = raise.writerIds
    .filter((agentId) => effectiveAccess(raised, { guildId: raise.guildId, agentId }) !== "write")
    .map((agentId) => ({ type: "agent", id: agentId, mode: "write" }));
  return [...guildRows, ...writers];
}

/** Raises an item's access list as the operator to what `raise` names, writing only the rows `accessRaises` gives. */
export async function raiseAccess(store: ArtifactStore, actor: ArtifactActor, target: AccessTarget, raise: AccessRaise): Promise<void> {
  const entries = await listAccess(store, actor, target);
  for (const grant of accessRaises(entries, raise)) {
    await grantAccess(store, actor, target, grant);
  }
}

/** A collection as the operator reads it, with its access list. */
export type CollectionAccess = { collection: CollectionView; access: AccessEntry[] };

/** A collection named by its id or by its name. */
export type CollectionLookup = { id: string } | { name: string };

/** Whether a collection is one a guild's agents are given in the guild's own right: the guild's own, or the organisation's. */
function isGuildOrOrgTable(collection: CollectionView, guildId: string): boolean {
  return !collection.guild || collection.guild.id === guildId;
}

/**
 * The guild's own tables and the organisation's, as the operator `actor` sees them, each with its
 * live record count and its access list.
 */
export async function guildTables(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<CollectionAccess[]> {
  const tables: CollectionAccess[] = [];
  for (const collection of await listCollectionsWithCounts(store, actor)) {
    if (isGuildOrOrgTable(collection, guildId)) {
      tables.push({ collection, access: await listAccess(store, actor, { kind: "collection", id: collection.id }) });
    }
  }
  return tables;
}

/**
 * One of `guildTables`, with its live record count and its access list. Null when the lookup names
 * no live collection the operator `actor` sees, or another guild's own table.
 */
export async function guildTable(
  store: ArtifactStore,
  actor: ArtifactActor,
  guildId: string,
  lookup: CollectionLookup,
): Promise<CollectionAccess | null> {
  const described = "name" in lookup ? await describeCollection(store, actor, lookup.name) : null;
  const id = "name" in lookup ? described?.id : lookup.id;
  if (id === undefined) {
    return null;
  }
  let table: CollectionAccess;
  try {
    table = {
      collection: await getCollection(store, actor, id),
      access: await listAccess(store, actor, { kind: "collection", id }),
    };
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) {
      return null;
    }
    throw error;
  }
  return isGuildOrOrgTable(table.collection, guildId) ? table : null;
}

/** A new collection checked before anything writes it: its name, purpose and columns as stored, and the display path it takes. */
export type CheckedCollection = { name: string; purpose: string; columns: CollectionColumn[]; href: string };

/**
 * Checks a new collection's name, purpose and columns, in that order, before anything writes it.
 * ArtifactError on the first that fails.
 */
export function planCollection(orgId: string, draft: Pick<NewCollection, "name" | "purpose" | "columns">): CheckedCollection {
  const name = validateCollectionName(draft.name);
  const purpose = validatePurpose(draft.purpose);
  const columns = parseColumns(draft.columns ?? []);
  return { name, purpose, columns, href: collectionDisplayPath(orgId, name) };
}

/** A change to a collection's definition checked before anything writes it: the name and purpose it leaves, and its column change when it replaces the columns. */
export type CheckedCollectionChange = { name: string; purpose: string; columns: ColumnChange | null };

/**
 * Checks a change's name, purpose and columns, in that order, against the collection it changes,
 * before anything writes it. A field the change leaves out keeps the collection's. ArtifactError on
 * the first that fails.
 */
export function planCollectionChange(
  current: Pick<CollectionView, "name" | "purpose" | "columns">,
  changes: CollectionChanges,
): CheckedCollectionChange {
  const name = changes.name === undefined ? current.name : validateCollectionName(changes.name);
  const purpose = changes.purpose === undefined ? current.purpose : validatePurpose(changes.purpose);
  const columns = changes.columns === undefined ? null : parseColumnChange(current.columns, changes.columns);
  return { name, purpose, columns };
}

/** One subject's row a collection step sets on the collection's access list; a null mode removes the row. */
export type AccessRowChange = { type: AccessSubject; id: string; mode: AgentAccessMode | null };

/** One change to a collection as the operator applies it: a create or an edit with the access rows it then sets, or a delete. */
export type CollectionStep =
  | { action: "create"; collection: NewCollection; access: AccessRowChange[] }
  | { action: "edit"; id: string; changes: CollectionChanges | null; access: AccessRowChange[] }
  | { action: "delete"; id: string };

/** Applies a step as the operator: the collection first, created, changed or deleted, then each access row in order. */
export async function applyCollectionStep(store: ArtifactStore, actor: ArtifactActor, step: CollectionStep): Promise<void> {
  if (step.action === "delete") {
    await deleteCollection(store, actor, step.id);
    return;
  }
  const id = step.action === "create" ? (await createCollection(store, actor, step.collection)).id : step.id;
  if (step.action === "edit" && step.changes) {
    await updateCollection(store, actor, id, step.changes);
  }
  for (const row of step.access) {
    await grantAccess(store, actor, { kind: "collection", id }, row);
  }
}

/**
 * A listing of one collection's records: `where` a term per column, `since` a moment records
 * changed at or after, `order`, and the page.
 */
export type RecordQuery = {
  collection: string;
  where?: Record<string, unknown> | undefined;
  since?: string | undefined;
  order?: unknown;
  limit?: unknown;
  offset?: unknown;
};

/** A page of records, how many match in all, and what a narrowed listing that finds nothing says about its collection. */
export type RecordList = { total: number; records: RecordView[]; hint: string | null };

/**
 * Lists a collection's records as `listRecords` does. A listing narrowed by `where` or `since`
 * that finds nothing carries the hint `recordListHint` writes from the collection's facts.
 */
export async function listRecordsWithHint(store: ArtifactStore, actor: ArtifactActor, query: RecordQuery): Promise<RecordList> {
  const listed = await listRecords(store, actor, query);
  const narrowed = Boolean(query.where || query.since);
  const facts = listed.records.length === 0 && narrowed ? await collectionFacts(store, actor, query.collection) : null;
  return { total: listed.total, records: listed.records, hint: facts ? recordListHint(query, facts) : null };
}

/**
 * What a narrowed listing that finds nothing says: what was asked, what the collection holds, and
 * its columns, so the next call narrows differently instead of asking for a larger limit.
 */
export function recordListHint(query: RecordQuery, facts: CollectionFacts): string {
  const narrowing = [
    query.since ? `changed at or after ${query.since}` : "",
    query.where ? `where ${JSON.stringify(query.where)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const holds =
    facts.count === 0
      ? `${query.collection} holds no records yet.`
      : `${query.collection} holds ${facts.count} record${facts.count === 1 ? "" : "s"}; the newest changed at ${facts.newest_updated_at}.`;
  const columns = facts.columns.length ? `Its columns: ${facts.columns.map(describeColumn).join("; ")}.` : "";
  const advice = query.since
    ? "An empty result is the answer; a larger limit will not change it. since is for picking up new work — " +
      "to check whether something is already recorded, use where on the unique column or record_search."
    : "An empty result is the answer; a larger limit will not change it. where matches by column type " +
      "(text or an open array item by substring, a closed list exactly, null a missing value); record_search matches words in the values.";
  return [`No records in ${query.collection} ${narrowing}.`, holds, columns, advice].filter(Boolean).join(" ");
}
