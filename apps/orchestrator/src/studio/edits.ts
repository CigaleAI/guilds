import { createHash } from "node:crypto";
import { hashArtifactContent, type ArtifactStore } from "../artifacts/store.js";
import { updateGuildText } from "../guilds/service.js";
import type { Schedules } from "../schedules/service.js";
import { GuildValidationError, validateGuildTextPatch, type GuildTextPatch } from "../guilds/validation.js";
import { STUDIO_ACCESS_TOOLS, applyAccess, reviewAccess, reviewAccessRequest } from "./access.js";
import { StudioConflictError, StudioError, StudioUnprocessableError, artifactFailure } from "./errors.js";
import type { StudioOrigin } from "../lib/change-actor.js";
import { editActor } from "./actor.js";
import { editActionOf } from "./actions.js";
import {
  assertContent,
  awaitOperator,
  lineDelta,
  parseEditWidget,
  requireReason,
  type StudioEdit,
  type StudioEditWidget,
} from "./edit-request.js";
import { STUDIO_NOTE_TOOL, applyNote, loadNoteBase, reviewRecordedNote } from "./note-edits.js";
import { STUDIO_TABLE_TOOL, applyTable, reviewTable } from "./tables.js";
import { STUDIO_ROUTINE_TOOL, applyRoutine, reviewRoutine, type RoutineCall } from "./routines.js";
import type { RoutineChange } from "../schedules/operator.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { getGuild, type GuildRow } from "../db/guilds.js";
import { isPlainRecord } from "../db/json.js";
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

type GuildBase = Extract<EditBase, { kind: "guild" }>;

const GUILD_TEXT_FIELDS = ["about", "description"] as const;

/** The guild text a studio_edit_guild call asks for, validated and laid over the live text. */
function proposedGuildText(base: GuildBase, args: Record<string, unknown>): GuildText {
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

/** The complete replacement text a Memory or note edit asks for. */
function proposedContent(args: Record<string, unknown>): string {
  if (typeof args.content !== "string") {
    throw new StudioUnprocessableError("content is required: the complete replacement text");
  }
  assertContent(args.content);
  return args.content;
}

// The complete replacement a tool call asks for, validated against its base.
export function proposedFor(base: EditBase, args: Record<string, unknown>): string | GuildText {
  return base.kind === "guild" ? proposedGuildText(base, args) : proposedContent(args);
}

function baseHash(base: EditBase): string {
  return base.kind === "guild" ? guildTextHash(base.text) : hashArtifactContent(base.content);
}

function titleOf(base: EditBase): string {
  if (base.kind === "memory") return `Edit ${base.agentName}'s Memory`;
  if (base.kind === "note") return `Edit ${base.title || base.displayPath.split("/").pop() || "note"}`;
  return `Edit ${base.guildName} description`;
}

/** The hashes that bind an edit to the live content and to its proposal. */
type EditHashes = { base_hash: string; proposed_hash: string };

/** The hashes of the live content and the proposal, which must differ for there to be an edit. */
function editHashes(fromHash: string, toHash: string): EditHashes {
  if (fromHash === toHash) {
    throw new StudioUnprocessableError("the proposed content equals the live content; nothing to edit");
  }
  return { base_hash: fromHash, proposed_hash: toHash };
}

/** What an edit of `base` to the proposal `args` asks for changes. */
function bodyEdit(base: EditBase, args: Record<string, unknown>): { edit: StudioEdit; reason: string } {
  if (base.kind === "guild") {
    const proposed = proposedGuildText(base, args);
    const reason = requireReason(args);
    const hashes = editHashes(guildTextHash(base.text), guildTextHash(proposed));
    return {
      reason,
      edit: {
        kind: "guild",
        target: { guild_id: base.guildId, guild_name: base.guildName },
        fields: GUILD_TEXT_FIELDS.filter((field) => proposed[field] !== base.text[field]),
        ...hashes,
        lines: lineDelta(`${base.text.about}\n${base.text.description}`, `${proposed.about}\n${proposed.description}`),
      },
    };
  }
  const proposed = proposedContent(args);
  const reason = requireReason(args);
  const bound = {
    base_version: base.version,
    ...editHashes(hashArtifactContent(base.content), hashArtifactContent(proposed)),
    lines: lineDelta(base.content, proposed),
  };
  return {
    reason,
    edit:
      base.kind === "memory"
        ? { kind: "memory", target: { agent_id: base.agentId, agent_name: base.agentName }, ...bound }
        : { kind: "note", target: { display_path: base.displayPath, title: base.title }, ...bound },
  };
}

// The widget an edit tool returns. It carries hashes and line counts, not the
// content: the proposal stays in the tool call arguments.
export function editRequest(
  base: EditBase,
  args: Record<string, unknown>,
  expectedVersion: number | null,
): StudioEditWidget {
  if (base.kind !== "guild" && expectedVersion !== null && expectedVersion !== base.version) {
    throw new StudioConflictError(
      `base_version ${expectedVersion} is stale; the live version is ${base.version}. Read it again and rebuild the edit.`,
    );
  }
  const { edit, reason } = bodyEdit(base, args);
  return awaitOperator(titleOf(base), reason, edit);
}

// A table tool's widget: the table it creates, changes, or deletes, and what
// applying does to its records and readers.
export async function tableEditRequest(
  deps: EditDeps,
  scope: EditScope,
  args: Record<string, unknown>,
): Promise<StudioEditWidget> {
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
  call: RoutineCall,
): Promise<StudioEditWidget> {
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
): Promise<StudioEditWidget> {
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
  widget: StudioEditWidget;
  args: Record<string, unknown>;
  metadata: ConversationMessageMetadata;
};

/** A tool call's arguments as an object, or null when they are not one. */
function parseArguments(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainRecord(parsed) ? parsed : null;
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
  const widget = payload?.role === "tool" ? parseEditWidget(payload.content) : null;
  if (!message || payload?.role !== "tool" || !widget) {
    throw new StudioError(404, "edit request not found");
  }
  const toolCallId = payload.tool_call_id;
  const call = callById(messages, toolCallId);
  const args = call ? parseArguments(call.function.arguments) : null;
  if (!call || !args || !isEditTool(call.function.name)) {
    throw new StudioError(404, "edit request not found");
  }
  return { seq, toolName: call.function.name, toolCallId, widget, args, metadata: message.metadata };
}

export function editStatus(record: EditRecord): StudioEditStatus {
  return record.metadata.edit_status ?? "pending";
}

/** The live content a Memory, note body, or guild text edit replaces. */
async function loadBaseFor(deps: EditDeps, scope: EditScope, edit: StudioEdit): Promise<EditBase> {
  switch (edit.kind) {
    case "memory": {
      const agent = await getAgent(deps.db, edit.target.agent_id);
      if (!agent || agent.guild_id !== scope.sourceGuildId) {
        throw new StudioUnprocessableError("agent is not in the source guild");
      }
      return loadMemoryBase(deps, scope, agent);
    }
    case "note":
      return loadNoteBase(deps, scope, edit.target.display_path);
    case "guild":
      return loadGuildBase(deps, scope);
    default:
      throw new StudioError(404, "edit request not found");
  }
}

function liveContent(base: EditBase): string | GuildText {
  return base.kind === "guild" ? base.text : base.content;
}

/** A reviewed edit: its target before and after as text, what applying does, and the hash of what it read. */
type ReviewedEdit = { live: string; proposed: string; effects: string[]; baseHash: string };

/**
 * The review of a table, routine, access, or note create or delete edit, run against the live
 * target; null for an edit that replaces a Memory, a note body, or the guild's text.
 */
function reviewerOf(deps: EditDeps, scope: EditScope, record: EditRecord): (() => Promise<ReviewedEdit>) | null {
  const { edit } = record.widget;
  switch (edit.kind) {
    case "collection":
      return () => reviewTable(deps, scope, record.args, edit.target);
    case "routine":
      return () =>
        reviewRoutine(deps, scope, editActionOf(record.args), { args: record.args, agentId: edit.target.agent_id });
    case "access":
      return () => reviewAccess(deps, scope, edit.target.agent_id, record.args);
    case "note":
      return "action" in edit ? () => reviewRecordedNote(deps, scope, edit.action, record.args, edit.target) : null;
    default:
      return null;
  }
}

// What the operator reviews: the live content, the proposal, and whether the
// live content still matches the base the proposal was built on.
export async function viewEdit(
  deps: EditDeps,
  scope: EditScope,
  record: EditRecord,
): Promise<Record<string, unknown>> {
  const { edit } = record.widget;
  const status = editStatus(record);
  const reviewer = reviewerOf(deps, scope, record);
  if (reviewer) {
    return viewReviewedEdit(record, status, reviewer);
  }
  let live: EditBase | null = null;
  let error: string | null = null;
  try {
    live = await loadBaseFor(deps, scope, edit);
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
    stale: live ? baseHash(live) !== edit.base_hash : true,
    ...(error ? { error } : {}),
    ...(status !== "pending" ? { resolved_at: record.metadata.edit_resolved_at ?? null } : {}),
    ...(status === "applied" ? { applied_version: record.metadata.edit_version ?? null } : {}),
  };
}

// A table, note create or delete, routine, or access edit rendered as text on both
// sides, with what applying does. A resolved request is not reviewed again:
// its target has moved on.
async function viewReviewedEdit(
  record: EditRecord,
  status: StudioEditStatus,
  review: () => Promise<ReviewedEdit>,
): Promise<Record<string, unknown>> {
  const { edit } = record.widget;
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
    stale: status === "pending" && (reviewed ? reviewed.baseHash !== edit.base_hash : true),
    ...(error ? { error } : {}),
    ...(status !== "pending" ? { resolved_at: record.metadata.edit_resolved_at ?? null } : {}),
    ...(status === "applied" && record.metadata.edit_version ? { applied_version: record.metadata.edit_version } : {}),
  };
}

/** A review's hashes: of the live target it read, and of the proposal. */
type ReviewHashes = { baseHash: string; proposedHash: string };

function assertBound(review: ReviewHashes, edit: StudioEdit, what: string): void {
  if (review.baseHash !== edit.base_hash) {
    throw new StudioConflictError(`the live ${what} changed since this edit was proposed`);
  }
  if (review.proposedHash !== edit.proposed_hash) {
    throw new StudioConflictError("the proposal no longer matches its request");
  }
}

/** What applying an edit wrote: the new version of a Memory or note, the guild it changed, or the routine. */
export type AppliedEdit = { version: number | null; guild?: GuildRow; routine?: RoutineChange };

/** Applies a table, routine, access, or note create or delete edit; null for an edit that replaces content. */
async function applyReviewed(deps: EditDeps, scope: EditScope, record: EditRecord): Promise<AppliedEdit | null> {
  const { edit } = record.widget;
  switch (edit.kind) {
    case "routine": {
      const call = { args: record.args, agentId: edit.target.agent_id };
      const review = await reviewRoutine(deps, scope, editActionOf(record.args), call);
      assertBound(review, edit, "routine");
      return { version: null, routine: await applyRoutine(deps, scope, review.plan) };
    }
    case "collection": {
      const review = await reviewTable(deps, scope, record.args, edit.target);
      assertBound(review, edit, "table");
      await applyTable(deps, scope, review.plan);
      return { version: null };
    }
    case "access": {
      const review = await reviewAccess(deps, scope, edit.target.agent_id, record.args);
      assertBound(review, edit, "access");
      await applyAccess(deps, scope, edit.target.agent_id, review);
      return { version: null };
    }
    case "note": {
      if (!("action" in edit)) return null;
      const review = await reviewRecordedNote(deps, scope, edit.action, record.args, edit.target);
      assertBound(review, edit, "note");
      return { version: await applyNote(deps, scope, review.plan) };
    }
    default:
      return null;
  }
}

/** Writes the replacement a Memory, note body, or guild text edit proposes, over the base it was built on. */
async function applyContent(deps: EditDeps, scope: EditScope, record: EditRecord): Promise<AppliedEdit> {
  const { edit } = record.widget;
  const base = await loadBaseFor(deps, scope, edit);
  if (baseHash(base) !== edit.base_hash) {
    throw new StudioConflictError("the live content changed since this edit was proposed");
  }
  if (base.kind === "guild") {
    if (guildTextHash(proposedGuildText(base, record.args)) !== edit.proposed_hash) {
      throw new StudioConflictError("the proposal no longer matches its request");
    }
    const row = await updateGuildText(deps.db, base.guildId, guildTextPatch(record.args), editActor(scope));
    if (!row) {
      throw new StudioUnprocessableError("source guild not found");
    }
    return { version: null, guild: row };
  }
  const proposed = proposedContent(record.args);
  if (hashArtifactContent(proposed) !== edit.proposed_hash) {
    throw new StudioConflictError("the proposal no longer matches its request");
  }
  const toolCall = { id: record.toolCallId, name: record.toolName };
  try {
    if (base.kind === "memory") {
      const actor = { ...editActor(scope, { agentId: base.agentId }), toolCall };
      const { row } = await writeMemory(deps.artifacts, actor, base.agentId, {
        content: proposed,
        detail: record.toolName,
        ...(base.version > 0 ? { expectedVersion: base.version } : {}),
      });
      return { version: row.version };
    }
    const actor = {
      ...editActor(scope, {
        guildId: base.guildId,
        ...(base.level === "agent" ? { agentId: base.ownerId } : {}),
      }),
      toolCall,
    };
    const written = await writeNoteAt(deps.artifacts, actor, base.displayPath, {
      content: proposed,
      expectedVersion: base.version,
    });
    return { version: written.row.version };
  } catch (error) {
    artifactFailure(error);
  }
}

// Write the proposal as the operator, linked to the coach message that
// proposed it. The live content must still hash to the base the proposal was
// built on; anything else is a conflict.
export async function applyEdit(deps: EditDeps, live: EditScope, record: EditRecord): Promise<AppliedEdit> {
  const scope: EditScope = { ...live, origin: { sessionId: live.sessionId, seq: record.seq } };
  return (await applyReviewed(deps, scope, record)) ?? applyContent(deps, scope, record);
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
