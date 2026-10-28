import { createHash } from "node:crypto";
import { readAgentMode } from "../db/artifact-access.js";
import { countLiveArtifacts, type ArtifactRow } from "../db/artifacts.js";
import { formatOperationalTimestamp } from "../db/codecs.js";
import type { RecordRow } from "../db/collections.js";
import type { CollectionColumn, RecordBody, AccessMode } from "../db/schema/index.js";
import type { Queryable } from "../db/pg.js";
import { reachedMode } from "./access.js";
import { ArtifactError } from "./errors.js";
import { displayPathFor } from "./paths.js";
import {
  LIVE_ARTIFACTS_MAX,
  WRITE_MAX_BYTES,
  type ArtifactActor,
  type ArtifactKind,
  type ArtifactLevel,
} from "./types.js";

/** What notes, Memory, collections, records, and access lists are read and written through. */
export type ArtifactStore = {
  db: Queryable;
  /** The folder a new agent's task template is read from; empty for none. */
  templatesRoot: string;
};

export function artifactStore(db: Queryable, templatesRoot = ""): ArtifactStore {
  return { db, templatesRoot };
}

/** A collection as the operator or an agent sees it. */
export type CollectionView = {
  id: string;
  name: string;
  purpose: string;
  columns: CollectionColumn[];
  display_path: string;
  /** `guild` when the table belongs to one guild, `org` when it is an organisation table. */
  scope: "guild" | "org";
  guild: { id: string; name: string } | null;
  access: AccessMode;
  created_at: string;
  updated_at: string;
  count?: number;
};

export type RecordView = Record<string, unknown>;

/** A collection by name with the reader's mode on it. */
export type CollectionDescription = {
  id: string;
  name: string;
  purpose: string;
  columns: CollectionColumn[];
  guild_id: string | null;
  access: AccessMode;
};

/** A note, Memory, script, or file as a guild's state lists it. */
export type StateArtifact = {
  display_path: string;
  kind: "note" | "memory" | "script" | "file";
  level: ArtifactLevel;
  owner_id: string;
  title: string;
  /** Bytes of its text. */
  size: number;
  version: number;
  created_by: string;
  created_at: string;
  /** A note's id; null for Memory and scripts. */
  note_id: string | null;
};

/** A note a guild or an agent reaches, with the mode it ends up with. */
export type ReachedNote = {
  id: string;
  display_path: string;
  title: string;
  level: ArtifactLevel;
  owner_id: string;
  /** The name of the organisation, guild, or agent that owns the note. */
  owner_name: string;
  /** The guild of a guild or agent note; null for an organisation note. */
  guild_id: string | null;
  mode: AccessMode;
};

/** A table a guild or an agent reaches, with the mode it ends up with. */
export type ReachedTable = Pick<CollectionView, "id" | "name" | "purpose" | "display_path" | "scope" | "guild"> & {
  mode: AccessMode;
};

/** The owner an artifact at a level sits under for an actor. */
export type ArtifactOwnerRef = { orgId: string; ownerId: string; guildId: string | null; agentId: string | null };

/** The owner a level names for the actor: itself, its own guild, or the organisation. */
export function ownerFor(actor: ArtifactActor, level: ArtifactLevel): ArtifactOwnerRef {
  if (level === "agent") {
    if (!actor.agentId) throw new ArtifactError("write not allowed", 422);
    return { orgId: actor.orgId, ownerId: actor.agentId, guildId: actor.guildId, agentId: actor.agentId };
  }
  if (level === "guild") {
    if (!actor.guildId) throw new ArtifactError("write not allowed", 422);
    return { orgId: actor.orgId, ownerId: actor.guildId, guildId: actor.guildId, agentId: null };
  }
  return { orgId: actor.orgId, ownerId: actor.orgId, guildId: null, agentId: null };
}

export function assertBytes(content: string): void {
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
    throw new ArtifactError("write exceeds 256 KB", 422);
  }
}

/** A 422 when the owner already holds the most live notes, Memory, scripts, and files it may. */
export async function assertLiveCount(
  store: ArtifactStore,
  orgId: string,
  level: ArtifactLevel,
  ownerId: string,
): Promise<void> {
  const count = await countLiveArtifacts(store.db, { org_id: orgId, level, owner_id: ownerId });
  if (count >= LIVE_ARTIFACTS_MAX) {
    throw new ArtifactError("artifact limit reached", 422);
  }
}

/** Whether a guild- or agent-level owner sits in a private guild the operator actor cannot see. */
function isHiddenOwner(actor: ArtifactActor, level: ArtifactLevel, ownerId: string): boolean {
  if (level === "guild") {
    return actor.hidden.guildIds.includes(ownerId);
  }
  return level === "agent" && actor.hidden.agentIds.includes(ownerId);
}

/**
 * Whether the actor reaches what an owner holds outside any access list: a
 * Task, a Memory, a script, a Memory revision. The operator reaches all but
 * hidden guilds'; an agent reaches its own.
 */
export function reachesOwner(actor: ArtifactActor, level: ArtifactLevel, ownerId: string): boolean {
  if (actor.operator) {
    return !isHiddenOwner(actor, level, ownerId);
  }
  return level === "agent" && ownerId === actor.agentId;
}

/**
 * The actor's mode on a note, file, Memory, or script: the operator writes all
 * but hidden guilds' items, an agent writes its own, and a note or a file
 * follows its access list. Null when the actor does not reach it.
 */
export async function artifactMode(store: ArtifactStore, actor: ArtifactActor, row: ArtifactRow): Promise<AccessMode | null> {
  if (row.org_id !== actor.orgId) {
    return null;
  }
  if (actor.operator || (row.level === "agent" && row.owner_id === actor.agentId)) {
    return reachesOwner(actor, row.level, row.owner_id) ? "write" : null;
  }
  if (row.kind !== "note" && row.kind !== "file") {
    return null;
  }
  return reachedMode(await readAgentMode(store.db, actor, { kind: row.kind, id: row.id }));
}

/** The actor's mode on the row, or a 404 when it does not reach it. */
export async function assertRead(store: ArtifactStore, actor: ArtifactActor, row: ArtifactRow): Promise<AccessMode> {
  const mode = await artifactMode(store, actor, row);
  if (!mode) {
    throw new ArtifactError("artifact not found", 404);
  }
  return mode;
}

/** A 404 when the actor does not reach the row, a 422 when it only reads it. */
export async function assertWrite(store: ArtifactStore, actor: ArtifactActor, row: ArtifactRow): Promise<void> {
  if ((await assertRead(store, actor, row)) !== "write") {
    throw new ArtifactError("write not allowed", 422);
  }
}

/** The display path of an artifact row. */
export function rowDisplayPath(row: ArtifactRow): string {
  return displayPathFor(rowAsDisplay(row));
}

/** What `displayPathFor` needs of a row. */
export function rowAsDisplay(row: ArtifactRow): {
  orgId: string;
  level: ArtifactLevel;
  ownerId: string;
  kind: ArtifactKind;
  collectionName?: string | null;
  path: string;
  key: string;
} {
  return {
    orgId: row.org_id,
    level: row.level,
    ownerId: row.owner_id,
    kind: row.kind,
    collectionName: row.collection_name,
    path: row.path,
    key: row.key,
  };
}

export function hashArtifactContent(text: string | null, json: unknown = null): string {
  const body = text ?? JSON.stringify(json ?? {});
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** A record's body: its declared columns, as stored. */
export function bodyOf(row: RecordRow): RecordBody {
  return { ...row.content_json };
}

/** Whether an artifact's row is a record's: of kind `object`, its content the record's body. */
export function isRecordRow(row: ArtifactRow): row is RecordRow {
  return row.kind === "object";
}

/** A note, Memory, script, or file as tools and the API return it; a record as `recordView` does. */
export function artifactView(row: ArtifactRow): Record<string, unknown> {
  if (isRecordRow(row)) {
    return recordViewWithPath(row);
  }
  return {
    display_path: rowDisplayPath(row),
    kind: row.kind,
    level: row.level,
    key: row.key,
    title: row.title,
    author: row.updated_by_name,
    version: row.version,
    updated_at: formatOperationalTimestamp(row.updated_at),
    ...(row.access ? { access: row.access } : {}),
    content: row.content_text,
  };
}

/**
 * A record as tools and the API return it: the id, the declared columns,
 * then the system columns from the row.
 */
export function recordView(row: RecordRow): RecordView {
  return {
    id: Number(row.key),
    collection: row.collection_name,
    ...bodyOf(row),
    created_at: formatOperationalTimestamp(row.created_at),
    updated_at: formatOperationalTimestamp(row.updated_at),
    updated_by: row.updated_by_name,
    version: row.version,
  };
}

/** A record as `recordView` returns it, with its display path after its collection. */
export function recordViewWithPath(row: RecordRow): RecordView {
  return {
    id: Number(row.key),
    collection: row.collection_name,
    display_path: rowDisplayPath(row),
    ...bodyOf(row),
    created_at: formatOperationalTimestamp(row.created_at),
    updated_at: formatOperationalTimestamp(row.updated_at),
    updated_by: row.updated_by_name,
    version: row.version,
  };
}

/** A note as the Host lists it: `path` is its file name, `id` names it to the access API. */
export function hostNoteView(row: ArtifactRow): Record<string, unknown> {
  return {
    id: row.id,
    path: row.key,
    display_path: rowDisplayPath(row),
    kind: row.kind,
    title: row.title,
    version: row.version,
  };
}
