// The Studio tools: what a tool is, the call it runs for, and the list Studio offers and dispatches.

import type { ArtifactStore } from "../artifacts/store.js";
import type { JsonObject } from "../lib/json.js";
import type { FunctionTool } from "../lib/tool-schema.js";
import type { Queryable } from "../db/pg.js";
import type { StudioSessionRow } from "../db/studio.js";
import type { StudioOperator } from "./actor.js";
import type { Schedules } from "../schedules/service.js";
import { studioEditAccess, studioGetAgentAccess, studioGetScript } from "./access-tools.js";
import { studioEditCollection, studioGetCollection, studioListCollections } from "./collection-tools.js";
import { studioCallConnectionTool, studioRequestConnectionAccess } from "./connection-tools.js";
import type { StudioMcpClient } from "./connections.js";
import type { StudioDraftService } from "./drafts.js";
import { studioEditNote, studioFindArtifacts, studioGetArtifact, studioListFileChanges } from "./file-tools.js";
import { studioEditGuild, studioGetGuild, studioListGroupMessages, studioListGuilds } from "./guild-tools.js";
import { studioEditMemory, studioGetMemoryVersion, studioListMemoryRevisions } from "./memory-tools.js";
import type { PreviewDeps } from "./preview.js";
import { studioGetAgentContext, studioGetGuidelines } from "./prompt-tools.js";
import { studioEditRoutine, studioListRoutines } from "./routine-tools.js";
import { studioGetRun, studioListRuns } from "./run-tools.js";
import { studioCreateTaskDraft, studioListTaskRevisions } from "./task-tools.js";

/** The services every Studio tool reads and writes through, the same for every call. */
export type StudioToolDeps = {
  artifacts: ArtifactStore;
  db: Queryable;
  schedules: Schedules;
  drafts: StudioDraftService;
  preview: PreviewDeps;
  notesSystemPath: string;
  mcp?: StudioMcpClient | null;
};

/**
 * A coach tool call: the session and the operator it runs for, with the private guilds hidden from
 * them as the generation started, and its place in the transcript.
 */
export type StudioToolCall = StudioOperator & {
  session: StudioSessionRow;
  generation: number;
  /** The seq the call's result takes in the session's messages. */
  nextMessageSeq?: number;
};

/**
 * A Studio tool: its name, the function schema the coach is offered, and its handler of one call's
 * arguments, which answers the JSON object the coach reads as the call's result.
 */
export type StudioTool = {
  name: string;
  schema: FunctionTool;
  handler: (deps: StudioToolDeps, call: StudioToolCall, args: JsonObject) => Promise<JsonObject>;
};

export const STUDIO_TOOLS: StudioTool[] = [
  studioGetGuidelines,
  studioGetAgentContext,
  studioListRoutines,
  studioListRuns,
  studioGetRun,
  studioListGroupMessages,
  studioListTaskRevisions,
  studioListMemoryRevisions,
  studioGetMemoryVersion,
  studioFindArtifacts,
  studioGetArtifact,
  studioListFileChanges,
  studioGetScript,
  studioGetAgentAccess,
  studioRequestConnectionAccess,
  studioCallConnectionTool,
  studioCreateTaskDraft,
  studioGetGuild,
  studioListGuilds,
  studioListCollections,
  studioGetCollection,
  studioEditMemory,
  studioEditNote,
  studioEditGuild,
  studioEditAccess,
  studioEditCollection,
  studioEditRoutine,
];

export function studioToolSchemas(): FunctionTool[] {
  return STUDIO_TOOLS.map((tool) => tool.schema);
}

export function studioToolMap(): Map<string, StudioTool> {
  return new Map(STUDIO_TOOLS.map((tool) => [tool.name, tool]));
}
