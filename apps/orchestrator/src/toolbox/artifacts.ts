import { Type, type Static } from "typebox";
import { ArtifactError } from "../artifacts/errors.js";
import type { ArtifactActor } from "../artifacts/types.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../lib/json.js";
import { jsonArgument } from "./schema.js";
import type { ToolServices } from "./services.js";
import { callActor, nativeTool, type ToolInvocation, type ToolRun } from "./types.js";
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
  type NoteSearch,
  parseActorPath,
  writeNote,
  writeNoteAt,
} from "../artifacts/notes.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { writeMemory } from "../artifacts/memory.js";
import type { ArtifactRow } from "../db/artifacts.js";
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

/** A `note_find` call's arguments: what to search for, and how many notes at most. */
const NoteFindParameters = Type.Object({
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ description: "at most 100, default 20" })),
});

/** The search a `note_find` call names. */
function noteSearch(args: Static<typeof NoteFindParameters>): NoteSearch {
  return { query: args.query ?? "", limit: args.limit ?? 20 };
}

/** A row `note_get` may show: a script or a file is read with its own family's tool. */
function assertReadableNote(row: ArtifactRow): void {
  if (row.kind === "script") {
    throw new ArtifactError("use script_read for scripts", 422);
  }
  if (row.kind === "file") {
    throw new ArtifactError("use file_fetch for files", 422);
  }
}

/** A row `note_delete` may delete: a script or a file is deleted with its own family's tool. */
function assertDeletableNote(row: ArtifactRow): void {
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

export const noteFind = nativeTool({
  name: "note_find",
  description:
    "Search or list the Markdown notes you may read. An empty query lists them. " +
    `Results are { notes }, each with its display path, key, title, and access (read or write). ${RECORD_TOOLS_HINT}`,
  summary: "Search or list Markdown notes the agent may read.",
  parameters: NoteFindParameters,
  async handler(services, run, _hooks, call) {
    const result = await store(services).findNotes(actor(run, call), noteSearch(call.arguments));
    return JSON.stringify({ notes: result.notes });
  },
});

export const noteGet = nativeTool({
  name: "note_get",
  description: `Read one Markdown note by its display path. Soft-deleted notes return a tombstone. ${RECORD_TOOLS_HINT}`,
  summary: "Read one Markdown note by display path.",
  parameters: Type.Object({ path: Type.String() }),
  async handler(services, run, _hooks, call) {
    const { path } = call.arguments;
    const parsed = parseActorPath(actor(run, call), path);
    if (parsed.kind === "collection" || parsed.kind === "record") {
      throw new ArtifactError(RECORD_TOOLS_HINT, 422);
    }
    const view = viewedRow(await store(services).artifactAt(actor(run, call), path));
    assertReadableNote(view.row);
    return view.deleted ? `${path}\n\ntombstone: this artifact was deleted` : `${view.href}\n\n${view.text}`;
  },
});

const NOTE_WRITE_DESCRIPTION =
  "Create or update a Markdown note. With key, write the note of that name: an existing note is " +
  "updated when your access to it is write and refused otherwise, and a missing one is created, " +
  "written by you alone until an operator shares it. With path, rewrite the existing note that display " +
  "path names, when your access to it is write. key is the .md file name (for example queries.md); " +
  "notes have no folders, and one name is one note across the organisation. Do not pass org, guild, or agent ids.";

/** A `note_write` call's arguments: the note it rewrites by display path, or the key of the note it writes, and the content. */
const NoteWriteParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "the display path of an existing note to rewrite; omit key" })),
  key: Type.Optional(Type.String({ description: "the .md file name, for example queries.md" })),
  content: Type.String(),
});

/** The note `note_write` names: an existing note by display path, or a key. */
async function writeNoteArgs(services: ToolServices, run: ToolRun, call: ToolInvocation<Static<typeof NoteWriteParameters>>) {
  const { content, key = "" } = call.arguments;
  const path = call.arguments.path?.trim();
  if (path) {
    return store(services).writeNoteAt(actor(run, call), path, { content });
  }
  if (!key.trim()) {
    throw new ArtifactError("key or path is required", 422);
  }
  return store(services).writeNote(actor(run, call), { key, content });
}

export const noteWrite = nativeTool({
  name: "note_write",
  description: NOTE_WRITE_DESCRIPTION,
  parameters: NoteWriteParameters,
  async handler(services, run, _hooks, call) {
    const { href } = await writeNoteArgs(services, run, call);
    await publish(services, run, href);
    return href;
  },
});

export const noteDelete = nativeTool({
  name: "note_delete",
  description:
    "Soft-delete a Markdown note by display path. task.md and memory.md " +
    "cannot be deleted. Use record_remove for collection records.",
  summary: "Soft-delete a Markdown note by display path.",
  parameters: Type.Object({ path: Type.String() }),
  async handler(services, run, _hooks, call) {
    const { path } = call.arguments;
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
});

/** The body of a record write: the JSON object of column to value it names. */
function recordBody(body: JsonValue): JsonObject {
  if (!isJsonObject(body)) {
    throw new ArtifactError("body must be a JSON object of column: value", 422);
  }
  return body;
}

/** A `where` the call sends as an object; one of another shape narrows nothing. */
function whereObject(where: JsonValue | undefined): JsonObject | undefined {
  return where !== undefined && isJsonObject(where) ? where : undefined;
}

const WHERE_DESCRIPTION =
  'column → term, for example {"status": "new", "score": {"gte": 80}, "id": 42}: ' +
  "text and an open array item match by substring or similar spelling, a column with allowed values exactly " +
  "(a term outside the list is an error), " +
  "number and datetime exactly or by {gte, lte}, boolean and id exactly, null a missing value";

export const recordSearch = nativeTool({
  name: "record_search",
  description:
    "Search records by text, across every collection you can read or in one collection. " +
    "query matches whole words in any column: terms are ANDed, OR widens, quotes keep a " +
    "phrase, - excludes; a single token also matches partially. Search is not fuzzy: a " +
    "misspelled word finds nothing; use record_list with where for similar spelling on one " +
    "column. where narrows the hits by column and needs collection. Results are { records }; " +
    "each record carries its collection, id, columns, and updated_at. Use note_find for notes.",
  summary: "Search records by text across the collections you can read.",
  parameters: Type.Object({
    collection: Type.Optional(
      Type.String({ description: "optional collection name; omit to search every readable collection" }),
    ),
    query: Type.String({
      description: "words to find in any column; OR, quotes, and - are supported; one token also matches partially",
    }),
    where: Type.Optional(jsonArgument({ type: "object", description: `${WHERE_DESCRIPTION}; needs collection` })),
    limit: Type.Optional(jsonArgument({ type: "integer", description: "at most 100, default 20" })),
  }),
  async handler(services, run, _hooks, call) {
    const { query, where, limit } = call.arguments;
    const collection = call.arguments.collection?.trim();
    const result = await store(services).searchRecords(actor(run, call), {
      ...(collection ? { collection } : {}),
      query,
      where: whereObject(where),
      limit,
    });
    return JSON.stringify({ records: result.records });
  },
});

export const recordList = nativeTool({
  name: "record_list",
  description:
    "List records of one collection, narrowed by where (a term per column), since (records " +
    "created or updated at or after an ISO timestamp, oldest change first), ordered by order " +
    "({ column, direction } over a column, id, created_at, or updated_at; default id), and " +
    "paged by limit and offset. Results are { total, records }: total counts every match " +
    "regardless of paging. An empty narrowed result carries a hint about the collection. " +
    "Use where with id to read one record.",
  summary: "List records of one collection.",
  parameters: Type.Object({
    collection: Type.String(),
    where: Type.Optional(jsonArgument({ type: "object", description: WHERE_DESCRIPTION })),
    since: Type.Optional(
      Type.String({
        description: "ISO 8601 timestamp; only records created or updated at or after it, oldest change first",
      }),
    ),
    order: Type.Optional(
      jsonArgument({
        type: "object",
        description: '{"column": "updated_at", "direction": "desc"}; a declared column, id, created_at, or updated_at',
      }),
    ),
    limit: Type.Optional(
      jsonArgument({ type: "integer", description: "at most 100, default 20; an empty result never needs a larger limit" }),
    ),
    offset: Type.Optional(jsonArgument({ type: "integer", description: "records to skip, default 0" })),
  }),
  async handler(services, run, _hooks, call) {
    const { where, order, limit, offset } = call.arguments;
    const result = await store(services).listRecordsWithHint(actor(run, call), {
      collection: call.arguments.collection.trim(),
      where: whereObject(where),
      since: call.arguments.since?.trim() || undefined,
      order,
      limit,
      offset,
    });
    return JSON.stringify({
      total: result.total,
      records: result.records,
      ...(result.hint ? { hint: result.hint } : {}),
    });
  },
});

export const recordAdd = nativeTool({
  name: "record_add",
  description:
    "Add a record to a collection you can write. body holds the declared columns only; " +
    "every value is validated against the column types and the record is rejected with " +
    "every problem at once. The store assigns the id and returns the record. When the " +
    "collection's unique column matches an existing record, body merges into that record " +
    "instead and the result names it. Do not pass id, created_at, or updated_at.",
  summary: "Add a record; the store assigns its id.",
  parameters: Type.Object({
    collection: Type.String(),
    body: jsonArgument({ type: "object", description: "column → value for the declared columns" }),
  }),
  async handler(services, run, _hooks, call) {
    const result = await store(services).addRecord(actor(run, call), {
      collection: call.arguments.collection.trim(),
      body: recordBody(call.arguments.body),
    });
    await publish(services, run, `org/${actor(run, call).orgId}/collections/${String(result.record.collection)}`);
    return JSON.stringify({
      record: result.record,
      ...(result.merged !== null ? { note: `merged into existing record ${result.merged}` } : {}),
    });
  },
});

export const recordUpdate = nativeTool({
  name: "record_update",
  description:
    "Update one record by id with only the columns that change; the rest of the record " +
    "is kept. null clears an optional column. The patched columns are validated and the " +
    "write is rejected with every problem at once; problems elsewhere in the record come " +
    "back as warnings without blocking the write.",
  summary: "Merge a patch into one record by id.",
  parameters: Type.Object({
    collection: Type.String(),
    id: jsonArgument({ type: "integer", description: "the record id from record_list, record_search, or record_add" }),
    body: jsonArgument({
      type: "object",
      description: "column → value for the columns that change; null clears an optional column",
    }),
  }),
  async handler(services, run, _hooks, call) {
    const result = await store(services).updateRecord(actor(run, call), {
      collection: call.arguments.collection.trim(),
      id: call.arguments.id,
      body: recordBody(call.arguments.body),
    });
    await publish(services, run, `org/${actor(run, call).orgId}/collections/${String(result.record.collection)}/${String(result.record.id)}`);
    return JSON.stringify({
      record: result.record,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
    });
  },
});

export const recordRemove = nativeTool({
  name: "record_remove",
  description: "Soft-delete one record by id. Collections themselves are managed by the operator.",
  summary: "Soft-delete one record by id.",
  parameters: Type.Object({
    collection: Type.String(),
    id: jsonArgument({ type: "integer" }),
  }),
  async handler(services, run, _hooks, call) {
    const collection = call.arguments.collection.trim();
    const removed = await store(services).removeRecord(actor(run, call), { collection, id: call.arguments.id });
    await publish(services, run, `org/${actor(run, call).orgId}/collections/${collection}/${removed}`);
    return JSON.stringify({ removed });
  },
});
