import { createHash } from "node:crypto";
import {
  getMemoryRow as loadMemoryRow,
  insertMemoryRevision,
  insertMemoryRow,
  listMemoryRevisions,
  pruneMemoryRevisions,
  updateMemoryContent,
  type ArtifactRow,
  type HashedArtifactRow,
} from "../db/artifacts.js";
import { compareColumnTimestamps, formatColumnTimestamp } from "../db/codecs.js";
import { recordFileChange } from "../db/file-changes.js";
import { type Queryable, stamp, withTransaction } from "../db/pg.js";
import { ArtifactError } from "./errors.js";
import { displayPathFor, HISTORY_ARCHIVE_SEGMENT, MEMORY_KEY, revisionDisplayPath } from "./paths.js";
import { assertBytes, hashArtifactContent, reachesOwner, type ArtifactStore, rowDisplayPath } from "./store.js";
import { MEMORY_REVISIONS_MAX, type ArtifactActor } from "./types.js";

/** The text an agent's Memory holds before anything writes it. */
export const EMPTY_MEMORY = "";

/** A previous Memory version as the operator reads it, with the file name the archive gives it. */
export type MemoryRevisionView = {
  id: string;
  content: string;
  display_path: string;
  path: string;
  replaced_at: string;
  replaced_by: { type: "user" | "agent" | "run"; id: string; name: string; detail: string };
};

/** A Memory write: the new text, why it changed, and the version it replaces when the writer read one. */
export type MemoryWrite = { content: string; detail: string; expectedVersion?: number };

/** A Memory as written: its display path and its row. */
export type WrittenMemory = { href: string; row: ArtifactRow };

/** Where an agent's Memory sits: its organisation, its guild, and the agent. */
export type MemoryOwner = { orgId: string; guildId: string; agentId: string };

/** The rows a new agent starts with: its empty Memory. */
export async function ensureAgentRows(store: ArtifactStore, actor: ArtifactActor, owner: MemoryOwner): Promise<void> {
  await createMemory(store, actor, owner);
}

/** Creates an agent's empty Memory, logging its creation against `actor`; a Memory it already has stays. */
async function createMemory(store: ArtifactStore, actor: ArtifactActor, owner: MemoryOwner): Promise<void> {
  await withTransaction(store.db, async (client) => {
    const now = new Date();
    const row = await insertMemoryRow(
      client,
      {
        org_id: owner.orgId,
        guild_id: owner.guildId,
        agent_id: owner.agentId,
        key: MEMORY_KEY,
        content_text: EMPTY_MEMORY,
        content_hash: hashArtifactContent(EMPTY_MEMORY),
      },
      actor,
      now,
    );
    if (row) {
      await recordFileChange(client, actor, {
        orgId: row.org_id,
        artifactId: row.id,
        displayPath: rowDisplayPath(row),
        operation: "create",
        version: row.version,
        createdAt: now,
      });
    }
  });
}

/** The Memory text a prompt reads from the agent's Memory row: empty when it has none. */
export function storedMemoryText(row: HashedArtifactRow | null): string {
  return row?.content_text || EMPTY_MEMORY;
}

/** The agent's live Memory row with the hash of its text, read on `client` when one is given. */
export async function getMemoryRow(
  store: ArtifactStore,
  actor: ArtifactActor,
  agentId: string,
  client?: Queryable,
): Promise<HashedArtifactRow | null> {
  return loadMemoryRow(client ?? store.db, actor.orgId, agentId);
}

/** An agent's Memory as an actor reads it: the live version and its text. */
export type MemoryVersion = { version: number; content: string };

/** The agent's Memory as `actor` reads it in its organisation; version 0 and the empty text when the agent has no Memory row. */
export async function readMemoryVersion(
  store: ArtifactStore,
  actor: ArtifactActor,
  agentId: string,
): Promise<MemoryVersion> {
  const row = await getMemoryRow(store, actor, agentId);
  return { version: row?.version ?? 0, content: storedMemoryText(row) };
}

/**
 * Replaces the agent's Memory with `content`, archiving the text it replaces with `detail`, and
 * returns its display path with its row. An agent writes its own Memory; the operator writes any
 * it reaches.
 */
export async function writeMemory(
  store: ArtifactStore,
  actor: ArtifactActor,
  agentId: string,
  write: MemoryWrite,
): Promise<WrittenMemory> {
  if (!actor.operator && actor.agentId !== agentId) {
    throw new ArtifactError("memory is not writable", 422);
  }
  assertBytes(write.content);
  const live = await liveMemory(store, actor, agentId);
  if (write.expectedVersion !== undefined && live.version !== write.expectedVersion) {
    throw new ArtifactError("version conflict", 409);
  }
  const hash = hashArtifactContent(write.content);
  return withTransaction(store.db, async (client) => {
    const now = new Date();
    const writtenAt =
      live.content_hash === hash
        ? stamp(now)
        : await archiveMemory(client, actor, { live, agentId, detail: write.detail }, now);
    const row = await updateMemoryContent(
      client,
      { id: live.id, content_text: write.content, search_text: MEMORY_KEY, content_hash: hash, written_at: writtenAt },
      actor,
    );
    const href = rowDisplayPath(row);
    await recordFileChange(client, actor, {
      orgId: row.org_id,
      artifactId: row.id,
      displayPath: href,
      operation: "update",
      version: row.version,
    });
    return { href, row };
  });
}

/** The agent's Memory, created empty first when its guild is known and it has none. */
async function liveMemory(store: ArtifactStore, actor: ArtifactActor, agentId: string): Promise<HashedArtifactRow> {
  const existing = await loadMemoryRow(store.db, actor.orgId, agentId);
  if (existing) {
    return existing;
  }
  if (!actor.guildId) {
    throw new ArtifactError("memory.md not found", 404);
  }
  await createMemory(store, actor, { orgId: actor.orgId, guildId: actor.guildId, agentId });
  const created = await loadMemoryRow(store.db, actor.orgId, agentId);
  if (!created) {
    throw new ArtifactError("memory.md not found", 404);
  }
  return created;
}

/** The Memory a write replaces: its live row, its agent, and why it changed. */
type ReplacedMemory = { live: HashedArtifactRow; agentId: string; detail: string };

/** Archives the Memory text `live` holds, keeping the newest revisions; returns the stamp it is archived at. */
async function archiveMemory(
  client: Queryable,
  actor: ArtifactActor,
  replaced: ReplacedMemory,
  now: Date,
): Promise<string> {
  const { live, agentId, detail } = replaced;
  const writtenAt = await insertMemoryRevision(
    client,
    { org_id: live.org_id, agent_id: agentId, content_text: live.content_text ?? "", replaced_by_detail: detail },
    actor,
    now,
  );
  await pruneMemoryRevisions(client, live.org_id, agentId, MEMORY_REVISIONS_MAX);
  return writtenAt;
}

/** Previous memory versions, newest first. Only the operator reads them; agents never see the archive. */
export async function listRevisions(
  store: ArtifactStore,
  actor: ArtifactActor,
  agentId: string,
): Promise<MemoryRevisionView[]> {
  if (!actor.operator || !reachesOwner(actor, "agent", agentId)) {
    return [];
  }
  return (await listMemoryRevisions(store.db, actor.orgId, agentId)).map((row) => {
    const replacedAt = formatColumnTimestamp(row.replaced_at);
    const stampName = archiveStamp(replacedAt, row.replaced_by_name);
    return {
      id: row.id,
      content: row.content_text,
      display_path: revisionDisplayPath(actor.orgId, agentId, stampName),
      path: `${HISTORY_ARCHIVE_SEGMENT}/${stampName}`,
      replaced_at: replacedAt,
      replaced_by: {
        type: revisionActorType(row.replaced_by_type),
        id: row.replaced_by_id,
        name: row.replaced_by_name,
        detail: row.replaced_by_detail,
      },
    };
  });
}

function revisionActorType(value: string): MemoryRevisionView["replaced_by"]["type"] {
  return value === "agent" || value === "run" ? value : "user";
}

/** The archive file name of a revision: its UTC stamp and who replaced it. */
export function archiveStamp(replacedAt: string, source: string): string {
  const date = new Date(replacedAt);
  const stampName = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "T");
  const token = source.trim().replaceAll("/", "-").replaceAll(":", "-") || "unknown";
  return `${stampName}-${token}.md`;
}

// A memory timeline is the ordered list of versions an agent's memory has
// held. Revision rows archive the outgoing body and record who replaced it,
// so revision k holds version k-1 and names the author and time of version
// k. The live row is the newest version. The oldest archived version has no
// recorded author.

export type MemoryTimelineActor = {
  type: "user" | "agent" | "run" | "unknown";
  id: string | null;
  name: string | null;
  detail: string | null;
};

export type MemoryTimelineRevision = {
  id: string;
  content: string;
  display_path: string;
  replaced_at: string;
  replaced_by: { type: "user" | "agent" | "run"; id: string; name: string; detail: string };
};

export type MemoryTimelineEntry = {
  index: number;
  revision_id: string | null;
  archive_display_path: string | null;
  written_at: string | null;
  actor: MemoryTimelineActor;
  run_id: string | null;
  content: string;
  content_hash: string;
  previous_content: string | null;
  stats: { added: number; removed: number };
};

const UNKNOWN_ACTOR: MemoryTimelineActor = { type: "unknown", id: null, name: null, detail: null };

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nonBlankMemoryLines(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

function lineMultisetDelta(before: string, after: string): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of nonBlankMemoryLines(before)) counts.set(line, (counts.get(line) ?? 0) - 1);
  for (const line of nonBlankMemoryLines(after)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const delta of counts.values()) {
    if (delta > 0) added += delta;
    else if (delta < 0) removed -= delta;
  }
  return { added, removed };
}

export function lineChangeStats(before: string, after: string): { added: number; removed: number } {
  return lineMultisetDelta(before, after);
}

function chronologicalRevisions(revisions: MemoryTimelineRevision[]): MemoryTimelineRevision[] {
  return [...revisions].sort((left, right) => {
    const byTime = compareColumnTimestamps(left.replaced_at, right.replaced_at);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

function actorWhoWroteVersion(writer: MemoryTimelineRevision | null): MemoryTimelineActor {
  if (!writer) {
    return UNKNOWN_ACTOR;
  }
  return {
    type: writer.replaced_by.type,
    id: writer.replaced_by.id,
    name: writer.replaced_by.name,
    detail: writer.replaced_by.detail,
  };
}

function runIdOfActor(actor: MemoryTimelineActor): string | null {
  return actor.type === "run" ? actor.id : null;
}

function changeStatsFromPrevious(previous: string | null, content: string): { added: number; removed: number } {
  if (previous === null) {
    return { added: 0, removed: 0 };
  }
  return lineChangeStats(previous, content);
}

/** One version a Memory has held: its text, and the revision that archives it; null for the live version. */
type TimelineVersion = { content: string; revision: MemoryTimelineRevision | null };

/** The timeline entry of the version at `index`, against the version before it and the revision that names its writer. */
function timelineEntryAt(
  index: number,
  version: TimelineVersion,
  previousVersion: TimelineVersion | null,
  writer: MemoryTimelineRevision | null,
): MemoryTimelineEntry {
  const actor = actorWhoWroteVersion(writer);
  const previous = previousVersion?.content ?? null;
  return {
    index,
    revision_id: version.revision?.id ?? null,
    archive_display_path: version.revision?.display_path ?? null,
    written_at: writer?.replaced_at ?? null,
    actor,
    run_id: runIdOfActor(actor),
    content: version.content,
    content_hash: hashText(version.content),
    previous_content: previous,
    stats: changeStatsFromPrevious(previous, version.content),
  };
}

/** What a Memory has held: its live text, and the revisions archived before it. */
export type MemoryHistory = { live: { content: string }; revisions: MemoryTimelineRevision[] };

export function buildMemoryTimeline(args: MemoryHistory): MemoryTimelineEntry[] {
  const chronological = chronologicalRevisions(args.revisions);
  const versions: TimelineVersion[] = [
    ...chronological.map((revision) => ({ content: revision.content, revision })),
    { content: args.live.content, revision: null },
  ];
  const entries = versions.map((version, index) =>
    timelineEntryAt(
      index,
      version,
      index > 0 ? versions[index - 1]! : null,
      index > 0 ? chronological[index - 1]! : null,
    ),
  );
  return entries.reverse();
}

// A compact account of what a version changed: removed lines prefixed with
// "-", added lines with "+".
export function memoryDiffText(before: string, after: string): string {
  const prev = nonBlankMemoryLines(before);
  const next = nonBlankMemoryLines(after);
  const removed = prev.filter((line) => !next.includes(line));
  const added = next.filter((line) => !prev.includes(line));
  return [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)].join("\n");
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
