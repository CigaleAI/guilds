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
import { formatColumnTimestamp } from "../db/codecs.js";
import { recordFileChange } from "../db/file-changes.js";
import { type Queryable, stamp, withTransaction } from "../db/pg.js";
import { ArtifactError } from "./errors.js";
import { HISTORY_ARCHIVE_SEGMENT, MEMORY_KEY, revisionDisplayPath } from "./paths.js";
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
type MemoryOwner = { orgId: string; guildId: string; agentId: string };

/** The rows a new agent starts with: its empty Memory. */
export async function ensureAgentRows(
  store: ArtifactStore,
  args: MemoryOwner & { actor: ArtifactActor },
): Promise<void> {
  await createMemory(store, args.actor, args);
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

/** Archives the Memory text `live` holds, keeping the newest revisions; returns the stamp it is archived at. */
async function archiveMemory(
  client: Queryable,
  actor: ArtifactActor,
  replaced: { live: HashedArtifactRow; agentId: string; detail: string },
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
