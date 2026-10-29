import { deleteAccessList } from "../db/artifact-access.js";
import {
  getArtifactAt,
  getArtifactOrTombstoneAt,
  getLiveNote,
  getMemoryRevisionText,
  insertNote,
  listAgentsEmbedding,
  listArtifactsByKind,
  listGuildArtifacts,
  listOwnerArtifacts,
  listReadableNotes,
  searchArtifactsByKind,
  softDeleteArtifact,
  updateNoteContent,
  type ArtifactAddress,
  type ArtifactOrTombstoneRow,
  type ArtifactRow,
} from "../db/artifacts.js";
import { getRecordOrTombstone } from "../db/collections.js";
import { recordFileChange } from "../db/file-changes.js";
import { isUniqueViolation, withTransaction } from "../db/pg.js";
import { createsWritable, defaultGrants } from "./access.js";
import { deleteCollection, describeCollection, loadCollectionByName, requireReadable } from "./collections.js";
import { ArtifactError } from "./errors.js";
import { writeGrants } from "./grants.js";
import { listRevisions } from "./memory.js";
import { listAccess } from "./access-lists.js";
import {
  assertNoteKeyFree,
  displayPathFor,
  isDisplayPath,
  normalizeNoteKey,
  parseDisplayPath,
  revisionDisplayPath,
  TASK_KEY,
  type ParsedDisplayPath,
} from "./paths.js";
import { removeRecord } from "./records.js";
import { parseRecordId } from "./search.js";
import { artifactMode, artifactView, assertBytes, assertLiveCount, assertRead, assertWrite, hashArtifactContent, hostNoteView, isRecordRow, ownerFor, reachesOwner, recordViewWithPath, type ArtifactOwnerRef, type ArtifactStore, type StateArtifact, rowDisplayPath } from "./store.js";
import {
  FIND_DEFAULT,
  FIND_MAX,
  SEARCH_TEXT_MAX,
  type AccessEntry,
  type ArtifactActor,
  type ArtifactLevel,
} from "./types.js";

/** A parsed display path that names a note, file, Memory, or script by where it sits. */
export type ArtifactPath = Extract<ParsedDisplayPath, { kind: "artifact" }>;

/** What a read of a display path finds: a live row, a tombstone, or an archived Memory revision. */
export type DisplayPathRead = {
  row?: ArtifactRow;
  revision?: { content: string; display_path: string };
  tombstone?: boolean;
};

/** A note's text as a write sets it, at its owner, folder, and file name. */
export type NoteUpsert = {
  level: ArtifactLevel;
  owner: ArtifactOwnerRef;
  path: string;
  key: string;
  title: string | null;
  contentText: string;
  searchText: string | null;
  expectedVersion?: number;
};

function addressOf(parsed: ArtifactPath): ArtifactAddress {
  return { org_id: parsed.orgId, level: parsed.level, owner_id: parsed.ownerId, path: parsed.path, key: parsed.key };
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

/** Writes a note: the live one at its address with write access to it, else a new one with its starting access list. */
export async function upsertNote(store: ArtifactStore, actor: ArtifactActor, note: NoteUpsert): Promise<ArtifactRow> {
  return withTransaction(store.db, async (client) => {
    const address = { org_id: note.owner.orgId, level: note.level, owner_id: note.owner.ownerId, path: note.path, key: note.key };
    const live = await getLiveNote(client, address);
    const hash = hashArtifactContent(note.contentText);
    if (live) {
      if ((await artifactMode(store, actor, live)) !== "write") {
        throw new ArtifactError("write not allowed", 422);
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
    if (!actor.operator && !createsWritable(note.level)) {
      throw new ArtifactError("write not allowed", 422);
    }
    let row: ArtifactRow;
    try {
      row = await insertNote(
        client,
        {
          ...address,
          guild_id: note.owner.guildId,
          agent_id: note.owner.agentId,
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
    await writeGrants(client, actor, { kind: "note", id: row.id }, defaultGrants(row.level, row.owner_id));
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

/** Deletes the note or script a display path names, refusing a task, Memory, a file, or an embedded note. */
async function deleteNoteAt(store: ArtifactStore, actor: ArtifactActor, parsed: ArtifactPath): Promise<void> {
  if (parsed.level === "agent" && parsed.path === "" && parsed.key === TASK_KEY) {
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
    await deleteAccessList(client, { kind: "note", id: row.id });
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
  parsed: Extract<ParsedDisplayPath, { kind: "revision" }>,
): Promise<{ content: string; display_path: string }> {
  if (parsed.orgId !== actor.orgId) {
    throw new ArtifactError("artifact is not in this organisation", 404);
  }
  if (!actor.operator || !reachesOwner(actor, "agent", parsed.agentId)) {
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
    return actor.operator && reachesOwner(actor, "agent", parsed.agentId);
  }
  const row = await loadParsedOrTombstone(store, parsed);
  if (!row) {
    return reachesOwner(actor, parsed.level, parsed.ownerId);
  }
  return (await artifactMode(store, actor, row)) !== null;
}

/** Notes the actor may read, searched by `query` or listed, optionally at one level. */
export async function findNotes(
  store: ArtifactStore,
  actor: ArtifactActor,
  args: { query?: string; level?: ArtifactLevel; limit?: number },
): Promise<{ notes: Array<Record<string, unknown>> }> {
  const limit = Math.min(Math.max(args.limit ?? FIND_DEFAULT, 1), FIND_MAX);
  const query = (args.query ?? "").trim();
  const rows = query
    ? await searchArtifactsByKind(store.db, actor, "note", { query, level: args.level, limit })
    : await listArtifactsByKind(store.db, actor, "note", { level: args.level, limit });
  return { notes: rows.map(artifactView) };
}

/** The notes one owner holds, as the Host lists them. */
export async function listOwnerNotes(
  store: ArtifactStore,
  actor: ArtifactActor,
  level: ArtifactLevel,
  ownerId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await listOwnerArtifacts(store.db, actor, { level, owner_id: ownerId, kind: "note" });
  return rows.map(hostNoteView);
}

/** The owners of one guild's state: the guild and its agents. */
export type StateOwners = { guildId: string; agentIds: string[] };

/**
 * The notes, Memory, scripts, and files of one guild's state the actor can read: its own,
 * its agents', and the organisation's.
 */
export async function listStateArtifacts(
  store: ArtifactStore,
  actor: ArtifactActor,
  owners: StateOwners,
): Promise<StateArtifact[]> {
  return (await listGuildArtifacts(store.db, actor, owners)).map((row) => ({
    display_path: rowDisplayPath(row),
    kind: stateKind(row.kind),
    level: row.level,
    owner_id: row.owner_id,
    // A script's or a file's title column holds its description; its key is its name.
    title: row.kind === "script" || row.kind === "file" ? row.key : (row.title ?? row.key),
    size: row.bytes ?? Buffer.byteLength(row.content_text ?? JSON.stringify(row.content_json ?? ""), "utf8"),
    version: row.version,
    created_by: row.created_by_name,
    created_at: row.created_at,
    note_id: row.kind === "note" ? row.id : null,
  }));
}

/** The kind a state listing shows: its query reads notes, Memory, scripts, and files alone. */
function stateKind(kind: ArtifactRow["kind"]): StateArtifact["kind"] {
  return kind === "object" ? "note" : kind;
}

/** A live note with its display path. */
export type LiveNote = { href: string; row: ArtifactRow };

/**
 * The live notes of one guild's state the actor reads, with their text: each of its agents', then
 * its own, then the organisation's, each owner's in file name order. A note the store refuses to
 * read, an `ArtifactError`, is left out; any other failure throws.
 */
export async function readStateNotes(store: ArtifactStore, actor: ArtifactActor, owners: StateOwners): Promise<LiveNote[]> {
  const levels: Array<[ArtifactLevel, string]> = [
    ...owners.agentIds.map((id): [ArtifactLevel, string] => ["agent", id]),
    ["guild", owners.guildId],
    ["org", actor.orgId],
  ];
  const listed = await Promise.all(
    levels.map(([level, ownerId]) => listOwnerArtifacts(store.db, actor, { level, owner_id: ownerId, kind: "note" })),
  );
  const notes = await Promise.all(
    listed.flat().map(async (listedRow): Promise<LiveNote | null> => {
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
    level: live.level,
    owner: { orgId: live.org_id, ownerId: live.owner_id, guildId: live.guild_id, agentId: live.agent_id },
    path: live.path,
    key: live.key,
    title: live.title,
    contentText: rewrite.content,
    searchText: live.search_text,
    ...(rewrite.expectedVersion !== undefined ? { expectedVersion: rewrite.expectedVersion } : {}),
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
