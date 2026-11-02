// The notes an operator's pages read and write by key, an agent's Task and Memory, and their provenance.
import { ArtifactError } from "./errors.js";
import { MEMORY_KEY, memoryDisplayPath, normalizeNoteKey, noteDisplayPath, parseDisplayPath, TASK_KEY } from "./paths.js";
import { listFileChanges, listLatestFileChanges, type FileChangeView } from "../db/file-changes.js";
import type { AccessGrant, ArtifactActor } from "./types.js";
import { taskDisplayPath, writeAgentTask } from "./task.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import { getAgentTask, listAgentTaskRevisions, type AgentRow } from "../db/agents.js";
import type { Queryable } from "../db/pg.js";
import { canReadDisplayPath, deleteByDisplayPath, getByDisplayPath, listEmbeddableNotes, writeNote } from "./notes.js";
import { artifactTextView, type ArtifactStore, type ArtifactTextView } from "./store.js";
import { ensureAgentRows, writeMemory } from "./memory.js";

/** What host files are read and written through: the artifact store, and the database an agent's Task lives in. */
export type HostFileServices = { store: ArtifactStore; db: Queryable };

/** A host file as an operator writes it: its name, its content, and the version they edited, when they say. */
export type HostFileWrite = { path: string; content: string; expectedVersion: number | undefined };

/**
 * A note as an operator writes it by key: its name and content, the version they edited when they
 * say (0 for a note that must not exist yet), and the rows its access list starts with when the
 * write creates it.
 */
export type HostNoteWrite = {
  path: string;
  content: string;
  expectedVersion: number | undefined;
  startingAccess: AccessGrant[];
};

/** A host file as it was read or written: what the page receives, its kind, and its version. */
type LoadedHostFile = { payload: HostFilePayload; kind: string; version: number };

/** A host file as the page receives it: its path, content and display path, and for a note its id, version and revisions. */
export type HostFilePayload = {
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
  await ensureAgentRows(store, actor, {
    orgId: agent.org_id,
    guildId: agent.guild_id,
    agentId: agent.id,
  });
}

/** The display paths the actor may read, in their order. */
async function readablePaths(
  store: ArtifactStore,
  actor: ArtifactActor,
  displayPaths: string[],
): Promise<string[]> {
  const readable = await Promise.all(
    displayPaths.map((path) => canReadDisplayPath(store, actor, path)),
  );
  return displayPaths.filter((_, index) => readable[index]);
}

/**
 * The last-saved facts of a path no recorded change covers, in the shape of a recorded change
 * marked `recorded: false`: its version, its saver's name when the row keeps one, and when.
 */
export type UnrecordedChange = {
  id: null;
  recorded: false;
  display_path: string;
  operation: "update";
  version: number;
  actor: { type: "unknown"; id: null; name: string | null };
  run: null;
  tool: null;
  created_at: string | null;
};

/** A display path's newest change: the one the change log recorded, or its last-saved facts. */
export type LatestFileChange = FileChangeView | UnrecordedChange;

function changedAt(updatedAt: string | null): string | null {
  if (!updatedAt) {
    return null;
  }
  return updatedAt.includes("T") ? updatedAt : formatColumnTimestamp(updatedAt);
}

function fallbackChange(
  displayPath: string,
  version: number,
  name: string | null,
  updatedAt: string | null,
): UnrecordedChange {
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
  const isTask = parsed.kind === "artifact" && parsed.path === "" && parsed.key === TASK_KEY;
  return isTask ? parsed.agentId : null;
}

/** A live row's saver, version and time at a display path, or null for a path it cannot read or that holds none. */
async function lastSavedRow(
  store: ArtifactStore,
  actor: ArtifactActor,
  path: string,
): Promise<UnrecordedChange | null> {
  try {
    const loaded = await getByDisplayPath(store, actor, path);
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
): Promise<UnrecordedChange | null> {
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
): Promise<Record<string, LatestFileChange>> {
  const paths = await readablePaths(services.store, actor, [
    ...new Set(displayPaths.filter((path) => path)),
  ]);
  const latest: Record<string, LatestFileChange> = await listLatestFileChanges(
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

/** The payload with its version, and for an agent's Task the versions it replaced. */
async function withFileMeta(
  services: HostFileServices,
  actor: ArtifactActor,
  agentId: string | null,
  file: LoadedHostFile,
): Promise<HostFilePayload> {
  const next = { ...file.payload, version: file.version };
  if (file.kind === "task" && agentId !== null) {
    next.revisions = (await listAgentTaskRevisions(services.db, actor.orgId, agentId)).map((row) => ({
      ...row,
      replaced_at: formatColumnTimestamp(row.replaced_at),
    }));
  }
  return next;
}

/** The file name the Host sends: a note key, or an agent's `task.md` or `memory.md`. */
export function hostFileName(relative: string): string {
  return normalizeNoteKey((relative || "").trim().replace(/^\/+/, ""));
}

/** The organisation's note with this key, as the actor reads it. */
export async function readHostNote(services: HostFileServices, actor: ArtifactActor, relative: string): Promise<HostFilePayload> {
  const name = hostFileName(relative);
  const displayPath = noteDisplayPath(actor.orgId, name);
  const loaded = await getByDisplayPath(services.store, actor, displayPath);
  if (loaded.tombstone || !loaded.row || loaded.row.kind !== "note") {
    throw new ArtifactError("artifact not found", 404);
  }
  const payload = {
    id: loaded.row.id,
    path: name,
    display_path: displayPath,
    content: loaded.row.content_text ?? "",
  };
  return withFileMeta(services, actor, null, { payload, kind: "note", version: loaded.row.version });
}

/** Writes the organisation's note at the key the write names: the live one, or a new one starting with the write's access rows. */
export async function writeHostNote(services: HostFileServices, actor: ArtifactActor, write: HostNoteWrite): Promise<HostFilePayload> {
  const name = hostFileName(write.path);
  const { row, href } = await writeNote(services.store, actor, {
    key: name,
    content: write.content,
    startingAccess: write.startingAccess,
    ...(write.expectedVersion !== undefined ? { expectedVersion: write.expectedVersion } : {}),
  });
  const payload = { id: row.id, path: name, content: write.content, display_path: href };
  return withFileMeta(services, actor, null, { payload, kind: row.kind, version: row.version });
}

/** Deletes the organisation's note with this key. */
export async function deleteHostNote(store: ArtifactStore, actor: ArtifactActor, relative: string): Promise<void> {
  await deleteByDisplayPath(store, actor, noteDisplayPath(actor.orgId, hostFileName(relative)));
}

/** An agent's `task.md` or `memory.md` as the actor reads it; any other name is not the agent's. */
export async function readAgentHostFile(
  services: HostFileServices,
  actor: ArtifactActor,
  agentId: string,
  relative: string,
): Promise<HostFilePayload> {
  const name = hostFileName(relative);
  if (name === TASK_KEY) {
    const row = await getAgentTask(services.db, actor.orgId, agentId);
    if (!row) {
      throw new ArtifactError("task.md not found", 404);
    }
    const payload = { path: name, display_path: taskDisplayPath(actor.orgId, agentId), content: row.content_text };
    return withFileMeta(services, actor, agentId, { payload, kind: "task", version: row.version });
  }
  if (name !== MEMORY_KEY) {
    throw new ArtifactError("artifact not found", 404);
  }
  const displayPath = memoryDisplayPath(actor.orgId, agentId);
  const loaded = await getByDisplayPath(services.store, actor, displayPath);
  if (loaded.tombstone || !loaded.row) {
    throw new ArtifactError("artifact not found", 404);
  }
  const payload = { path: name, display_path: displayPath, content: loaded.row.content_text ?? "" };
  return withFileMeta(services, actor, agentId, { payload, kind: loaded.row.kind, version: loaded.row.version });
}

/** Writes an agent's `task.md` or `memory.md`; any other name is not the agent's. */
export async function writeAgentHostFile(
  services: HostFileServices,
  actor: ArtifactActor,
  agentId: string,
  write: HostFileWrite,
): Promise<HostFilePayload> {
  const { store, db } = services;
  const name = hostFileName(write.path);
  const { content } = write;
  if (name === TASK_KEY) {
    const row = await writeAgentTask(db, actor, agentId, { content, expectedVersion: write.expectedVersion });
    const payload = { path: name, content, display_path: taskDisplayPath(actor.orgId, agentId) };
    return withFileMeta(services, actor, agentId, { payload, kind: "task", version: row.version });
  }
  if (name !== MEMORY_KEY) {
    throw new ArtifactError("artifact not found", 404);
  }
  const { row, href } = await writeMemory(store, actor, agentId, { content, detail: `host ${actor.actorName}` });
  const payload = { path: name, content, display_path: href };
  return withFileMeta(services, actor, agentId, { payload, kind: "memory", version: row.version });
}

/** The recorded changes of one display path, newest first; none for a path the actor may not read. */
export async function listPathChanges(
  services: HostFileServices,
  actor: ArtifactActor,
  displayPath: string,
): Promise<FileChangeView[]> {
  if (!displayPath) {
    throw new ArtifactError("display_path is required", 422);
  }
  if (!(await canReadDisplayPath(services.store, actor, displayPath))) {
    return [];
  }
  return listFileChanges(services.db, actor.orgId, displayPath);
}

/** A note as an embed reads it: where it sits, its title, and its text. */
export type EmbeddedNote = { display_path: string; title: string; content: string };

/**
 * The notes the actor may embed, or with `displayPath` the one note it names.
 */
export async function readEmbeddableNotes(
  store: ArtifactStore,
  actor: ArtifactActor,
  displayPath: string,
): Promise<ArtifactTextView[] | EmbeddedNote> {
  if (!displayPath) {
    return (await listEmbeddableNotes(store, actor)).map(artifactTextView);
  }
  const loaded = await getByDisplayPath(store, actor, displayPath);
  const row = !loaded.tombstone && !loaded.revision ? loaded.row : null;
  if (!row || row.kind !== "note") {
    throw new ArtifactError("note not found", 404);
  }
  return {
    display_path: displayPath,
    title: row.title || row.key.replace(/\.md$/, ""),
    content: row.content_text ?? "",
  };
}
