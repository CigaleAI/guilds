import { createHash } from "node:crypto";
import { isHiddenByList, readAgentMode, type ArtifactMode } from "../db/artifact-access.js";
import type { AgentViewerMode, GuildViewerMode, PageArtifactRow, SectionedArtifactRow } from "../db/artifact-lists.js";
import { countLiveNotesAndFiles, type ArtifactRow } from "../db/artifacts.js";
import { formatOperationalTimestamp } from "../db/codecs.js";
import type { RecordRow } from "../db/collections.js";
import type { GuildRow } from "../db/guilds.js";
import type { ArtifactContent, CollectionColumn, RecordBody, RecordValue, AccessMode } from "../db/schema/index.js";
import type { Queryable } from "../db/pg.js";
import { reachedMode } from "./access.js";
import { ArtifactError } from "./errors.js";
import { displayPathFor, type ArtifactLocation } from "./paths.js";
import {
  LIVE_ARTIFACTS_MAX,
  WRITE_MAX_BYTES,
  type ArtifactActor,
  type ArtifactKind,
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

/**
 * A record's own fields as tools and the API return them: its id and collection, its display path
 * where the caller gives it, and who last wrote it, when, and at which version.
 */
type RecordFields = {
  id: number;
  collection: string | null;
  display_path?: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  version: number;
};

/** A record as tools and the API return it: its own fields, and its value in each column it fills, by column name. */
export type RecordView = RecordFields & { [column: string]: RecordValue | null };

/** A note, Memory, script, or file as tools and the API return it: where it sits, who wrote it last and when, and its text. */
export type ArtifactTextView = {
  display_path: string;
  kind: ArtifactKind;
  key: string;
  title: string | null;
  author: string;
  version: number;
  updated_at: string;
  /** The reader's mode, on a row read for a reader. */
  access?: ArtifactMode;
  content: string | null;
};

/** The guild a note or a file is homed in: the guild it was made in, which groups the lists it shows in. */
export type ItemHome = Pick<GuildRow, "id" | "name">;

/** The mode a page's viewer has on an item it lists: an organisation's or a guild's, or an agent's. */
export type ViewerMode = GuildViewerMode | AgentViewerMode;

/**
 * A note as the Host lists it: `path` is its file name, `id` names it to the access API, `home` is
 * the guild it is homed in (null for the organisation), and `viewer_mode` is the mode of the page's
 * viewer on it.
 */
export type HostNoteView<Mode extends ViewerMode> = Pick<ArtifactTextView, "display_path" | "kind" | "title" | "version"> & {
  id: string;
  path: string;
  home: ItemHome | null;
  viewer_mode: Mode;
};

/** What a guild's or an agent's page lists: the items homed in its guild, and those shared with the guild from elsewhere. */
export type PageSections<View> = { own: View[]; shared: View[] };

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
  /** The agent whose Memory or script it is; null for a note or a file. */
  agent_id: string | null;
  title: string;
  /** Bytes of its text. */
  size: number;
  version: number;
  created_by: string;
  created_at: string;
  /** A note's id; null for Memory and scripts. */
  note_id: string | null;
  /** Its artifact's id. */
  artifact_id: string;
};

/** A note a guild or an agent reaches, with the mode it ends up with. */
export type ReachedNote = {
  id: string;
  display_path: string;
  title: string;
  mode: AccessMode;
};

/** A table a guild or an agent reaches, with the mode it ends up with. */
export type ReachedTable = Pick<CollectionView, "id" | "name" | "purpose" | "display_path" | "scope" | "guild"> & {
  mode: AccessMode;
};

export function assertBytes(content: string): void {
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
    throw new ArtifactError("write exceeds 256 KB", 422);
  }
}

/** A 422 when the organisation already holds the most live notes and files it may. */
export async function assertLiveCount(store: ArtifactStore, orgId: string): Promise<void> {
  if ((await countLiveNotesAndFiles(store.db, orgId)) >= LIVE_ARTIFACTS_MAX) {
    throw new ArtifactError("artifact limit reached", 422);
  }
}

/**
 * Whether the actor reaches what one agent holds outside any access list: its Task, Memory,
 * scripts, and Memory revisions. The operator reaches every agent's but a hidden guild's; an agent
 * reaches its own.
 */
export function reachesAgent(actor: ArtifactActor, agentId: string): boolean {
  if (actor.operator) {
    return !actor.hidden.agentIds.includes(agentId);
  }
  return agentId === actor.agentId;
}

/**
 * Whether a note or a file is hidden from an operator actor: it is homed in a guild hidden from them,
 * or its list names only guilds and agents it does not reach.
 */
export async function isHiddenItem(
  store: ArtifactStore,
  actor: ArtifactActor,
  row: Pick<ArtifactRow, "id" | "kind" | "origin_guild_id">,
): Promise<boolean> {
  if (row.kind !== "note" && row.kind !== "file") {
    return false;
  }
  if (row.origin_guild_id !== null && actor.hidden.guildIds.includes(row.origin_guild_id)) {
    return true;
  }
  return isHiddenByList(store.db, { kind: row.kind, id: row.id }, actor.hidden);
}

/**
 * The actor's mode on a note, file, Memory, or script: an agent's Memory and scripts are written by
 * that agent and the operators who reach it; a note or a file is written by every operator it is not
 * hidden from, and reached by an agent through its access list. Null when the actor does not reach it.
 */
export async function artifactMode(store: ArtifactStore, actor: ArtifactActor, row: ArtifactRow): Promise<AccessMode | null> {
  if (row.org_id !== actor.orgId) {
    return null;
  }
  if (row.agent_id !== null) {
    return reachesAgent(actor, row.agent_id) ? "write" : null;
  }
  if (row.kind !== "note" && row.kind !== "file") {
    return null;
  }
  if (actor.operator) {
    return (await isHiddenItem(store, actor, row)) ? null : "write";
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
export function rowAsDisplay(row: ArtifactRow): ArtifactLocation {
  return {
    orgId: row.org_id,
    agentId: row.agent_id,
    kind: row.kind,
    collectionName: row.collection_name,
    path: row.path,
    key: row.key,
  };
}

export function hashArtifactContent(text: string | null, json: ArtifactContent | null = null): string {
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
export function artifactView(row: ArtifactRow): ArtifactTextView | RecordView {
  return isRecordRow(row) ? recordViewWithPath(row) : artifactTextView(row);
}

/** A note, Memory, script, or file as tools and the API return it. */
export function artifactTextView(row: ArtifactRow): ArtifactTextView {
  return {
    display_path: rowDisplayPath(row),
    kind: row.kind,
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

/** The guild a listed row is homed in; null for the organisation's. */
export function itemHome(row: PageArtifactRow<ViewerMode>): ItemHome | null {
  return row.origin_guild_id !== null && row.home_name !== null ? { id: row.origin_guild_id, name: row.home_name } : null;
}

/** A note as the Host lists it. */
export function hostNoteView<Mode extends ViewerMode>(row: PageArtifactRow<Mode>): HostNoteView<Mode> {
  return {
    id: row.id,
    path: row.key,
    display_path: rowDisplayPath(row),
    kind: row.kind,
    title: row.title,
    version: row.version,
    home: itemHome(row),
    viewer_mode: row.viewer_mode,
  };
}

/** A page's rows in their sections, each as `view` shows it: those homed in the page's guild, and the others. */
export function pageSections<Mode extends ViewerMode, View>(
  rows: Array<SectionedArtifactRow<Mode>>,
  view: (row: SectionedArtifactRow<Mode>) => View,
): PageSections<View> {
  return {
    own: rows.filter((row) => row.homed).map(view),
    shared: rows.filter((row) => !row.homed).map(view),
  };
}
