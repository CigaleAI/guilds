import {
  ArtifactError,
  ArtifactStore,
  hostFileDisplayPath,
  listLatestFileChanges,
  normalizeNoteKey,
  operatorActor,
  parseDisplayPath,
  type ArtifactActor,
  type ArtifactLevel,
  MEMORY_KEY,
  TASK_KEY,
} from "../artifacts/index.js";
import { taskDisplayPath } from "../agents/task.js";
import type { Repositories } from "../db/repositories.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import { artifactHttp, HttpError } from "./errors.js";

export async function ensureAgentArtifacts(
  store: ArtifactStore,
  actor: ArtifactActor,
  agent: { id: unknown; guild_id: unknown; org_id: unknown },
): Promise<void> {
  await store.ensureAgentRows({
    orgId: String(agent.org_id),
    guildId: String(agent.guild_id),
    agentId: String(agent.id),
    actor,
  });
}

export async function operatorFor(
  repo: Repositories,
  user: Record<string, unknown>,
  scope: { orgId: string; guildId?: string | null; agentId?: string | null },
): Promise<ArtifactActor> {
  return operatorActor({
    orgId: scope.orgId,
    actorId: String(user.id),
    actorName: String(user.name ?? "operator"),
    guildId: scope.guildId ?? null,
    agentId: scope.agentId ?? null,
    hidden: await repo.hiddenGuildsFor(scope.orgId, String(user.id)),
  });
}

// The newest recorded change per display path. Paths written before the
// change log existed fall back to the artifact row's last-saved facts, marked
// `recorded: false`, so a listing can still say who saved a file last.
export async function latestFileChanges(
  store: ArtifactStore,
  repo: Repositories,
  actor: ArtifactActor,
  displayPaths: string[],
): Promise<Record<string, unknown>> {
  const paths = await readablePaths(store, actor, [...new Set(displayPaths.filter((path) => path))]);
  const latest: Record<string, unknown> = await listLatestFileChanges(repo.pool, actor.orgId, paths);
  for (const path of paths) {
    if (latest[path]) {
      continue;
    }
    let parsed;
    try {
      parsed = parseDisplayPath(path);
    } catch {
      continue;
    }
    if (parsed.orgId !== actor.orgId || parsed.kind === "revision" || parsed.kind === "collection") {
      continue;
    }
    if (parsed.kind === "artifact" && parsed.level === "agent" && parsed.path === "" && parsed.key === TASK_KEY) {
      const task = await repo.getAgentTask(actor.orgId, parsed.ownerId);
      if (task) {
        latest[path] = fallbackChange(path, task.version, null, task.updated_at);
      }
      continue;
    }
    try {
      const loaded = await store.getByDisplayPath(actor, path);
      if (loaded.row && !loaded.tombstone) {
        latest[path] = fallbackChange(path, loaded.row.version, loaded.row.updated_by_name, loaded.row.updated_at);
      }
    } catch {
      /* unreadable or missing: no provenance */
    }
  }
  return latest;
}

/** The display paths the actor may read, in their order. */
async function readablePaths(store: ArtifactStore, actor: ArtifactActor, displayPaths: string[]): Promise<string[]> {
  const readable = await Promise.all(displayPaths.map((path) => store.canReadDisplayPath(actor, path)));
  return displayPaths.filter((_, index) => readable[index]);
}

function fallbackChange(displayPath: string, version: number, name: string | null, updatedAt: unknown): Record<string, unknown> {
  return {
    id: null,
    recorded: false,
    display_path: displayPath,
    operation: "update",
    version,
    actor: { type: "unknown", id: null, name },
    run: null,
    tool: null,
    created_at:
      updatedAt instanceof Date
        ? updatedAt.toISOString()
        : typeof updatedAt === "string" && updatedAt
          ? updatedAt.includes("T")
            ? updatedAt
            : formatColumnTimestamp(updatedAt)
          : null,
  };
}

/** The notes one owner holds, by file name. An agent's Task and Memory are read by name, not listed. */
export async function listHostFiles(
  store: ArtifactStore,
  actor: ArtifactActor,
  level: ArtifactLevel,
  ownerId: string,
): Promise<Array<Record<string, unknown>>> {
  return store.listOwnerNotes(actor, level, ownerId);
}

type HostFilePayload = {
  /** A note's id, which names it to the access API. */
  id?: string;
  path: string;
  content: string;
  display_path: string;
  version?: number;
  revisions?: Array<{
    version: number;
    content: string;
    replaced_at: string;
    replaced_by_name: string;
  }>;
};

async function withFileMeta(
  store: ArtifactStore,
  actor: ArtifactActor,
  ownerId: string,
  payload: HostFilePayload,
  kind?: string,
  version?: number,
  repo?: Repositories,
): Promise<HostFilePayload> {
  const next = { ...payload };
  if (version !== undefined) {
    next.version = version;
  }
  if (kind === "task" && repo) {
    next.revisions = (await repo.listAgentTaskRevisions(actor.orgId, ownerId)).map((row) => ({
      ...row,
      replaced_at: formatColumnTimestamp(row.replaced_at),
    }));
  }
  return next;
}

/** The file name the Host sends: a note key, or an agent's `task.md` or `memory.md`. */
function hostFileName(relative: string): string {
  return normalizeNoteKey((relative || "").trim().replace(/^\/+/, ""));
}

export async function readHostFile(
  store: ArtifactStore,
  actor: ArtifactActor,
  level: ArtifactLevel,
  ownerId: string,
  relative: string,
  repo?: Repositories,
): Promise<HostFilePayload> {
  const name = hostFileName(relative);
  if (level === "agent" && name === TASK_KEY && repo) {
    const row = await repo.getAgentTask(actor.orgId, ownerId);
    if (!row) {
      throw new ArtifactError("task.md not found", 404);
    }
    return withFileMeta(
      store,
      actor,
      ownerId,
      {
        path: name,
        display_path: taskDisplayPath(actor.orgId, ownerId),
        content: row.content_text,
      },
      "task",
      row.version,
      repo,
    );
  }
  const displayPath = hostFileDisplayPath(actor.orgId, level, ownerId, name);
  const loaded = await store.getByDisplayPath(actor, displayPath);
  if (loaded.tombstone || !loaded.row) {
    throw new ArtifactError("artifact not found", 404);
  }
  return withFileMeta(
    store,
    actor,
    ownerId,
    {
      ...(loaded.row.kind === "note" ? { id: loaded.row.id } : {}),
      path: name,
      display_path: displayPath,
      content: String(loaded.row.content_text ?? ""),
    },
    loaded.row.kind,
    loaded.row.version,
    repo,
  );
}

export async function writeHostFile(
  store: ArtifactStore,
  actor: ArtifactActor,
  level: ArtifactLevel,
  ownerId: string,
  relative: string,
  content: string,
  expectedVersion?: number,
  repo?: Repositories,
): Promise<HostFilePayload> {
  const name = hostFileName(relative);
  if (level === "agent" && name === TASK_KEY) {
    if (!repo) {
      throw new ArtifactError("task.md not found", 404);
    }
    const row = await repo.writeAgentTask(actor, ownerId, content, expectedVersion);
    return withFileMeta(
      store,
      actor,
      ownerId,
      { path: name, content, display_path: taskDisplayPath(actor.orgId, ownerId) },
      "task",
      row.version,
      repo,
    );
  }
  if (level === "agent" && name === MEMORY_KEY) {
    const row = await store.writeMemory(actor, ownerId, content, `host ${actor.actorName}`);
    return withFileMeta(
      store,
      actor,
      ownerId,
      { path: name, content, display_path: String(store.view(row).display_path) },
      "memory",
      row.version,
      repo,
    );
  }
  const row = await store.writeNote(actor, { level, key: name, content });
  return withFileMeta(
    store,
    actor,
    ownerId,
    { id: row.id, path: name, content, display_path: String(store.view(row).display_path) },
    row.kind,
    row.version,
    repo,
  );
}

export async function deleteHostFile(
  store: ArtifactStore,
  actor: ArtifactActor,
  level: ArtifactLevel,
  ownerId: string,
  relative: string,
): Promise<void> {
  await store.deleteByDisplayPath(actor, hostFileDisplayPath(actor.orgId, level, ownerId, hostFileName(relative)));
}

export function requireArtifacts(store: ArtifactStore | null | undefined): ArtifactStore {
  if (!store) {
    throw new HttpError(422, "artifact store is not available");
  }
  return store;
}

// ---------------------------------------------------------------------------
// Collections: the Tables page and the settings surfaces.

export async function listCollections(store: ArtifactStore, actor: ArtifactActor): Promise<Array<Record<string, unknown>>> {
  return store.listCollections(actor, { counts: true });
}

export async function createCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return store.createCollection(actor, {
    name: String(body.name ?? ""),
    purpose: String(body.purpose ?? ""),
    columns: body.columns ?? [],
    ...(body.guild_id !== undefined ? { guildId: body.guild_id === null ? null : String(body.guild_id) } : {}),
  });
}

export async function getCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<Record<string, unknown>> {
  return store.getCollection(actor, collectionId);
}

export async function updateCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return store.updateCollection(actor, collectionId, {
    ...(body.name !== undefined ? { name: String(body.name) } : {}),
    ...(body.purpose !== undefined ? { purpose: String(body.purpose) } : {}),
    ...(body.columns !== undefined ? { columns: body.columns } : {}),
    ...(body.guild_id !== undefined ? { guildId: body.guild_id === null ? null : String(body.guild_id) } : {}),
  });
}

export async function deleteCollection(store: ArtifactStore, actor: ArtifactActor, collectionId: string): Promise<void> {
  await store.deleteCollection(actor, collectionId);
}

export async function clearRecords(store: ArtifactStore, actor: ArtifactActor, collectionId: string): Promise<void> {
  await store.clearRecords(actor, collectionId);
}

function parseJsonQuery(raw: string | undefined, label: string): unknown {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(422, `${label} must be JSON`);
  }
}

/**
 * Records of a collection for the page: `query` runs the text search, the
 * rest are the `record_list` arguments (`where` and `order` as JSON).
 */
export async function listRecords(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  const collection = await store.getCollection(actor, collectionId);
  const text = (query.query ?? "").trim();
  if (text) {
    const found = await store.searchRecords(actor, {
      collection: collection.name,
      query: text,
      where: parseJsonQuery(query.where, "where"),
      limit: query.limit,
    });
    const records = found.records.map((record) => withDisplayPath(actor.orgId, collection.name, record));
    return { total: records.length, records, columns: collection.columns };
  }
  const listed = await store.listRecords(actor, {
    collection: collection.name,
    where: parseJsonQuery(query.where, "where"),
    since: query.since,
    order: parseJsonQuery(query.order, "order") ?? (query.order_by ? { column: query.order_by, direction: query.direction ?? "asc" } : undefined),
    limit: query.limit,
    offset: query.offset,
  });
  return {
    total: listed.total,
    records: listed.records.map((record) => withDisplayPath(actor.orgId, collection.name, record)),
    columns: listed.columns,
  };
}

function withDisplayPath(orgId: string, collectionName: string, record: Record<string, unknown>): Record<string, unknown> {
  return { ...record, display_path: `org/${orgId}/collections/${collectionName}/${String(record.id)}` };
}

export async function getRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  recordId: string,
): Promise<Record<string, unknown>> {
  const collection = await store.getCollection(actor, collectionId);
  const record = await store.getRecord(actor, collection.name, recordId);
  return withDisplayPath(actor.orgId, collection.name, record);
}

export async function addRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const collection = await store.getCollection(actor, collectionId);
  const result = await store.addRecord(actor, { collection: collection.name, body: asRecord(body) });
  return {
    record: withDisplayPath(actor.orgId, collection.name, result.record),
    merged: result.merged,
  };
}

export async function updateRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  recordId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const collection = await store.getCollection(actor, collectionId);
  const result = await store.updateRecord(actor, { collection: collection.name, id: recordId, body: asRecord(body) });
  return {
    record: withDisplayPath(actor.orgId, collection.name, result.record),
    warnings: result.warnings,
  };
}

export async function removeRecord(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
  recordId: string,
): Promise<void> {
  const collection = await store.getCollection(actor, collectionId);
  await store.removeRecord(actor, { collection: collection.name, id: recordId });
}

export async function exportCollection(
  store: ArtifactStore,
  actor: ArtifactActor,
  collectionId: string,
): Promise<{ name: string; body: string }> {
  const exported = await store.exportRecords(actor, collectionId);
  const lines = exported.records.map((record) => {
    const { collection: _collection, version: _version, ...rest } = record;
    return JSON.stringify(rest);
  });
  return { name: exported.name, body: lines.join("\n") + (lines.length ? "\n" : "") };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ArtifactError("body must be an object of column: value", 422);
}

export function catchArtifact(error: unknown): never {
  if (error instanceof ArtifactError) {
    throw artifactHttp(error);
  }
  if (error instanceof HttpError) {
    throw error;
  }
  throw error;
}
