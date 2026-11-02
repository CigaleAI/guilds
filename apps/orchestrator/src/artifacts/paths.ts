// The display-path grammar, by which a path names an artifact, a collection, a record, or a Memory
// revision, built and parsed here and imported directly by other domains.
import { isId } from "../lib/ids.js";
import { ArtifactError } from "./errors.js";
import type { ArtifactKind } from "./types.js";

export const TASK_KEY = "task.md";
export const MEMORY_KEY = "memory.md";
export const COLLECTIONS_SEGMENT = "collections";
export const SCRIPTS_SEGMENT = "scripts";
export const FILES_SEGMENT = "files";
export const HISTORY_ARCHIVE_SEGMENT = "history-archive";

const NOTE_KEY_RE = /^[^/\\]+\.md$/;
const FILE_NAME_MAX = 255;

export type ParsedDisplayPath =
  | {
      kind: "artifact";
      orgId: string;
      /** The agent whose Memory, Task, or script the path names; null for a note or a file. */
      agentId: string | null;
      path: string;
      key: string;
    }
  | {
      kind: "collection";
      orgId: string;
      collectionName: string;
    }
  | {
      kind: "record";
      orgId: string;
      collectionName: string;
      recordId: string;
    }
  | {
      kind: "revision";
      orgId: string;
      agentId: string;
      stamp: string;
    };

/**
 * The prefix every display path of an item starts with: the agent's for its Memory, Task, and
 * scripts, the organisation's for every note and file.
 */
export function itemPrefix(orgId: string, agentId: string | null): string {
  return agentId === null ? `org/${orgId}/` : `org/${orgId}/agents/${agentId}/`;
}

/** Collections live at the organisation: `org/<org_id>/collections/<name>`. */
export function collectionDisplayPath(orgId: string, collectionName: string): string {
  return `org/${orgId}/${COLLECTIONS_SEGMENT}/${collectionName}`;
}

export function recordDisplayPath(orgId: string, collectionName: string, recordId: string | number): string {
  return `${collectionDisplayPath(orgId, collectionName)}/${recordId}`;
}

/**
 * Where an artifact sits, as its display path is built from it: its organisation, the agent a
 * Memory, Task, or script belongs to, its kind, the collection a record or collection names, its
 * folder, and its file name or record id.
 */
export type ArtifactLocation = {
  orgId: string;
  agentId: string | null;
  kind: ArtifactKind | "collection" | "task";
  collectionName?: string | null;
  path: string;
  key: string;
};

export function displayPathFor(args: ArtifactLocation): string {
  if (args.kind === "object" || args.kind === "collection") {
    const collectionName = (args.collectionName ?? "").trim();
    if (!collectionName) {
      throw new ArtifactError("record is missing its collection name", 500);
    }
    if (args.kind === "object") {
      return recordDisplayPath(args.orgId, collectionName, args.key);
    }
    return collectionDisplayPath(args.orgId, collectionName);
  }
  const prefix = itemPrefix(args.orgId, args.agentId);
  return args.path ? `${prefix}${args.path}/${args.key}` : `${prefix}${args.key}`;
}

/** The display path of an agent's Memory: `org/<org_id>/agents/<agent_id>/memory.md`. */
export function memoryDisplayPath(orgId: string, agentId: string): string {
  return `${itemPrefix(orgId, agentId)}${MEMORY_KEY}`;
}

export function revisionDisplayPath(orgId: string, agentId: string, stamp: string): string {
  return `${itemPrefix(orgId, agentId)}${HISTORY_ARCHIVE_SEGMENT}/${stamp}`;
}

/** A note key is a `.md` file name: notes sit directly under their organisation, without folders. */
export function normalizeNoteKey(raw: string): string {
  const key = (raw || "").trim();
  if (!NOTE_KEY_RE.test(key) || key.includes("..") || key.includes("\0")) {
    throw new ArtifactError("note key must be a .md file name; notes have no folders", 422);
  }
  return key;
}

/** The display path of the note with this key: `org/<org_id>/<key>`. */
export function noteDisplayPath(orgId: string, key: string): string {
  return `${itemPrefix(orgId, null)}${normalizeNoteKey(key)}`;
}

function isScopedId(value: string, prefix: string): boolean {
  if (isId(value, prefix)) {
    return true;
  }
  return value.startsWith(`${prefix}_`) && /^[a-z][a-z0-9_]*$/.test(value);
}

export function isDisplayPath(raw: string): boolean {
  try {
    parseDisplayPath(raw);
    return true;
  } catch {
    return false;
  }
}

export function parseDisplayPath(raw: string): ParsedDisplayPath {
  const text = (raw || "").trim().replace(/^\/+/, "");
  const parts = text.split("/").filter(Boolean);
  const orgId = parts[1];
  if (parts[0] !== "org" || !orgId || !isScopedId(orgId, "org")) {
    throw new ArtifactError("unknown artifact path", 404);
  }
  const rest = parts.slice(2);
  if (rest[0] === COLLECTIONS_SEGMENT) {
    return parseCollectionPath(orgId, rest);
  }
  return parseItemPath(orgId, parseAgentSegments(rest));
}

/** The segments under `collections/`: a collection by name, or one of its records by id. */
function parseCollectionPath(orgId: string, segments: string[]): ParsedDisplayPath {
  const collectionName = segments[1];
  if (!collectionName || segments.length > 3) {
    throw new ArtifactError("unknown artifact path", 404);
  }
  if (segments.length === 2) {
    return { kind: "collection", orgId, collectionName };
  }
  return { kind: "record", orgId, collectionName, recordId: segments[2] ?? "" };
}

/** The agent a display path's segments after its organisation name, and the segments under it. */
type AgentSegments = { agentId: string | null; rest: string[] };

/** The agent the segments name, or none: the segments then name a note or a file of the organisation. */
function parseAgentSegments(segments: string[]): AgentSegments {
  const [head, id] = segments;
  if (head !== "agents") {
    return { agentId: null, rest: segments };
  }
  if (!id || !isScopedId(id, "a")) {
    throw new ArtifactError("unknown artifact path", 404);
  }
  return { agentId: id, rest: segments.slice(2) };
}

/** What the segments name: a Memory revision in an agent's archive, or an artifact by folder and file name. */
function parseItemPath(orgId: string, item: AgentSegments): ParsedDisplayPath {
  const { agentId, rest } = item;
  if (agentId !== null && rest[0] === HISTORY_ARCHIVE_SEGMENT) {
    const stamp = rest.slice(1).join("/");
    if (!stamp) {
      throw new ArtifactError("unknown artifact path", 404);
    }
    return { kind: "revision", orgId, agentId, stamp };
  }
  // A note or a file of the organisation sits at most one folder down: a note at its root, a file under `files/`.
  if (rest.length === 0 || rest[0] === COLLECTIONS_SEGMENT || (agentId === null && rest.length > 2)) {
    throw new ArtifactError("unknown artifact path", 404);
  }
  const key = rest[rest.length - 1] ?? "";
  const path = rest.slice(0, -1).join("/");
  return { kind: "artifact", orgId, agentId, path, key };
}

/** A file name is one path segment: no folder, no `.` or `..`, no control character, at most 255 characters. */
export function normalizeFileName(raw: string): string {
  const name = (raw || "").trim();
  if (!name || name === "." || name === ".." || /[/\\]/.test(name) || hasControlCharacter(name)) {
    throw new ArtifactError("file name must be one file name; files have no folders", 422);
  }
  if (name.length > FILE_NAME_MAX) {
    throw new ArtifactError(`file name must be at most ${FILE_NAME_MAX} characters`, 422);
  }
  return name;
}

/** The display path of the file with this name: `org/<org_id>/files/<name>`. */
export function fileDisplayPath(orgId: string, name: string): string {
  return `${itemPrefix(orgId, null)}${FILES_SEGMENT}/${normalizeFileName(name)}`;
}

function hasControlCharacter(text: string): boolean {
  return [...text].some((char) => char.charCodeAt(0) < 0x20);
}
