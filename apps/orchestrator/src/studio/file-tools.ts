// The Studio tools for the files a session reaches: finding and reading notes, one file's change
// history, and a proposed change to a note.

import { Type, type Static } from "@sinclair/typebox";
import { operatorActor } from "../artifacts/actors.js";
import { artifactAt, findNotes, parseActorPath } from "../artifacts/notes.js";
import { listFileChanges } from "../db/file-changes.js";
import { editActionOf } from "./actions.js";
import { decodeStudioArguments, studioFunctionSchema } from "./arguments.js";
import {
  STUDIO_ARTIFACT_LIST_MAX,
  STUDIO_DEFAULT_LIMIT,
  STUDIO_REVISION_LIST_MAX,
  STUDIO_TOOL_RESULT_MAX_BYTES,
} from "./constants.js";
import { editRequest } from "./edits.js";
import { loadNoteBase, noteCreateRequest, noteDeleteRequest } from "./note-edits.js";
import { StudioUnprocessableError } from "./errors.js";
import { clampLimit, cursorOffset } from "./paging.js";
import { studioReachesParsed, studioReachesPath } from "./reach.js";
import { editScope, resolveHandle } from "./source-guild.js";
import { wrapEvidence } from "./system.js";
import type { StudioTool, StudioToolCall, StudioToolDeps } from "./tools.js";

const FindArtifactsArguments = Type.Object({
  query: Type.Optional(Type.String({ description: "words to find in note titles and bodies" })),
  level: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type FindArtifactsArguments = Static<typeof FindArtifactsArguments>;

export const studioFindArtifacts: StudioTool = {
  name: "studio_find_artifacts",
  schema: studioFunctionSchema(
    "studio_find_artifacts",
    "Search notes relevant to the source guild.",
    FindArtifactsArguments,
  ),
  async handler(deps, call, args) {
    const input: FindArtifactsArguments = decodeStudioArguments(FindArtifactsArguments, args);
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_ARTIFACT_LIST_MAX);
    const actor = operatorActor({
      orgId: call.orgId,
      actorId: String(call.user.id),
      actorName: String(call.user.name ?? "operator"),
      guildId: call.sourceGuildId,
    });
    const findArgs: {
      query: string;
      level?: "agent" | "guild" | "org";
      limit: number;
    } = {
      query: input.query ?? "",
      limit: STUDIO_ARTIFACT_LIST_MAX,
    };
    const level = input.level;
    if (level === "agent" || level === "guild" || level === "org") findArgs.level = level;
    const found = await findNotes(deps.artifacts, actor, findArgs);
    const allowed = [];
    for (const item of found.notes) {
      if (await studioReachesPath(deps, call, String(item.display_path ?? ""))) allowed.push(item);
    }
    const offset = cursorOffset(input.cursor);
    const slice = allowed.slice(offset, offset + limit);
    return {
      artifacts: slice.map((item) => ({
        display_path: item.display_path,
        level: item.level,
        kind: item.kind,
        owner_id: item.owner_id ?? item.agent_id ?? item.guild_id,
        version: item.version,
        title: item.title,
        trust: "untrusted",
      })),
      next_cursor: offset + slice.length < allowed.length ? String(offset + slice.length) : null,
    };
  },
};

const GetArtifactArguments = Type.Object({
  display_path: Type.String(),
  cursor: Type.Optional(Type.String()),
});
type GetArtifactArguments = Static<typeof GetArtifactArguments>;

export const studioGetArtifact: StudioTool = {
  name: "studio_get_artifact",
  schema: studioFunctionSchema(
    "studio_get_artifact",
    "Read one artifact by a display path returned from an authorized Studio result.",
    GetArtifactArguments,
  ),
  async handler(deps, call, args) {
    const input: GetArtifactArguments = decodeStudioArguments(GetArtifactArguments, args);
    const displayPath = input.display_path;
    const actor = operatorActor({
      orgId: call.orgId,
      actorId: String(call.user.id),
      actorName: String(call.user.name ?? "operator"),
      guildId: call.sourceGuildId,
    });
    const parsed = parseActorPath(actor, displayPath);
    if (parsed.kind === "collection") {
      throw new StudioUnprocessableError(`${parsed.collectionName} is a table; read it with studio_get_collection`);
    }
    if (!(await studioReachesParsed(deps, call, parsed))) {
      throw new StudioUnprocessableError("artifact is not in the source guild or the organisation's shared files");
    }
    const view = await artifactAt(deps.artifacts, actor, displayPath);
    if (view.kind !== "row") {
      throw new StudioUnprocessableError("artifact not found");
    }
    const row = view.row;
    const text = row.content_text ?? JSON.stringify(row.content_json ?? {});
    const offset = cursorOffset(input.cursor);
    const encoded = Buffer.from(text, "utf8");
    const slice = encoded.subarray(offset, offset + STUDIO_TOOL_RESULT_MAX_BYTES).toString("utf8");
    return {
      display_path: displayPath,
      kind: row.kind,
      title: row.title,
      version: row.version,
      editable: row.kind === "note",
      content: wrapEvidence({
        source: "artifact",
        coordinates: { display_path: displayPath, version: row.version },
        body: slice,
      }),
      next_cursor: offset + STUDIO_TOOL_RESULT_MAX_BYTES < encoded.length ? String(offset + STUDIO_TOOL_RESULT_MAX_BYTES) : null,
    };
  },
};

const ListFileChangesArguments = Type.Object({
  display_path: Type.String({ description: "Display path from an authorized Studio result. Required." }),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
type ListFileChangesArguments = Static<typeof ListFileChangesArguments>;

export const studioListFileChanges: StudioTool = {
  name: "studio_list_file_changes",
  schema: studioFunctionSchema(
    "studio_list_file_changes",
    "List who changed one file and when, newest first: notes, objects, scripts, memory, and standing tasks by display path. A run-written change carries the run id and the tool call that wrote it; read that run with studio_get_run.",
    ListFileChangesArguments,
  ),
  async handler(deps, call, args) {
    const input: ListFileChangesArguments = decodeStudioArguments(ListFileChangesArguments, args);
    const displayPath = input.display_path;
    const actor = operatorActor({
      orgId: call.orgId,
      actorId: String(call.user.id),
      actorName: String(call.user.name ?? "operator"),
      guildId: call.sourceGuildId,
    });
    if (!(await studioReachesParsed(deps, call, parseActorPath(actor, displayPath)))) {
      throw new StudioUnprocessableError("path is not in the source guild or the organisation's shared files");
    }
    const limit = clampLimit(input.limit, STUDIO_DEFAULT_LIMIT, STUDIO_REVISION_LIST_MAX);
    const offset = cursorOffset(input.cursor);
    const rows = await listFileChanges(deps.db, call.orgId, displayPath);
    const slice = rows.slice(offset, offset + limit);
    return {
      display_path: displayPath,
      changes: slice.map((change) => ({
        id: change.id,
        operation: change.operation,
        version: change.version,
        at: change.created_at,
        actor: change.actor,
        run: change.run
          ? { id: change.run.id, agent_id: change.run.agent_id, kind: change.run.kind, status: change.run.status, schedule_id: change.run.schedule_id }
          : null,
        tool: change.tool,
        studio: change.studio,
      })),
      next_cursor: offset + slice.length < rows.length ? String(offset + slice.length) : null,
    };
  },
};

const EditNoteArguments = Type.Object({
  action: Type.String({ enum: ["create", "edit", "delete"], description: "Required." }),
  display_path: Type.Optional(
    Type.String({ description: "edit and delete: display path from studio_find_artifacts or studio_get_artifact." }),
  ),
  base_version: Type.Optional(
    Type.Integer({ description: "edit and delete: the note version the proposal was built from." }),
  ),
  level: Type.Optional(
    Type.String({
      enum: ["agent", "guild", "org"],
      description:
        "create: agent is one agent's own file, guild is read by the source guild's agents, org is read across the organisation.",
    }),
  ),
  agent_id: Type.Optional(Type.String({ description: "create at level agent: source-guild agent id or name." })),
  key: Type.Optional(Type.String({ description: "create: file name ending in .md, no folders, for example playbook.md." })),
  title: Type.Optional(Type.String({ description: "create: short title shown in Files." })),
  content: Type.Optional(
    Type.String({ description: "create and edit: the complete note body, not a description of changes." }),
  ),
  reason: Type.String({ description: "Why this change, one or two sentences, citing evidence. Required." }),
});
type EditNoteArguments = Static<typeof EditNoteArguments>;

/** The agent a note created at level agent belongs to; null at another level or when none is named. */
async function noteAgentId(
  deps: StudioToolDeps,
  call: StudioToolCall,
  input: EditNoteArguments,
): Promise<string | null> {
  if (input.level !== "agent" || !input.agent_id) {
    return null;
  }
  return (await resolveHandle(deps, call, input.agent_id)).id;
}

export const studioEditNote: StudioTool = {
  name: "studio_edit_note",
  schema: studioFunctionSchema(
    "studio_edit_note",
    "Propose a change to one note of the source guild, one of its agents, or the organisation. Nothing is written: the turn pauses and the operator applies or declines. create: a new note at the narrowest level that holds every reader; search with studio_find_artifacts first and edit a note that fits instead; the result's target carries the display path to embed or name in a Task draft. edit: a complete replacement of an existing note's body. delete: applying fails while any Task embeds the note, so draft those Tasks first. edit and delete name the note by display_path and pass the version studio_get_artifact returned as base_version. Memory, Tasks, scripts, and records are not changed here.",
    EditNoteArguments,
  ),
  async handler(deps, call, args) {
    const input: EditNoteArguments = decodeStudioArguments(EditNoteArguments, args);
    const action = editActionOf(input);
    if (action === "edit") {
      const base = await loadNoteBase(deps, editScope(call), input.display_path ?? "");
      return editRequest(base, input, input.base_version ?? null);
    }
    if (action === "create") {
      return noteCreateRequest(deps, editScope(call), input, await noteAgentId(deps, call, input));
    }
    return noteDeleteRequest(deps, editScope(call), input);
  },
};
