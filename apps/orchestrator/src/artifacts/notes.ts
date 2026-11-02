import {
  getArtifactAt,
  getLiveArtifact,
  getArtifactOrTombstoneAt,
  getLiveNote,
  getMemoryRevisionText,
  insertNote,
  listAgentsEmbedding,
  listArtifactsEverAt,
  listArtifactsByKind,
  listGuildArtifacts,
  listGuildStateArtifacts,
  listOrgArtifacts,
  listReachedArtifacts,
  listReadableNotes,
  searchArtifactsByKind,
  softDeleteArtifact,
  updateNoteContent,
  type ArtifactAddress,
  type ArtifactOrTombstoneRow,
  type ArtifactRow,
} from "../db/artifacts.js";
import { getRecordOrTombstone } from "../db/collections.js";
import { recordFileChange, type ChangeTarget } from "../db/file-changes.js";
import { isUniqueViolation, withTransaction } from "../db/pg.js";
import { creatorGrant } from "./access.js";
import { deleteCollection, describeCollection, loadCollectionByName, requireReadable } from "./collections.js";
import { ArtifactError } from "./errors.js";
import { requireSubject, writeGrants } from "./grants.js";
import { listRevisions } from "./memory.js";
import { listAccess } from "./access-lists.js";
import {
  isDisplayPath,
  normalizeNoteKey,
  noteDisplayPath,
  parseDisplayPath,
  revisionDisplayPath,
  TASK_KEY,
  type ParsedDisplayPath,
} from "./paths.js";
import { removeRecord } from "./records.js";
import { findLimit, parseRecordId } from "./search.js";
import { artifactMode, artifactTextView, assertBytes, assertLiveCount, assertRead, assertWrite, hashArtifactContent, hostNoteView, isRecordRow, reachesAgent, recordViewWithPath, type ArtifactStore, type ArtifactTextView, type HostNoteView, type StateArtifact, rowDisplayPath } from "./store.js";
import {
  NO_HIDDEN_GUILDS,
  SEARCH_TEXT_MAX,
  type AccessEntry,
  type AccessGrant,
  type ArtifactActor,
} from "./types.js";

/** A parsed display path that names a note, file, Memory, or script by where it sits. */
export type ArtifactPath = Extract<ParsedDisplayPath, { kind: "artifact" }>;

/** A parsed display path that names a record of a collection. */
export type RecordPath = Extract<ParsedDisplayPath, { kind: "record" }>;

/** A parsed display path that names an archived Memory revision. */
export type RevisionPath = Extract<ParsedDisplayPath, { kind: "revision" }>;

/** What a read of a display path finds: a live row, a tombstone, or an archived Memory revision. */
export type DisplayPathRead = {
  row?: ArtifactRow;
  revision?: { content: string; display_path: string };
  tombstone?: boolean;
};

/**
 * A note's text as a write sets it under its key, and the rows of the access list it starts with
 * when the write creates it.
 */
export type NoteUpsert = {
  key: string;
  title: string | null;
  contentText: string;
  searchText: string | null;
  expectedVersion?: number;
  startingAccess: AccessGrant[];
};

function addressOf(parsed: ArtifactPath): ArtifactAddress {
  return { org_id: parsed.orgId, agent_id: parsed.agentId, path: parsed.path, key: parsed.key };
}

/** The live row a parsed display path names. */
export async function loadParsed(store: ArtifactStore, parsed: ArtifactPath): Promise<ArtifactRow | null> {
  return getArtifactAt(store.db, addressOf(parsed));
}

/** The row a parsed display path names, live or deleted. */
export async function loadParsedOrTombstone(
  store: ArtifactStore,
  parsed: ArtifactPath,
): Promise<ArtifactOrTombstoneRow | null> {
  return getArtifactOrTombstoneAt(store.db, addressOf(parsed));
}

/**
 * Writes the organisation's note at its key: the live one with write access to it, refused as not
 * writable without it, else a new one whose access list starts with `note.startingAccess`. An
 * expected version of 0 asks for a new note, a 409 when one is live; any other expected version
 * must be the live note's, a 409 otherwise.
 */
export async function upsertNote(store: ArtifactStore, actor: ArtifactActor, note: NoteUpsert): Promise<ArtifactRow> {
  return withTransaction(store.db, async (client) => {
    const live = await getLiveNote(client, actor.orgId, note.key);
    const hash = hashArtifactContent(note.contentText);
    if (live) {
      if ((await artifactMode(store, actor, live)) !== "write") {
        throw new ArtifactError("write not allowed", 422);
      }
      if (note.expectedVersion === 0) {
        throw new ArtifactError("artifact already exists", 409);
      }
      if (note.expectedVersion !== undefined && live.version !== note.expectedVersion) {
        throw new ArtifactError("version conflict", 409);
      }
      const row = await updateNoteContent(
        client,
        { id: live.id, content_text: note.contentText, search_text: note.searchText, title: note.title, content_hash: hash },
        actor,
        new Date(),
      );
      await recordFileChange(client, actor, {
        orgId: row.org_id,
        artifactId: row.id,
        displayPath: rowDisplayPath(row),
        operation: "update",
        version: row.version,
      });
      return row;
    }
    if (note.expectedVersion !== undefined && note.expectedVersion !== 0) {
      throw new ArtifactError("version conflict", 409);
    }
    await assertLiveCount(store, actor.orgId);
    for (const grant of note.startingAccess) {
      await requireSubject(client, actor, grant);
    }
    let row: ArtifactRow;
    try {
      row = await insertNote(
        client,
        {
          org_id: actor.orgId,
          key: note.key,
          origin_guild_id: actor.guildId,
          title: note.title,
          content_text: note.contentText,
          search_text: note.searchText,
          content_hash: hash,
        },
        actor,
        new Date(),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ArtifactError("artifact already exists", 409);
      }
      throw error;
    }
    await writeGrants(client, actor, { kind: "note", id: row.id }, note.startingAccess);
    await recordFileChange(client, actor, {
      orgId: row.org_id,
      artifactId: row.id,
      displayPath: rowDisplayPath(row),
      operation: "create",
      version: row.version,
    });
    return { ...row, access: "write" as const };
  });
}

/** Whether the organisation has a live note with this key. */
export async function isNoteKeyTaken(store: ArtifactStore, orgId: string, key: string): Promise<boolean> {
  return (await getLiveNote(store.db, orgId, normalizeNoteKey(key))) !== null;
}

/** Refuses deleting a note while an agent's task embeds it. */
async function assertNotEmbedded(store: ArtifactStore, orgId: string, displayPath: string): Promise<void> {
  const agents = await listAgentsEmbedding(store.db, orgId, displayPath);
  if (agents.length) {
    throw new ArtifactError(`note is embedded in task (${agents.join(", ")})`, 409);
  }
}

/** Deletes what a display path names: a collection, a record, or a note the actor writes. */
export async function deleteByDisplayPath(store: ArtifactStore, actor: ArtifactActor, displayPath: string): Promise<void> {
  const parsed = parseDisplayPath(displayPath);
  if (parsed.kind === "revision") {
    throw new ArtifactError("history-archive is read-only", 422);
  }
  if (parsed.kind !== "artifact" && parsed.orgId !== actor.orgId) {
    throw new ArtifactError("artifact not found", 404);
  }
  if (parsed.kind === "collection") {
    const collection = await loadCollectionByName(store, actor, parsed.collectionName);
    if (!collection) {
      throw new ArtifactError("unknown collection", 404);
    }
    await deleteCollection(store, actor, collection.id);
    return;
  }
  if (parsed.kind === "record") {
    await removeRecord(store, actor, { collection: parsed.collectionName, id: parsed.recordId });
    return;
  }
  await deleteNoteAt(store, actor, parsed);
}

/** Deletes the live note with this id as the actor; a note no longer live is left as it is. */
export async function deleteNoteById(store: ArtifactStore, actor: ArtifactActor, noteId: string): Promise<void> {
  const row = await getLiveArtifact(store.db, actor.orgId, { id: noteId, kind: "note" });
  if (row) {
    await deleteByDisplayPath(store, actor, rowDisplayPath(row));
  }
}

/** Deletes the note or script a display path names, refusing a task, Memory, a file, or an embedded note. */
async function deleteNoteAt(store: ArtifactStore, actor: ArtifactActor, parsed: ArtifactPath): Promise<void> {
  if (parsed.agentId !== null && parsed.path === "" && parsed.key === TASK_KEY) {
    throw new ArtifactError("cannot delete this file", 422);
  }
  const row = await loadParsed(store, parsed);
  if (!row) {
    throw new ArtifactError("artifact not found", 404);
  }
  await assertWrite(store, actor, row);
  if (row.kind === "memory") {
    throw new ArtifactError("cannot delete this file", 422);
  }
  if (row.kind === "file") {
    throw new ArtifactError("use file_delete for files", 422);
  }
  const displayPath = rowDisplayPath(row);
  await assertNotEmbedded(store, actor.orgId, displayPath);
  await withTransaction(store.db, async (client) => {
    const now = new Date();
    const version = await softDeleteArtifact(client, row.id, actor, now);
    if (version === null) {
      throw new ArtifactError("artifact not found", 404);
    }
    await recordFileChange(client, actor, {
      orgId: row.org_id,
      artifactId: row.id,
      displayPath,
      operation: "delete",
      version,
      createdAt: now,
    });
  });
}

/** What a display path names for the actor: a live row with its mode, a tombstone, or a Memory revision. */
export async function getByDisplayPath(
  store: ArtifactStore,
  actor: ArtifactActor,
  displayPath: string,
): Promise<DisplayPathRead> {
  const parsed = parseDisplayPath(displayPath);
  if (parsed.kind === "revision") {
    return { revision: await readRevision(store, actor, parsed) };
  }
  if (parsed.kind === "collection") {
    throw new ArtifactError("artifact not found", 404);
  }
  if (parsed.kind === "record") {
    if (parsed.orgId !== actor.orgId) {
      throw new ArtifactError("artifact not found", 404);
    }
    const collection = await requireReadable(store, actor, parsed.collectionName);
    const row = await getRecordOrTombstone(store.db, collection.id, parseRecordId(parsed.recordId));
    if (!row) {
      throw new ArtifactError("artifact not found", 404);
    }
    return row.deleted_at ? { tombstone: true, row } : { row };
  }
  const found = await loadParsedOrTombstone(store, parsed);
  if (!found) {
    throw new ArtifactError("artifact not found", 404);
  }
  const access = await assertRead(store, actor, found);
  if (found.deleted_at) {
    return { tombstone: true, row: found };
  }
  return { row: { ...found, access } };
}

/**
 * An archived Memory revision the operator reaches, by the archive file name its display path ends
 * with. ArtifactError when the path lies outside the actor's organisation.
 */
async function readRevision(
  store: ArtifactStore,
  actor: ArtifactActor,
  parsed: RevisionPath,
): Promise<{ content: string; display_path: string }> {
  if (parsed.orgId !== actor.orgId) {
    throw new ArtifactError("artifact is not in this organisation", 404);
  }
  if (!actor.operator || !reachesAgent(actor, parsed.agentId)) {
    throw new ArtifactError("artifact not found", 404);
  }
  const content = await getMemoryRevisionText(store.db, parsed.orgId, parsed.agentId, parsed.stamp);
  if (content) {
    return { content, display_path: revisionDisplayPath(parsed.orgId, parsed.agentId, parsed.stamp) };
  }
  const listed = await listRevisions(store, actor, parsed.agentId);
  const match = listed.find((item) => item.display_path.endsWith(`/${parsed.stamp}`));
  if (!match) {
    throw new ArtifactError("artifact not found", 404);
  }
  return match;
}

/** Whether the actor may read what a display path names, so its change history may be shown. */
export async function canReadDisplayPath(store: ArtifactStore, actor: ArtifactActor, displayPath: string): Promise<boolean> {
  const parsed = isDisplayPath(displayPath) ? parseDisplayPath(displayPath) : null;
  if (parsed?.orgId !== actor.orgId) {
    return false;
  }
  if ("collectionName" in parsed) {
    return (await describeCollection(store, actor, parsed.collectionName)) !== null;
  }
  if (parsed.kind === "revision") {
    return actor.operator && reachesAgent(actor, parsed.agentId);
  }
  const row = await loadParsedOrTombstone(store, parsed);
  if (!row) {
    return parsed.agentId === null ? actor.operator : reachesAgent(actor, parsed.agentId);
  }
  return (await artifactMode(store, actor, row)) !== null;
}

/**
 * Whose changes a display path's history shows the actor: every note, file, Memory, or script
 * that sat at the path, live or deleted, that the actor reads; the record it names in a
 * collection the actor reads; the agent's Task when it names one the actor reaches. Nothing for a
 * path the actor reads nothing at.
 */
export async function readableChangeTarget(store: ArtifactStore, actor: ArtifactActor, displayPath: string): Promise<ChangeTarget> {
  const none: ChangeTarget = { artifactIds: [], taskAgentId: null };
  const parsed = isDisplayPath(displayPath) ? parseDisplayPath(displayPath) : null;
  if (parsed?.orgId !== actor.orgId || parsed.kind === "revision" || parsed.kind === "collection") {
    return none;
  }
  if (parsed.kind === "record") {
    return readableRecordTarget(store, actor, parsed);
  }
  if (parsed.agentId !== null && parsed.path === "" && parsed.key === TASK_KEY) {
    return reachesAgent(actor, parsed.agentId) ? { artifactIds: [], taskAgentId: parsed.agentId } : none;
  }
  const rows = await listArtifactsEverAt(store.db, addressOf(parsed));
  const readable = await Promise.all(rows.map(async (row) => ((await artifactMode(store, actor, row)) === null ? [] : [row.id])));
  return { artifactIds: readable.flat(), taskAgentId: null };
}

/** The record a record path names, live or deleted, when the actor reads its collection; nothing otherwise. */
async function readableRecordTarget(
  store: ArtifactStore,
  actor: ArtifactActor,
  parsed: RecordPath,
): Promise<ChangeTarget> {
  const collection = await describeCollection(store, actor, parsed.collectionName);
  const record = collection ? await getRecordOrTombstone(store.db, collection.id, parseRecordId(parsed.recordId)) : null;
  return { artifactIds: record ? [record.id] : [], taskAgentId: null };
}

/** A search of the notes an actor reads: the words to match, and how many to return. */
export type NoteSearch = { query?: string; limit?: number };

/** Notes the actor may read, searched by `query` or listed. */
export async function findNotes(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: NoteSearch,
): Promise<{ notes: ArtifactTextView[] }> {
  const limit = findLimit(args.limit);
  const query = (args.query ?? "").trim();
  const rows = query
    ? await searchArtifactsByKind(store.db, actor, "note", { query, limit })
    : await listArtifactsByKind(store.db, actor, "note", limit);
  return { notes: rows.map(artifactTextView) };
}

/** Every note of the organisation the actor reads, as the Host lists them. */
export async function listOrgNotes(store: ArtifactStore, actor: ArtifactActor): Promise<HostNoteView[]> {
  return (await listOrgArtifacts(store.db, actor, "note")).map(hostNoteView);
}

/** The notes whose access list has a row for the guild, one of its agents, or the organisation, that the actor reads, as the Host lists them. */
export async function listGuildNotes(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<HostNoteView[]> {
  return (await listGuildArtifacts(store.db, actor, guildId, "note")).map(hostNoteView);
}

/** An agent whose reach a listing reads: the agent and the guild it sits in. */
export type ReachingAgent = { agentId: string; guildId: string };

/** `actor` reading as the agent: what the agent reaches through access lists, and nothing hidden from `actor`. */
export function agentReader(actor: ArtifactActor, agent: ReachingAgent): ArtifactActor {
  return { ...actor, operator: false, guildId: agent.guildId, agentId: agent.agentId, hidden: NO_HIDDEN_GUILDS };
}

/** The notes the agent reads, without those hidden from the actor, as the Host lists them. */
export async function listAgentNotes(store: ArtifactStore, actor: ArtifactActor, agent: ReachingAgent): Promise<HostNoteView[]> {
  return (await listReachedArtifacts(store.db, actor, agentReader(actor, agent), "note")).map(hostNoteView);
}

/**
 * What one guild's state holds that the actor can read: its agents' Memory and scripts, and the
 * notes and files whose access list has a row for the guild, one of its agents, or the organisation.
 */
export async function listStateArtifacts(
  store: ArtifactStore,
  actor: ArtifactActor,
  guildId: string,
): Promise<StateArtifact[]> {
  return (await listGuildStateArtifacts(store.db, actor, guildId)).map((row) => ({
    display_path: rowDisplayPath(row),
    kind: stateKind(row.kind),
    agent_id: row.agent_id,
    // A script's or a file's title column holds its description; its key is its name.
    title: row.kind === "script" || row.kind === "file" ? row.key : (row.title ?? row.key),
    size: row.bytes ?? Buffer.byteLength(row.content_text ?? JSON.stringify(row.content_json ?? ""), "utf8"),
    version: row.version,
    created_by: row.created_by_name,
    created_at: row.created_at,
    note_id: row.kind === "note" ? row.id : null,
    artifact_id: row.id,
  }));
}

/** The kind a state listing shows: its query reads notes, Memory, scripts, and files alone. */
function stateKind(kind: ArtifactRow["kind"]): StateArtifact["kind"] {
  return kind === "object" ? "note" : kind;
}

/** A live note with its display path. */
export type LiveNote = { href: string; row: ArtifactRow };

/**
 * The live notes of one guild's state the actor reads, with their text: those whose access list
 * has a row for the guild, one of its agents, or the organisation, in file name order. A note the
 * store refuses to read, an `ArtifactError`, is left out; any other failure throws.
 */
export async function readStateNotes(store: ArtifactStore, actor: ArtifactActor, guildId: string): Promise<LiveNote[]> {
  const listed = await listGuildArtifacts(store.db, actor, guildId, "note");
  const notes = await Promise.all(
    listed.map(async (listedRow): Promise<LiveNote | null> => {
      const href = rowDisplayPath(listedRow);
      try {
        const loaded = await getByDisplayPath(store, actor, href);
        const row = loaded.tombstone ? undefined : loaded.row;
        return row?.kind === "note" ? { href, row } : null;
      } catch (error) {
        if (error instanceof ArtifactError) {
          return null;
        }
        throw error;
      }
    }),
  );
  return notes.flatMap((note) => (note ? [note] : []));
}

export async function listEmbeddableNotes(store: ArtifactStore, actor: ArtifactActor): Promise<ArtifactRow[]> {
  return listReadableNotes(store.db, actor);
}

/**
 * What a display path holds for an actor: a row, live or deleted, with its display path and its
 * text as a reader reads it, or an archived Memory revision. A record's text is its JSON view,
 * indented; anything else's is the text it holds, empty when it holds none.
 */
export type ArtifactView =
  | { kind: "row"; row: ArtifactRow; href: string; text: string; deleted: boolean }
  | { kind: "revision"; content: string; displayPath: string };

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

/**
 * A note as a write sets it: its file name, its title and text, the version it replaces when the
 * writer read one, and the rows its access list starts with when the write creates it; without
 * them, the creator's own row (`creatorGrant`).
 */
export type NoteDraft = {
  key: string;
  title?: string;
  content: string;
  expectedVersion?: number;
  startingAccess?: AccessGrant[];
};

/** A note as written: its display path and its row. */
export type NoteWrite = { href: string; row: ArtifactRow };

/** Where a draft lands before it is written: its display path, its file name as written, and the hash of its title and text. */
export type PlannedNote = { href: string; key: string; hash: string };

/**
 * Where a draft lands in the organisation `orgId`, before anything writes it. ArtifactError when
 * its key is not a note file name.
 */
export function planNote(orgId: string, note: NoteDraft): PlannedNote {
  const key = normalizeNoteKey(note.key);
  return {
    href: noteDisplayPath(orgId, key),
    key,
    hash: hashArtifactContent(JSON.stringify([note.title ?? null, hashArtifactContent(note.content)])),
  };
}

/**
 * Writes the organisation's note at the draft's key. A live note is written with write access to
 * it, and is otherwise refused as not writable; a missing one is created with the draft's starting
 * access list.
 */
export async function writeNote(store: ArtifactStore, actor: ArtifactActor, note: NoteDraft): Promise<NoteWrite> {
  const key = normalizeNoteKey(note.key);
  assertBytes(note.content);
  const searchText = [note.title ?? "", key].filter(Boolean).join(" ").slice(0, SEARCH_TEXT_MAX);
  const row = await upsertNote(store, actor, {
    key,
    title: note.title ?? null,
    contentText: note.content,
    searchText,
    startingAccess: note.startingAccess ?? [creatorGrant(actor)],
    ...(note.expectedVersion !== undefined ? { expectedVersion: note.expectedVersion } : {}),
  });
  return { href: rowDisplayPath(row), row };
}

/** A live note's new text, and the version it replaces when the writer read one. */
export type NoteRewrite = { content: string; expectedVersion?: number };

/**
 * Rewrites the live note a display path names, with write access to it, keeping its title and
 * search text. ArtifactError when the path names no live note of the actor's organisation that the
 * actor reads, and a 409 when the note is no longer at the expected version.
 */
export async function writeNoteAt(store: ArtifactStore, actor: ArtifactActor, href: string, rewrite: NoteRewrite): Promise<NoteWrite> {
  const parsed = parseDisplayPath(href);
  if (parsed.kind !== "artifact" || parsed.orgId !== actor.orgId) {
    throw new ArtifactError("artifact not found", 404);
  }
  const live = await loadParsed(store, parsed);
  if (!live || live.kind !== "note") {
    throw new ArtifactError("artifact not found", 404);
  }
  await assertRead(store, actor, live);
  assertBytes(rewrite.content);
  const row = await upsertNote(store, actor, {
    key: live.key,
    title: live.title,
    contentText: rewrite.content,
    searchText: live.search_text,
    startingAccess: [creatorGrant(actor)],
    ...(rewrite.expectedVersion !== undefined ? { expectedVersion: rewrite.expectedVersion } : {}),
  });
  return { href: rowDisplayPath(row), row };
}

/** A live note the actor reads, with its display path and its access list. */
export type NoteAccess = { href: string; row: ArtifactRow; access: AccessEntry[] };

/**
 * The live notes the actor reads whose display path or file name is one of `names`, in file name
 * order, each with its access list. Access lists are the operator's to read.
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
