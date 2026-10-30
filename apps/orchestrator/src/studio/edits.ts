import { createHash } from "node:crypto";
import { hashArtifactContent, type ArtifactStore } from "../artifacts/store.js";
import { updateGuildText } from "../guilds/service.js";
import type { Schedules } from "../schedules/service.js";
import { GuildValidationError, validateGuildTextPatch, type GuildTextPatch } from "../guilds/validation.js";
import { STUDIO_ACCESS_TOOLS, applyAccess, isAccessTool, reviewAccess, reviewAccessRequest } from "./access.js";
import { StudioConflictError, StudioError, StudioUnprocessableError, artifactFailure } from "./errors.js";
import type { StudioOrigin } from "../lib/change-actor.js";
import { editActor } from "./actor.js";
import { editActionOf } from "./actions.js";
import { STUDIO_EDIT_WIDGET, assertContent, awaitOperator, lineDelta, requireReason } from "./edit-request.js";
import { STUDIO_NOTE_TOOL, applyNote, loadNoteBase, reviewRecordedNote, type NoteAction } from "./note-edits.js";
import { STUDIO_TABLE_TOOL, applyTable, isTableTool, reviewTable } from "./tables.js";
import { STUDIO_ROUTINE_TOOL, applyRoutine, isRoutineTool, reviewRoutine, type RoutineChange } from "./routines.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { getGuild, type GuildRow } from "../db/guilds.js";
import type { Queryable } from "../db/pg.js";
import { getConversationMessage, updateConversationMessage, type ConversationMessageRow } from "../db/conversations.js";
import type { ConversationMessageMetadata, ToolCall } from "../db/schema/index.js";
import type { UserRow } from "../db/users.js";
import { writeNoteAt } from "../artifacts/notes.js";
import { readMemoryVersion, writeMemory } from "../artifacts/memory.js";

export const STUDIO_EDIT_TOOLS = [
  "studio_edit_memory",
  STUDIO_NOTE_TOOL,
  "studio_edit_guild",
  STUDIO_TABLE_TOOL,
  ...STUDIO_ACCESS_TOOLS,
  STUDIO_ROUTINE_TOOL,
] as const;
export type StudioEditTool = (typeof STUDIO_EDIT_TOOLS)[number];

export type StudioEditKind = "memory" | "note" | "guild" | "collection" | "access" | "routine";
export type StudioEditStatus = "pending" | "applied" | "declined";

export type GuildText = { about: string; description: string };

// The live content a proposal replaces, in the shape its kind compares.
export type EditBase =
  | { kind: "memory"; agentId: string; agentName: string; guildId: string; version: number; content: string }
  | {
      kind: "note";
      displayPath: string;
      level: "agent" | "guild" | "org";
      ownerId: string;
      title: string | null;
      guildId: string;
      version: number;
      content: string;
    }
  | { kind: "guild"; guildId: string; guildName: string; text: GuildText };

/** The stores a Studio edit reads and writes through. */
export type EditDeps = {
  db: Queryable;
  artifacts: ArtifactStore;
  schedules: Schedules;
};

/** The Studio session an edit belongs to, and the operator who proposes or applies it. */
export type EditScope = {
  orgId: string;
  sourceGuildId: string;
  /** The Studio session the edits belong to. */
  sessionId: string;
  /** The coach message being applied; set by `applyEdit` so every write links to it. */
  origin?: StudioOrigin;
  user: UserRow;
};

export function guildTextHash(text: GuildText): string {
  return createHash("sha256").update(JSON.stringify([text.about, text.description]), "utf8").digest("hex");
}

/** The agent's Memory as the operator reads it; an agent without one has an empty Memory at version 0. */
export async function loadMemoryBase(
  deps: EditDeps,
  scope: EditScope,
  agent: Pick<AgentRow, "id" | "name">,
): Promise<EditBase> {
  const memory = await readMemoryVersion(
    deps.artifacts,
    editActor(scope, { agentId: agent.id }),
    agent.id,
  );
  return {
    kind: "memory",
    agentId: agent.id,
    agentName: agent.name,
    guildId: scope.sourceGuildId,
    version: memory.version,
    content: memory.content,
  };
}

export async function loadGuildBase(deps: EditDeps, scope: EditScope): Promise<EditBase> {
  const guild = await getGuild(deps.db, scope.sourceGuildId);
  if (!guild || String(guild.org_id) !== scope.orgId) {
    throw new StudioUnprocessableError("source guild not found");
  }
  return {
    kind: "guild",
    guildId: String(guild.id),
    guildName: String(guild.name),
    text: { about: String(guild.about ?? ""), description: String(guild.description ?? "") },
  };
}

/** The guild text a studio_edit_guild call sets: each of about and description it gives as a string. */
function guildTextPatch(args: Record<string, unknown>): GuildTextPatch {
  return {
    ...(typeof args.about === "string" ? { about: args.about } : {}),
    ...(typeof args.description === "string" ? { description: args.description } : {}),
  };
}

// The complete replacement a tool call asks for, validated against its base.
export function proposedFor(base: EditBase, args: Record<string, unknown>): string | GuildText {
  if (base.kind === "guild") {
    const patch = guildTextPatch(args);
    if (patch.about === undefined && patch.description === undefined) {
      throw new StudioUnprocessableError("studio_edit_guild requires about, description, or both");
    }
    try {
      return { ...base.text, ...validateGuildTextPatch(patch) };
    } catch (error) {
      if (error instanceof GuildValidationError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
  }
  if (typeof args.content !== "string") {
    throw new StudioUnprocessableError("content is required: the complete replacement text");
  }
  assertContent(args.content);
  return args.content;
}

function baseHash(base: EditBase): string {
  return base.kind === "guild" ? guildTextHash(base.text) : hashArtifactContent(base.content);
}

function proposedHash(proposed: string | GuildText): string {
  return typeof proposed === "string" ? hashArtifactContent(proposed) : guildTextHash(proposed);
}

function targetOf(base: EditBase): Record<string, unknown> {
  if (base.kind === "memory") {
    return { agent_id: base.agentId, agent_name: base.agentName };
  }
  if (base.kind === "note") {
    return { display_path: base.displayPath, title: base.title };
  }
  return { guild_id: base.guildId, guild_name: base.guildName };
}

function titleOf(base: EditBase): string {
  if (base.kind === "memory") return `Edit ${base.agentName}'s Memory`;
  if (base.kind === "note") return `Edit ${base.title || base.displayPath.split("/").pop() || "note"}`;
  return `Edit ${base.guildName} description`;
}

// The widget an edit tool returns. It carries hashes and line counts, not the
// content: the proposal stays in the tool call arguments.
export function editRequest(
  base: EditBase,
  args: Record<string, unknown>,
  expectedVersion: number | null,
): Record<string, unknown> {
  if (base.kind !== "guild" && expectedVersion !== null && expectedVersion !== base.version) {
    throw new StudioConflictError(
      `base_version ${expectedVersion} is stale; the live version is ${base.version}. Read it again and rebuild the edit.`,
    );
  }
  const proposed = proposedFor(base, args);
  const reason = requireReason(args);
  const fromHash = baseHash(base);
  const toHash = proposedHash(proposed);
  if (fromHash === toHash) {
    throw new StudioUnprocessableError("the proposed content equals the live content; nothing to edit");
  }
  const changed =
    base.kind === "guild"
      ? (["about", "description"] as const).filter((field) => (proposed as GuildText)[field] !== base.text[field])
      : null;
  const lines =
    base.kind === "guild"
      ? lineDelta(`${base.text.about}\n${base.text.description}`, `${(proposed as GuildText).about}\n${(proposed as GuildText).description}`)
      : lineDelta(base.content, proposed as string);
  return awaitOperator(titleOf(base), reason, {
    kind: base.kind,
    target: targetOf(base),
    ...(base.kind === "guild" ? { fields: changed } : { base_version: base.version }),
    base_hash: fromHash,
    proposed_hash: toHash,
    lines,
  });
}

// A table tool's widget: the table it creates, changes, or deletes, and what
// applying does to its records and readers.
export async function tableEditRequest(
  deps: EditDeps,
  scope: EditScope,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reason = requireReason(args);
  const review = await reviewTable(deps, scope, args, null);
  return awaitOperator(review.title, reason, {
    kind: "collection",
    action: review.action,
    target: review.target,
    base_hash: review.baseHash,
    proposed_hash: review.proposedHash,
    lines: lineDelta(review.live, review.proposed),
    effects: review.effects,
  });
}

// A routine tool's widget: the routine it creates, changes, or deletes, and
// when the agent wakes after applying.
export async function routineEditRequest(
  deps: EditDeps,
  scope: EditScope,
  call: { args: Record<string, unknown>; agentId: string | null },
): Promise<Record<string, unknown>> {
  const reason = requireReason(call.args);
  const review = await reviewRoutine(deps, scope, editActionOf(call.args), call);
  return awaitOperator(review.title, reason, {
    kind: "routine",
    action: review.action,
    target: review.target,
    base_hash: review.baseHash,
    proposed_hash: review.proposedHash,
    lines: lineDelta(review.live, review.proposed),
    effects: review.effects,
  });
}

// An access tool's widget: the agent's access before and after, and what applying does.
export async function accessEditRequest(
  deps: EditDeps,
  scope: EditScope,
  agentId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reason = requireReason(args);
  const review = await reviewAccessRequest(deps, scope, agentId, args);
  return awaitOperator(review.title, reason, {
    kind: "access",
    target: review.target,
    base_hash: review.baseHash,
    proposed_hash: review.proposedHash,
    lines: lineDelta(review.live, review.proposed),
    effects: review.effects,
    changes: review.changes,
    widens: review.widens,
  });
}

// ---------------------------------------------------------------------------
// Operator side: read and resolve one edit request by its tool message seq.

export type EditRecord = {
  seq: number;
  toolName: StudioEditTool;
  toolCallId: string;
  widget: Record<string, unknown>;
  args: Record<string, unknown>;
  metadata: ConversationMessageMetadata;
};

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isEditTool(name: string): name is StudioEditTool {
  return STUDIO_EDIT_TOOLS.some((tool) => tool === name);
}

/** The call of an assistant message in `messages` with the id `callId`. */
function callById(messages: ConversationMessageRow[], callId: string): ToolCall | undefined {
  for (const { payload } of messages) {
    const call = payload.role === "assistant" ? payload.tool_calls?.find((item) => item.id === callId) : undefined;
    if (call) {
      return call;
    }
  }
  return undefined;
}

export function findEditRecord(messages: ConversationMessageRow[], seq: number): EditRecord {
  const message = messages.find((row) => row.seq === seq);
  const payload = message?.payload;
  const widget = payload?.role === "tool" ? parseJsonObject(payload.content) : null;
  if (!message || payload?.role !== "tool" || !widget || widget.widget !== STUDIO_EDIT_WIDGET) {
    throw new StudioError(404, "edit request not found");
  }
  const toolCallId = payload.tool_call_id;
  const call = callById(messages, toolCallId);
  const args = call ? parseJsonObject(call.function.arguments) : null;
  if (!call || !args || !isEditTool(call.function.name)) {
    throw new StudioError(404, "edit request not found");
  }
  return { seq, toolName: call.function.name, toolCallId, widget, args, metadata: message.metadata };
}

export function editStatus(record: EditRecord): StudioEditStatus {
  return record.metadata.edit_status ?? "pending";
}

async function loadBaseFor(
  deps: EditDeps,
  scope: EditScope,
  record: EditRecord,
): Promise<EditBase> {
  const edit = (record.widget.edit ?? {}) as Record<string, unknown>;
  const target = (edit.target ?? {}) as Record<string, unknown>;
  if (record.toolName === "studio_edit_memory") {
    const agent = await getAgent(deps.db, String(target.agent_id ?? ""));
    if (!agent || agent.guild_id !== scope.sourceGuildId) {
      throw new StudioUnprocessableError("agent is not in the source guild");
    }
    return loadMemoryBase(deps, scope, agent);
  }
  if (record.toolName === STUDIO_NOTE_TOOL) {
    return loadNoteBase(deps, scope, String(target.display_path ?? ""));
  }
  if (record.toolName === "studio_edit_guild") {
    return loadGuildBase(deps, scope);
  }
  throw new StudioError(404, "edit request not found");
}

/** A note create or delete; null for a note edit and for every other tool. */
function noteActionOf(record: EditRecord): NoteAction | null {
  if (record.toolName !== STUDIO_NOTE_TOOL) {
    return null;
  }
  const action = editActionOf(record.args);
  return action === "edit" ? null : action;
}

function liveContent(base: EditBase): string | GuildText {
  return base.kind === "guild" ? base.text : base.content;
}

// What the operator reviews: the live content, the proposal, and whether the
// live content still matches the base the proposal was built on.
export async function viewEdit(
  deps: EditDeps,
  scope: EditScope,
  record: EditRecord,
): Promise<Record<string, unknown>> {
  const edit = (record.widget.edit ?? {}) as Record<string, unknown>;
  const status = editStatus(record);
  if (isTableTool(record.toolName)) {
    return viewReviewedEdit(record, edit, status, () =>
      reviewTable(deps, scope, record.args, (edit.target ?? {}) as Record<string, unknown>),
    );
  }
  const noteAction = noteActionOf(record);
  if (noteAction) {
    return viewReviewedEdit(record, edit, status, () =>
      reviewRecordedNote(
        deps,
        scope,
        noteAction,
        record.args,
        (edit.target ?? {}) as Record<string, unknown>,
      ),
    );
  }
  if (isRoutineTool(record.toolName)) {
    return viewReviewedEdit(record, edit, status, () =>
      reviewRoutine(deps, scope, editActionOf(record.args), {
        args: record.args,
        agentId: recordedAgentId(edit),
      }),
    );
  }
  if (isAccessTool(record.toolName)) {
    return viewReviewedEdit(record, edit, status, () =>
      reviewAccess(deps, scope, recordedAgentId(edit), record.args),
    );
  }
  let live: EditBase | null = null;
  let error: string | null = null;
  try {
    live = await loadBaseFor(deps, scope, record);
  } catch (caught) {
    if (!(caught instanceof StudioError)) throw caught;
    error = caught.message;
  }
  const proposed = live ? proposedFor(live, record.args) : null;
  return {
    seq: record.seq,
    tool: record.toolName,
    status,
    title: record.widget.title,
    reason: record.widget.reason,
    edit,
    live: live ? liveContent(live) : null,
    live_version: live && live.kind !== "guild" ? live.version : null,
    proposed,
    stale: live ? baseHash(live) !== String(edit.base_hash ?? "") : true,
    ...(error ? { error } : {}),
    ...(status !== "pending" ? { resolved_at: record.metadata.edit_resolved_at ?? null } : {}),
    ...(status === "applied" ? { applied_version: record.metadata.edit_version ?? null } : {}),
  };
}

function recordedAgentId(edit: Record<string, unknown>): string {
  return String(((edit.target ?? {}) as Record<string, unknown>).agent_id ?? "");
}

// A table, note create or delete, routine, or access edit rendered as text on both
// sides, with what applying does. A resolved request is not reviewed again:
// its target has moved on.
async function viewReviewedEdit(
  record: EditRecord,
  edit: Record<string, unknown>,
  status: StudioEditStatus,
  review: () => Promise<{ live: string; proposed: string; effects: string[]; baseHash: string }>,
): Promise<Record<string, unknown>> {
  let reviewed = null;
  let error: string | null = null;
  if (status === "pending") {
    try {
      reviewed = await review();
    } catch (caught) {
      if (!(caught instanceof StudioError)) throw caught;
      error = caught.message;
    }
  }
  return {
    seq: record.seq,
    tool: record.toolName,
    status,
    title: record.widget.title,
    reason: record.widget.reason,
    edit,
    live: reviewed?.live ?? null,
    live_version: null,
    proposed: reviewed?.proposed ?? null,
    effects: reviewed?.effects ?? [],
    stale: status === "pending" && (reviewed ? reviewed.baseHash !== String(edit.base_hash ?? "") : true),
    ...(error ? { error } : {}),
    ...(status !== "pending" ? { resolved_at: record.metadata.edit_resolved_at ?? null } : {}),
    ...(status === "applied" && record.metadata.edit_version ? { applied_version: record.metadata.edit_version } : {}),
  };
}

function assertBound(review: { baseHash: string; proposedHash: string }, edit: Record<string, unknown>, what: string): void {
  if (review.baseHash !== String(edit.base_hash ?? "")) {
    throw new StudioConflictError(`the live ${what} changed since this edit was proposed`);
  }
  if (review.proposedHash !== String(edit.proposed_hash ?? "")) {
    throw new StudioConflictError("the proposal no longer matches its request");
  }
}

// Write the proposal as the operator, linked to the coach message that
// proposed it. The live content must still hash to the base the proposal was
// built on; anything else is a conflict.
export async function applyEdit(
  deps: EditDeps,
  live: EditScope,
  record: EditRecord,
): Promise<{ version: number | null; guild?: GuildRow; routine?: RoutineChange }> {
  const scope: EditScope = { ...live, origin: { sessionId: live.sessionId, seq: record.seq } };
  const edit = (record.widget.edit ?? {}) as Record<string, unknown>;
  if (isRoutineTool(record.toolName)) {
    const call = { args: record.args, agentId: recordedAgentId(edit) };
    const review = await reviewRoutine(deps, scope, editActionOf(record.args), call);
    assertBound(review, edit, "routine");
    return { version: null, routine: await applyRoutine(deps, scope, review.plan) };
  }
  if (isTableTool(record.toolName)) {
    const target = (edit.target ?? {}) as Record<string, unknown>;
    const review = await reviewTable(deps, scope, record.args, target);
    assertBound(review, edit, "table");
    await applyTable(deps, scope, review.plan);
    return { version: null };
  }
  const noteAction = noteActionOf(record);
  if (noteAction) {
    const target = (edit.target ?? {}) as Record<string, unknown>;
    const review = await reviewRecordedNote(deps, scope, noteAction, record.args, target);
    assertBound(review, edit, "note");
    return { version: await applyNote(deps, scope, review.plan) };
  }
  if (isAccessTool(record.toolName)) {
    const agentId = recordedAgentId(edit);
    const review = await reviewAccess(deps, scope, agentId, record.args);
    assertBound(review, edit, "access");
    await applyAccess(deps, scope, agentId, review);
    return { version: null };
  }
  const base = await loadBaseFor(deps, scope, record);
  if (baseHash(base) !== String(edit.base_hash ?? "")) {
    throw new StudioConflictError("the live content changed since this edit was proposed");
  }
  const proposed = proposedFor(base, record.args);
  if (proposedHash(proposed) !== String(edit.proposed_hash ?? "")) {
    throw new StudioConflictError("the proposal no longer matches its request");
  }
  const toolCall = { id: record.toolCallId, name: record.toolName };
  if (base.kind === "memory") {
    const actor = { ...editActor(scope, { agentId: base.agentId }), toolCall };
    try {
      const { row } = await writeMemory(deps.artifacts, actor, base.agentId, { content: proposed as string, detail: record.toolName, ...(base.version > 0 ? { expectedVersion: base.version } : {}) });
      return { version: row.version };
    } catch (error) {
      artifactFailure(error);
    }
  }
  if (base.kind === "note") {
    const actor = {
      ...editActor(scope, {
        guildId: base.guildId,
        ...(base.level === "agent" ? { agentId: base.ownerId } : {}),
      }),
      toolCall,
    };
    try {
      const written = await writeNoteAt(deps.artifacts, actor, base.displayPath, {
        content: proposed as string,
        expectedVersion: base.version,
      });
      return { version: written.row.version };
    } catch (error) {
      artifactFailure(error);
    }
  }
  const row = await updateGuildText(deps.db, base.guildId, guildTextPatch(record.args), editActor(scope));
  if (!row) {
    throw new StudioUnprocessableError("source guild not found");
  }
  return { version: null, guild: row };
}

/** How the operator answered an edit request, and who answered it. */
export type EditResolution = {
  status: Exclude<StudioEditStatus, "pending">;
  version: number | null;
  userId: string | null;
};

export async function markEdit(
  db: Queryable,
  sessionId: string,
  record: EditRecord,
  resolution: EditResolution,
): Promise<void> {
  const message = await getConversationMessage(db, "studio", sessionId, record.seq);
  if (!message) return;
  await updateConversationMessage(db, "studio", {
    session_id: sessionId,
    seq: record.seq,
    payload: message.payload,
    metadata: {
      ...record.metadata,
      edit_status: resolution.status,
      edit_resolved_at: new Date().toISOString(),
      resolved_by_user_id: resolution.userId,
      ...(resolution.status === "applied" ? { edit_version: resolution.version } : {}),
    },
  });
}
