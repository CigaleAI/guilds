// The files an operator's pages list, read and write at each level, and their provenance.
import {
  ArtifactError,
  ArtifactStore,
  hostFileDisplayPath,
  listFileChanges,
  listLatestFileChanges,
  normalizeNoteKey,
  parseDisplayPath,
  type ArtifactActor,
  type ArtifactLevel,
  MEMORY_KEY,
  TASK_KEY,
} from "./index.js";
import { taskDisplayPath } from "../agents/task.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import {
  getAgentTask,
  listAgentTaskRevisions,
  writeAgentTask,
  type AgentRow,
} from "../db/agents.js";
import type { Queryable } from "../db/pg.js";

/** What host files are read and written through: the artifact store, and the database an agent's Task lives in. */
export type HostFileServices = { store: ArtifactStore; db: Queryable };

/** The level and owner a host file belongs to. */
export type HostFileOwner = { level: ArtifactLevel; ownerId: string };

/** A host file as an operator writes it: its name, its content, and the version they edited, when they say. */
export type HostFileWrite = { path: string; content: string; expectedVersion: number | undefined };

/** A host file as it was read or written: what the page receives, its kind, and its version. */
type LoadedHostFile = { payload: HostFilePayload; kind: string; version: number };

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

export async function ensureAgentArtifacts(
  store: ArtifactStore,
  actor: ArtifactActor,
  agent: Pick<AgentRow, "id" | "guild_id" | "org_id">,
): Promise<void> {
  await store.ensureAgentRows({
    orgId: agent.org_id,
    guildId: agent.guild_id,
    agentId: agent.id,
    actor,
  });
}

/** The display paths the actor may read, in their order. */
async function readablePaths(
  store: ArtifactStore,
  actor: ArtifactActor,
  displayPaths: string[],
): Promise<string[]> {
  const readable = await Promise.all(
    displayPaths.map((path) => store.canReadDisplayPath(actor, path)),
  );
  return displayPaths.filter((_, index) => readable[index]);
}

function changedAt(updatedAt: unknown): string | null {
  if (updatedAt instanceof Date) {
    return updatedAt.toISOString();
  }
  if (typeof updatedAt !== "string" || !updatedAt) {
    return null;
  }
  return updatedAt.includes("T") ? updatedAt : formatColumnTimestamp(updatedAt);
}

function fallbackChange(
  displayPath: string,
  version: number,
  name: string | null,
  updatedAt: unknown,
): Record<string, unknown> {
  return {
    id: null,
    recorded: false,
    display_path: displayPath,
    operation: "update",
    version,
    actor: { type: "unknown", id: null, name },
    run: null,
    tool: null,
    created_at: changedAt(updatedAt),
  };
}

/** The agent whose Task a display path names, or null for any other path. */
function taskOwnerOf(parsed: ReturnType<typeof parseDisplayPath>): string | null {
  const isTask =
    parsed.kind === "artifact" &&
    parsed.level === "agent" &&
    parsed.path === "" &&
    parsed.key === TASK_KEY;
  return isTask ? parsed.ownerId : null;
}

/** A live row's saver, version and time at a display path, or null for a path it cannot read or that holds none. */
async function lastSavedRow(
  store: ArtifactStore,
  actor: ArtifactActor,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const loaded = await store.getByDisplayPath(actor, path);
    const live = loaded.row && !loaded.tombstone ? loaded.row : null;
    return live ? fallbackChange(path, live.version, live.updated_by_name, live.updated_at) : null;
  } catch {
    return null;
  }
}

/**
 * The last-saved facts of a path with no recorded change, marked `recorded: false`: a Task's
 * version and time, or a live row's saver, version and time. Null for a path that names neither.
 */
async function unrecordedChange(
  services: HostFileServices,
  actor: ArtifactActor,
  path: string,
): Promise<Record<string, unknown> | null> {
  let parsed;
  try {
    parsed = parseDisplayPath(path);
  } catch {
    return null;
  }
  if (parsed.orgId !== actor.orgId || parsed.kind === "revision" || parsed.kind === "collection") {
    return null;
  }
  const taskOwner = taskOwnerOf(parsed);
  if (taskOwner === null) {
    return lastSavedRow(services.store, actor, path);
  }
  const task = await getAgentTask(services.db, actor.orgId, taskOwner);
  return task ? fallbackChange(path, task.version, null, task.updated_at) : null;
}

/**
 * The newest recorded change per display path the actor may read. Paths written before the change
 * log existed fall back to their last-saved facts, so a listing can still say who saved a file last.
 */
export async function latestFileChanges(
  services: HostFileServices,
  actor: ArtifactActor,
  displayPaths: string[],
): Promise<Record<string, unknown>> {
  const paths = await readablePaths(services.store, actor, [
    ...new Set(displayPaths.filter((path) => path)),
  ]);
  const latest: Record<string, unknown> = await listLatestFileChanges(
    services.db,
    actor.orgId,
    paths,
  );
  for (const path of paths) {
    const fallback = latest[path] ? null : await unrecordedChange(services, actor, path);
    if (fallback) {
      latest[path] = fallback;
    }
  }
  return latest;
}

/** The notes one owner holds, by file name. An agent's Task and Memory are read by name, not listed. */
export async function listHostFiles(
  store: ArtifactStore,
  actor: ArtifactActor,
  owner: HostFileOwner,
): Promise<Array<Record<string, unknown>>> {
  return store.listOwnerNotes(actor, owner.level, owner.ownerId);
}

/** The payload with its version, and for an agent's Task the versions it replaced. */
async function withFileMeta(
  services: HostFileServices,
  actor: ArtifactActor,
  owner: HostFileOwner,
  file: LoadedHostFile,
): Promise<HostFilePayload> {
  const next = { ...file.payload, version: file.version };
  if (file.kind === "task") {
    next.revisions = (await listAgentTaskRevisions(services.db, actor.orgId, owner.ownerId)).map(
      (row) => ({
        ...row,
        replaced_at: formatColumnTimestamp(row.replaced_at),
      }),
    );
  }
  return next;
}

/** The file name the Host sends: a note key, or an agent's `task.md` or `memory.md`. */
function hostFileName(relative: string): string {
  return normalizeNoteKey((relative || "").trim().replace(/^\/+/, ""));
}

export async function readHostFile(
  services: HostFileServices,
  actor: ArtifactActor,
  owner: HostFileOwner,
  relative: string,
): Promise<HostFilePayload> {
  const name = hostFileName(relative);
  if (owner.level === "agent" && name === TASK_KEY) {
    const row = await getAgentTask(services.db, actor.orgId, owner.ownerId);
    if (!row) {
      throw new ArtifactError("task.md not found", 404);
    }
    const payload = {
      path: name,
      display_path: taskDisplayPath(actor.orgId, owner.ownerId),
      content: row.content_text,
    };
    return withFileMeta(services, actor, owner, { payload, kind: "task", version: row.version });
  }
  const displayPath = hostFileDisplayPath(actor.orgId, owner.level, owner.ownerId, name);
  const loaded = await services.store.getByDisplayPath(actor, displayPath);
  if (loaded.tombstone || !loaded.row) {
    throw new ArtifactError("artifact not found", 404);
  }
  const payload = {
    ...(loaded.row.kind === "note" ? { id: loaded.row.id } : {}),
    path: name,
    display_path: displayPath,
    content: String(loaded.row.content_text ?? ""),
  };
  return withFileMeta(services, actor, owner, {
    payload,
    kind: loaded.row.kind,
    version: loaded.row.version,
  });
}

export async function writeHostFile(
  services: HostFileServices,
  actor: ArtifactActor,
  owner: HostFileOwner,
  write: HostFileWrite,
): Promise<HostFilePayload> {
  const { store, db } = services;
  const name = hostFileName(write.path);
  const { content } = write;
  if (owner.level === "agent" && name === TASK_KEY) {
    const row = await writeAgentTask(db, actor, owner.ownerId, content, write.expectedVersion);
    const payload = {
      path: name,
      content,
      display_path: taskDisplayPath(actor.orgId, owner.ownerId),
    };
    return withFileMeta(services, actor, owner, { payload, kind: "task", version: row.version });
  }
  if (owner.level === "agent" && name === MEMORY_KEY) {
    const row = await store.writeMemory(actor, owner.ownerId, content, `host ${actor.actorName}`);
    const payload = { path: name, content, display_path: String(store.view(row).display_path) };
    return withFileMeta(services, actor, owner, { payload, kind: "memory", version: row.version });
  }
  const row = await store.writeNote(actor, { level: owner.level, key: name, content });
  const payload = {
    id: row.id,
    path: name,
    content,
    display_path: String(store.view(row).display_path),
  };
  return withFileMeta(services, actor, owner, { payload, kind: row.kind, version: row.version });
}

export async function deleteHostFile(
  store: ArtifactStore,
  actor: ArtifactActor,
  owner: HostFileOwner,
  relative: string,
): Promise<void> {
  const displayPath = hostFileDisplayPath(
    actor.orgId,
    owner.level,
    owner.ownerId,
    hostFileName(relative),
  );
  await store.deleteByDisplayPath(actor, displayPath);
}

/** The recorded changes of one display path, newest first; none for a path the actor may not read. */
export async function listPathChanges(
  services: HostFileServices,
  actor: ArtifactActor,
  displayPath: string,
): Promise<unknown[]> {
  if (!displayPath) {
    throw new ArtifactError("display_path is required", 422);
  }
  if (!(await services.store.canReadDisplayPath(actor, displayPath))) {
    return [];
  }
  return listFileChanges(services.db, actor.orgId, displayPath);
}

/**
 * The notes the actor may embed, or with `displayPath` the one note it names.
 */
export async function readEmbeddableNotes(
  store: ArtifactStore,
  actor: ArtifactActor,
  displayPath: string,
): Promise<unknown> {
  if (!displayPath) {
    return store.listEmbeddableNotes(actor);
  }
  const loaded = await store.getByDisplayPath(actor, displayPath);
  const row = !loaded.tombstone && !loaded.revision ? loaded.row : null;
  if (!row || row.kind !== "note") {
    throw new ArtifactError("note not found", 404);
  }
  return {
    display_path: displayPath,
    title: row.title || row.key.replace(/\.md$/, ""),
    level: row.level,
    content: row.content_text ?? "",
  };
}
