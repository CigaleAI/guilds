import { ArtifactError } from "../artifacts/errors.js";
import { isArtifactLevel, type ArtifactActor } from "../artifacts/types.js";
import { argInteger, argRecord, argString, functionSchema } from "./schema.js";
import { identityOutput } from "./output.js";
import type { ToolServices } from "./services.js";
import { callActor, type Tool, type ToolInvocation, type ToolRun } from "./types.js";
import {
  addRecord,
  listRecordsWithHint,
  removeRecord,
  searchRecords,
  updateRecord,
} from "../artifacts/records.js";
import {
  artifactAt,
  type ArtifactView,
  deleteByDisplayPath,
  findNotes,
  parseActorPath,
  writeNote,
  writeNoteAt,
} from "../artifacts/notes.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { writeMemory } from "../artifacts/memory.js";
import { bindQuery } from "../db/pg.js";

/** The artifact functions the note, record, and Memory tools call, on `store`. */
export function toolArtifacts(store: ArtifactStore) {
  return {
    findNotes: bindQuery(store, findNotes),
    artifactAt: bindQuery(store, artifactAt),
    writeNote: bindQuery(store, writeNote),
    writeNoteAt: bindQuery(store, writeNoteAt),
    deleteByDisplayPath: bindQuery(store, deleteByDisplayPath),
    listRecordsWithHint: bindQuery(store, listRecordsWithHint),
    searchRecords: bindQuery(store, searchRecords),
    addRecord: bindQuery(store, addRecord),
    updateRecord: bindQuery(store, updateRecord),
    removeRecord: bindQuery(store, removeRecord),
    writeMemory: bindQuery(store, writeMemory),
  };
}

export type ToolArtifacts = ReturnType<typeof toolArtifacts>;

function store(services: ToolServices): ToolArtifacts {
  if (!services.artifacts) {
    throw new ArtifactError("artifact store is not available", 500);
  }
  return services.artifacts;
}

function requiredActor(actor: ArtifactActor | null): ArtifactActor {
  if (!actor) {
    throw new ArtifactError("artifact store is not available", 500);
  }
  return actor;
}

function actor(run: ToolRun, call: ToolInvocation): ArtifactActor {
  return requiredActor(callActor(run.artifact_actor, call));
}

async function publish(services: ToolServices, run: ToolRun, path: string): Promise<void> {
  if (services.group_chat !== null && run.guild_id && services.group_chat.publish) {
    await services.group_chat.publish(run.guild_id, "guild.artifacts.changed", {
      path,
      agent_id: run.agent_id,
    });
  }
}

function findArgs(args: Record<string, unknown>): {
  query: string;
  level?: "agent" | "guild" | "org";
  limit: number;
} {
  const levelRaw = argString(args, "level").trim();
  const find: {
    query: string;
    level?: "agent" | "guild" | "org";
    limit: number;
  } = {
    query: argString(args, "query"),
    limit: argInteger(args, "limit", 20),
  };
  if (levelRaw && isArtifactLevel(levelRaw)) {
    find.level = levelRaw;
  }
  return find;
}

/** A row `note_get` may show: a script or a file is read with its own family's tool. */
function assertReadableNote(row: { kind: string }): void {
  if (row.kind === "script") {
    throw new ArtifactError("use script_read for scripts", 422);
  }
  if (row.kind === "file") {
    throw new ArtifactError("use file_fetch for files", 422);
  }
}

/** A row `note_delete` may delete: a script or a file is deleted with its own family's tool. */
function assertDeletableNote(row: { kind: string }): void {
  if (row.kind === "script") {
    throw new ArtifactError("use script_delete for scripts", 422);
  }
  if (row.kind === "file") {
    throw new ArtifactError("use file_delete for files", 422);
  }
}

/** What a display path holds as a row; a Memory revision is none a note tool reads. */
function viewedRow(view: ArtifactView): Extract<ArtifactView, { kind: "row" }> {
  if (view.kind === "revision") {
    throw new ArtifactError("artifact not found", 404);
  }
  return view;
}

/**
 * A note's or a collection record's content as text, read with `reader`'s access, the
 * way `note_get` and the record tools read it. A record is its JSON view.
 */
export async function readArtifactText(
  services: ToolServices,
  reader: ArtifactActor | null,
  path: string,
): Promise<{ path: string; text: string }> {
  const parsed = parseActorPath(requiredActor(reader), path);
  if (parsed.kind === "collection") {
    throw new ArtifactError(`${path} is a collection; name one of its records`, 422);
  }
  const view = viewedRow(await store(services).artifactAt(requiredActor(reader), path));
  if (view.deleted) {
    throw new ArtifactError("artifact not found", 404);
  }
  assertReadableNote(view.row);
  return { path: view.href, text: view.text };
}

const RECORD_TOOLS_HINT = "Use record_search or record_list for collection records.";

export const noteFind: Tool = {
  name: "note_find",
  description:
    "Search or list Markdown notes the agent may read. An empty query lists them, " +
    `optionally at one level. Results are { notes }. ${RECORD_TOOLS_HINT}`,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "note_find",
    "Search or list Markdown notes the agent may read.",
    {
      query: { type: "string" },
      level: { type: "string", description: "agent, guild, or org; omit for every level you can read" },
      limit: { type: "integer" },
    },
    [],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const result = await store(services).findNotes(actor(run, call), findArgs(args));
    return JSON.stringify({ notes: result.notes });
  },
};

export const noteGet: Tool = {
  name: "note_get",
  description: `Read one Markdown note by its display path. Soft-deleted notes return a tombstone. ${RECORD_TOOLS_HINT}`,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "note_get",
    "Read one Markdown note by display path.",
    { path: { type: "string" } },
    ["path"],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const path = argString(args, "path");
    const parsed = parseActorPath(actor(run, call), path);
    if (parsed.kind === "collection" || parsed.kind === "record") {
      throw new ArtifactError(RECORD_TOOLS_HINT, 422);
    }
    const view = viewedRow(await store(services).artifactAt(actor(run, call), path));
    assertReadableNote(view.row);
    return view.deleted ? `${path}\n\ntombstone: this artifact was deleted` : `${view.href}\n\n${view.text}`;
  },
};

const NOTE_WRITE_DESCRIPTION =
  "Create or update a Markdown note. With level (agent, guild, or org) and key, write your own note " +
  "at that level: a new note is created at agent or guild level, and an org note is updated only when it " +
  "exists and you have write access. With path, rewrite any existing note whose access is write. " +
  "key is the .md file name (for example queries.md); notes have no folders. " +
  "Do not pass org, guild, or agent ids.";

/** The note `note_write` names: an existing note by display path, or a level and key. */
async function writeNoteArgs(services: ToolServices, run: ToolRun, call: ToolInvocation) {
  const args = call.arguments;
  const content = argString(args, "content");
  const path = argString(args, "path").trim();
  if (path) {
    return store(services).writeNoteAt(actor(run, call), path, { content });
  }
  const levelRaw = argString(args, "level");
  if (!isArtifactLevel(levelRaw)) {
    throw new ArtifactError("level must be agent, guild, or org", 422);
  }
  return store(services).writeNote(actor(run, call), { level: levelRaw, key: argString(args, "key"), content });
}

export const noteWrite: Tool = {
  name: "note_write",
  description: NOTE_WRITE_DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "note_write",
    NOTE_WRITE_DESCRIPTION,
    {
      path: { type: "string", description: "the display path of an existing note to rewrite; omit level and key" },
      level: { type: "string", description: "agent, guild, or org; with key, when path is omitted" },
      key: { type: "string", description: "the .md file name, for example queries.md" },
      content: { type: "string" },
    },
    ["content"],
  ),
  async handler(services, run, _hooks, call) {
    const { href } = await writeNoteArgs(services, run, call);
    await publish(services, run, href);
    return href;
  },
};

export const noteDelete: Tool = {
  name: "note_delete",
  description:
    "Soft-delete a Markdown note by display path. task.md and memory.md " +
    "cannot be deleted. Use record_remove for collection records.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "note_delete",
    "Soft-delete a Markdown note by display path.",
    { path: { type: "string" } },
    ["path"],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const path = argString(args, "path");
    const parsed = parseActorPath(actor(run, call), path);
    if (parsed.kind === "collection") {
      throw new ArtifactError("collections are managed by the operator", 422);
    }
    if (parsed.kind === "record") {
      throw new ArtifactError("use record_remove for collection records", 422);
    }
    const artifacts = store(services);
    const view = await artifacts.artifactAt(actor(run, call), path);
    if (view.kind === "row") {
      assertDeletableNote(view.row);
    }
    await artifacts.deleteByDisplayPath(actor(run, call), path);
    await publish(services, run, path);
    return path;
  },
};

function bodyArg(args: Record<string, unknown>): Record<string, unknown> {
  const body = args.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ArtifactError("body must be a JSON object of column: value", 422);
  }
  return body as Record<string, unknown>;
}

function optional<T>(value: T | undefined | null): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

const WHERE_DESCRIPTION =
  'column → term, for example {"status": "new", "score": {"gte": 80}, "id": 42}: ' +
  "text and an open array item match by substring or similar spelling, a column with allowed values exactly " +
  "(a term outside the list is an error), " +
  "number and datetime exactly or by {gte, lte}, boolean and id exactly, null a missing value";

export const recordSearch: Tool = {
  name: "record_search",
  description:
    "Search records by text, across every collection you can read or in one collection. " +
    "query matches whole words in any column: terms are ANDed, OR widens, quotes keep a " +
    "phrase, - excludes; a single token also matches partially. Search is not fuzzy: a " +
    "misspelled word finds nothing; use record_list with where for similar spelling on one " +
    "column. where narrows the hits by column and needs collection. Results are { records }; " +
    "each record carries its collection, id, columns, and updated_at. Use note_find for notes.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "record_search",
    "Search records by text across the collections you can read.",
    {
      collection: { type: "string", description: "optional collection name; omit to search every readable collection" },
      query: {
        type: "string",
        description: "words to find in any column; OR, quotes, and - are supported; one token also matches partially",
      },
      where: { type: "object", description: `${WHERE_DESCRIPTION}; needs collection` },
      limit: { type: "integer", description: "at most 100, default 20" },
    },
    ["query"],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const result = await store(services).searchRecords(actor(run, call), {
      ...(argString(args, "collection").trim() ? { collection: argString(args, "collection").trim() } : {}),
      query: argString(args, "query"),
      where: optional(argRecord(args, "where")),
      limit: optional(args.limit),
    });
    return JSON.stringify({ records: result.records });
  },
};

export const recordList: Tool = {
  name: "record_list",
  description:
    "List records of one collection, narrowed by where (a term per column), since (records " +
    "created or updated at or after an ISO timestamp, oldest change first), ordered by order " +
    "({ column, direction } over a column, id, created_at, or updated_at; default id), and " +
    "paged by limit and offset. Results are { total, records }: total counts every match " +
    "regardless of paging. An empty narrowed result carries a hint about the collection. " +
    "Use where with id to read one record.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "record_list",
    "List records of one collection.",
    {
      collection: { type: "string" },
      where: { type: "object", description: WHERE_DESCRIPTION },
      since: {
        type: "string",
        description: "ISO 8601 timestamp; only records created or updated at or after it, oldest change first",
      },
      order: {
        type: "object",
        description: '{"column": "updated_at", "direction": "desc"}; a declared column, id, created_at, or updated_at',
      },
      limit: { type: "integer", description: "at most 100, default 20; an empty result never needs a larger limit" },
      offset: { type: "integer", description: "records to skip, default 0" },
    },
    ["collection"],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const result = await store(services).listRecordsWithHint(actor(run, call), {
      collection: argString(args, "collection").trim(),
      where: optional(argRecord(args, "where")),
      since: argString(args, "since").trim() || undefined,
      order: optional(args.order),
      limit: optional(args.limit),
      offset: optional(args.offset),
    });
    return JSON.stringify({
      total: result.total,
      records: result.records,
      ...(result.hint ? { hint: result.hint } : {}),
    });
  },
};

export const recordAdd: Tool = {
  name: "record_add",
  description:
    "Add a record to a collection you can write. body holds the declared columns only; " +
    "every value is validated against the column types and the record is rejected with " +
    "every problem at once. The store assigns the id and returns the record. When the " +
    "collection's unique column matches an existing record, body merges into that record " +
    "instead and the result names it. Do not pass id, created_at, or updated_at.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "record_add",
    "Add a record; the store assigns its id.",
    {
      collection: { type: "string" },
      body: { type: "object", description: "column → value for the declared columns" },
    },
    ["collection", "body"],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const result = await store(services).addRecord(actor(run, call), {
      collection: argString(args, "collection").trim(),
      body: bodyArg(args),
    });
    await publish(services, run, `org/${actor(run, call).orgId}/collections/${String(result.record.collection)}`);
    return JSON.stringify({
      record: result.record,
      ...(result.merged !== null ? { note: `merged into existing record ${result.merged}` } : {}),
    });
  },
};

export const recordUpdate: Tool = {
  name: "record_update",
  description:
    "Update one record by id with only the columns that change; the rest of the record " +
    "is kept. null clears an optional column. The patched columns are validated and the " +
    "write is rejected with every problem at once; problems elsewhere in the record come " +
    "back as warnings without blocking the write.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "record_update",
    "Merge a patch into one record by id.",
    {
      collection: { type: "string" },
      id: { type: "integer", description: "the record id from record_list, record_search, or record_add" },
      body: { type: "object", description: "column → value for the columns that change; null clears an optional column" },
    },
    ["collection", "id", "body"],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const result = await store(services).updateRecord(actor(run, call), {
      collection: argString(args, "collection").trim(),
      id: args.id,
      body: bodyArg(args),
    });
    await publish(services, run, `org/${actor(run, call).orgId}/collections/${String(result.record.collection)}/${String(result.record.id)}`);
    return JSON.stringify({
      record: result.record,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
    });
  },
};

export const recordRemove: Tool = {
  name: "record_remove",
  description: "Soft-delete one record by id. Collections themselves are managed by the operator.",
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(
    "record_remove",
    "Soft-delete one record by id.",
    {
      collection: { type: "string" },
      id: { type: "integer" },
    },
    ["collection", "id"],
  ),
  async handler(services, run, _hooks, call) {
    const args = call.arguments;
    const collection = argString(args, "collection").trim();
    const removed = await store(services).removeRecord(actor(run, call), { collection, id: args.id });
    await publish(services, run, `org/${actor(run, call).orgId}/collections/${collection}/${removed}`);
    return JSON.stringify({ removed });
  },
};
