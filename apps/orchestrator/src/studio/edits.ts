import { createHash } from "node:crypto";
import {
  ArtifactError,
  assertNoteKeyFree,
  hashArtifactContent,
  normalizeNoteKey,
  ownerPrefix,
  parseDisplayPath,
  type ArtifactStore,
} from "../artifacts/index.js";
import { WRITE_MAX_BYTES } from "../artifacts/types.js";
import { jsonObj } from "../db/json.js";
import type { Repositories } from "../db/repositories.js";
import { GuildValidationError, validateAbout, validateGuildDescription } from "../guilds/validation.js";
import { argString } from "../toolbox/schema.js";
import { STUDIO_ACCESS_TOOLS, applyAccess, isAccessTool, reviewAccess } from "./access.js";
import { StudioConflictError, StudioError, StudioUnprocessableError } from "./errors.js";
import type { StudioStore } from "./store.js";
import { STUDIO_TABLE_TOOLS, applyTable, isTableTool, reviewTable, type StudioTableTool } from "./tables.js";

// An edit tool never writes. It returns this widget; the turn pauses until
// the operator applies or declines the proposal from the Studio log.
export const STUDIO_EDIT_WIDGET = "studio_edit_request";

// Notes the coach proposes to create or delete, beside the edits of existing ones.
export const STUDIO_NOTE_TOOLS = ["studio_create_note", "studio_delete_note"] as const;
export type StudioNoteTool = (typeof STUDIO_NOTE_TOOLS)[number];

export function isNoteTool(name: string): name is StudioNoteTool {
  return (STUDIO_NOTE_TOOLS as readonly string[]).includes(name);
}

export const STUDIO_EDIT_TOOLS = [
  "studio_edit_memory",
  "studio_edit_artifact",
  "studio_edit_guild",
  ...STUDIO_NOTE_TOOLS,
  ...STUDIO_TABLE_TOOLS,
  ...STUDIO_ACCESS_TOOLS,
] as const;
export type StudioEditTool = (typeof STUDIO_EDIT_TOOLS)[number];

export type StudioEditKind = "memory" | "note" | "guild" | "collection" | "access";
export type StudioEditStatus = "pending" | "applied" | "declined";

export type GuildText = { about: string; description: string };

// The live content a proposal replaces, in the shape its kind compares.
type EditBase =
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

export type EditScope = {
  orgId: string;
  sourceGuildId: string;
  user: Record<string, unknown>;
  repo: Repositories;
  artifacts: ArtifactStore;
};

export function guildTextHash(text: GuildText): string {
  return createHash("sha256").update(JSON.stringify([text.about, text.description]), "utf8").digest("hex");
}

function lineDelta(before: string, after: string): { added: number; removed: number } {
  const count = (lines: string[]) => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before ? before.split("\n") : []);
  const b = count(after ? after.split("\n") : []);
  let removed = 0;
  let added = 0;
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  return { added, removed };
}

function operator(scope: EditScope, extra: { guildId?: string; agentId?: string } = {}) {
  return scope.artifacts.operatorContext(scope.orgId, String(scope.user.id), String(scope.user.name ?? "operator"), {
    guildId: extra.guildId ?? scope.sourceGuildId,
    agentId: extra.agentId ?? null,
  });
}

function artifactFailure(error: unknown): never {
  if (error instanceof ArtifactError) {
    throw error.status === 409 ? new StudioConflictError(error.message) : new StudioUnprocessableError(error.message);
  }
  throw error;
}

async function sourceAgentIds(scope: EditScope): Promise<Set<string>> {
  const agents = await scope.repo.listAgents(scope.sourceGuildId);
  return new Set(agents.filter((row) => !row.archived_at).map((row) => String(row.id)));
}

export async function loadMemoryBase(scope: EditScope, agent: Record<string, unknown>): Promise<EditBase> {
  const agentId = String(agent.id);
  if (agent.archived_at) {
    throw new StudioUnprocessableError("archived agents cannot be edited");
  }
  const row = await scope.artifacts.getMemoryRow(operator(scope, { agentId }), agentId);
  return {
    kind: "memory",
    agentId,
    agentName: String(agent.name),
    guildId: scope.sourceGuildId,
    version: Number(row?.version ?? 0),
    content: row?.content_text ?? "",
  };
}

export async function loadNoteBase(scope: EditScope, displayPath: string): Promise<EditBase> {
  let parsed;
  try {
    parsed = parseDisplayPath(displayPath);
  } catch (error) {
    artifactFailure(error);
  }
  if (parsed.orgId !== scope.orgId) {
    throw new StudioUnprocessableError("artifact is not in this organisation");
  }
  if (parsed.kind !== "artifact") {
    throw new StudioUnprocessableError("only notes can be edited here; records and memory revisions are not notes");
  }
  if (parsed.level === "agent" && !(await sourceAgentIds(scope)).has(parsed.ownerId)) {
    throw new StudioUnprocessableError("artifact is not in the source guild");
  }
  if (parsed.level === "guild" && parsed.ownerId !== scope.sourceGuildId) {
    throw new StudioUnprocessableError("artifact is not in the source guild");
  }
  let loaded;
  try {
    loaded = await scope.artifacts.getByDisplayPath(operator(scope), displayPath);
  } catch (error) {
    artifactFailure(error);
  }
  const row = loaded.row;
  if (!row || loaded.tombstone) {
    throw new StudioUnprocessableError("artifact not found");
  }
  if (row.kind === "memory") {
    throw new StudioUnprocessableError("memory is edited with studio_edit_memory");
  }
  if (row.kind !== "note") {
    throw new StudioUnprocessableError(`${row.kind} artifacts cannot be edited here; only notes`);
  }
  return {
    kind: "note",
    displayPath: `${ownerPrefix(row.org_id, row.level, row.owner_id)}${row.key}`,
    level: row.level,
    ownerId: row.owner_id,
    title: row.title,
    guildId: String(row.guild_id ?? scope.sourceGuildId),
    version: Number(row.version),
    content: row.content_text ?? "",
  };
}

export async function loadGuildBase(scope: EditScope): Promise<EditBase> {
  const guild = await scope.repo.getGuild(scope.sourceGuildId);
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

function assertContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
    throw new StudioUnprocessableError("content exceeds the 256 KiB artifact write limit");
  }
}

// The complete replacement a tool call asks for, validated against its base.
export function proposedFor(base: EditBase, args: Record<string, unknown>): string | GuildText {
  if (base.kind === "guild") {
    const hasAbout = typeof args.about === "string";
    const hasDescription = typeof args.description === "string";
    if (!hasAbout && !hasDescription) {
      throw new StudioUnprocessableError("studio_edit_guild requires about, description, or both");
    }
    try {
      return {
        about: hasAbout ? validateAbout(String(args.about)) : base.text.about,
        description: hasDescription ? validateGuildDescription(String(args.description)) : base.text.description,
      };
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

function requireReason(args: Record<string, unknown>): string {
  const reason = argString(args, "reason").trim();
  if (!reason) {
    throw new StudioUnprocessableError("reason is required");
  }
  return reason;
}

function awaitOperator(title: string, reason: string, edit: Record<string, unknown>): Record<string, unknown> {
  return {
    widget: STUDIO_EDIT_WIDGET,
    await_operator: true,
    status: "awaiting_operator",
    title,
    reason,
    edit,
    hint: "Nothing is written yet. The operator applies or declines this edit; their reply says which.",
  };
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
  scope: EditScope,
  tool: StudioTableTool,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reason = requireReason(args);
  const review = await reviewTable(scope, tool, args, null);
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

type NotePlan =
  | {
      action: "create";
      level: "agent" | "guild" | "org";
      key: string;
      title: string | null;
      content: string;
      agentId: string | null;
    }
  | { action: "delete"; displayPath: string; guildId: string; agentId: string | null };

/**
 * A note proposed into or out of existence, checked against the live files: the
 * note before and after, what applying does, the hashes that bind it, and the write.
 */
type NoteReview = {
  action: "create" | "delete";
  title: string;
  target: Record<string, unknown>;
  baseVersion: number | null;
  baseHash: string;
  proposedHash: string;
  live: string;
  proposed: string;
  effects: string[];
  plan: NotePlan;
};

function names(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => String(row.name)).join(", ");
}

/** A note at a display path, or null when none is live there. */
async function liveNoteAt(scope: EditScope, displayPath: string): Promise<{ version: number } | null> {
  try {
    const loaded = await scope.artifacts.getByDisplayPath(operator(scope), displayPath);
    return loaded.row && !loaded.tombstone ? { version: Number(loaded.row.version) } : null;
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) return null;
    artifactFailure(error);
  }
}

async function reviewNoteCreate(
  scope: EditScope,
  args: Record<string, unknown>,
  agentId: string | null,
): Promise<NoteReview> {
  const level = argString(args, "level");
  if (level !== "agent" && level !== "guild" && level !== "org") {
    throw new StudioUnprocessableError("level must be agent, guild, or org");
  }
  let key: string;
  try {
    key = normalizeNoteKey(argString(args, "key"));
    assertNoteKeyFree(level, key);
  } catch (error) {
    artifactFailure(error);
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) {
    throw new StudioUnprocessableError("content is required: the complete note body");
  }
  assertContent(content);
  const title = argString(args, "title").trim() || null;
  let ownerId: string;
  let reader: string;
  if (level === "agent") {
    const agents = (await scope.repo.listAgents(scope.sourceGuildId)).filter((row) => !row.archived_at);
    const agent = agents.find((row) => String(row.id) === agentId);
    if (!agent) {
      throw new StudioUnprocessableError("an agent note needs agent_id: a live agent of the source guild");
    }
    ownerId = String(agent.id);
    reader = `Only ${agent.name} reads it.`;
  } else if (level === "guild") {
    const guild = await scope.repo.getGuild(scope.sourceGuildId);
    ownerId = scope.sourceGuildId;
    reader = `Every agent of ${guild?.name ?? "the guild"} that reads guild notes reaches it.`;
  } else {
    ownerId = scope.orgId;
    reader = "Every agent in the organisation that reads organisation notes reaches it.";
  }
  const displayPath = `${ownerPrefix(scope.orgId, level, ownerId)}${key}`;
  const live = await liveNoteAt(scope, displayPath);
  if (live) {
    throw new StudioConflictError(`a note already exists at ${displayPath}; change it with studio_edit_artifact`);
  }
  return {
    action: "create",
    title: `Create ${title || key}`,
    target: { display_path: displayPath, title, level, ...(level === "agent" ? { agent_id: ownerId } : {}) },
    baseVersion: null,
    baseHash: createHash("sha256").update(JSON.stringify(["absent", displayPath]), "utf8").digest("hex"),
    proposedHash: createHash("sha256").update(JSON.stringify([title, hashArtifactContent(content)]), "utf8").digest("hex"),
    live: "",
    proposed: content,
    effects: [
      `Creates ${displayPath}. ${reader}`,
      "An agent reads it once its Task embeds it or names it for note_get.",
    ],
    plan: { action: "create", level, key, title, content, agentId: level === "agent" ? ownerId : null },
  };
}

async function reviewNoteDelete(scope: EditScope, displayPath: string): Promise<NoteReview> {
  const base = await loadNoteBase(scope, displayPath);
  if (base.kind !== "note") {
    throw new StudioUnprocessableError("only notes can be deleted here");
  }
  const members = (await scope.repo.listAgents(scope.sourceGuildId)).filter((row) => !row.archived_at);
  const embedding = members.filter((row) => String(row.task ?? "").includes(`![[${base.displayPath}]]`));
  const naming = members.filter(
    (row) => !embedding.includes(row) && String(row.task ?? "").includes(base.displayPath),
  );
  const effects = [`Deletes ${base.displayPath} from Files; its change history stays.`];
  if (embedding.length) {
    effects.push(`${names(embedding)} embed it in their Task; applying fails until no Task embeds it.`);
  }
  if (naming.length) {
    effects.push(`${names(naming)} name it in their Task and can no longer read it.`);
  }
  return {
    action: "delete",
    title: `Delete ${base.title || base.displayPath.split("/").pop() || "note"}`,
    target: { display_path: base.displayPath, title: base.title, level: base.level },
    baseVersion: base.version,
    baseHash: hashArtifactContent(base.content),
    proposedHash: createHash("sha256").update(JSON.stringify(["delete", base.displayPath]), "utf8").digest("hex"),
    live: base.content,
    proposed: "",
    effects,
    plan: {
      action: "delete",
      displayPath: base.displayPath,
      guildId: base.guildId,
      agentId: base.level === "agent" ? base.ownerId : null,
    },
  };
}

/**
 * Checks a note create or delete. A request (`recorded` null) carries the coach's
 * arguments, with the agent its handle named; a review finds the note by the
 * target its request recorded.
 */
async function reviewNote(
  scope: EditScope,
  tool: StudioNoteTool,
  args: Record<string, unknown>,
  recorded: Record<string, unknown> | null,
  agentId: string | null = null,
): Promise<NoteReview> {
  if (tool === "studio_create_note") {
    return reviewNoteCreate(scope, args, recorded ? String(recorded.agent_id ?? "") || null : agentId);
  }
  return reviewNoteDelete(scope, recorded ? String(recorded.display_path ?? "") : argString(args, "display_path"));
}

async function applyNote(scope: EditScope, plan: NotePlan): Promise<number | null> {
  const toolActor = operator(scope, {
    ...(plan.action === "delete" ? { guildId: plan.guildId } : {}),
    ...(plan.agentId ? { agentId: plan.agentId } : {}),
  });
  try {
    if (plan.action === "create") {
      const row = await scope.artifacts.writeNote(toolActor, {
        level: plan.level,
        key: plan.key,
        content: plan.content,
        ...(plan.title ? { title: plan.title } : {}),
        // No live note has version 0, so a note written meanwhile is a conflict, not overwritten.
        expectedVersion: 0,
      });
      return row.version;
    }
    await scope.artifacts.deleteByDisplayPath(toolActor, plan.displayPath);
    return null;
  } catch (error) {
    artifactFailure(error);
  }
}

// A note tool's widget: the note it creates or deletes, and what applying does.
export async function noteEditRequest(
  scope: EditScope,
  tool: StudioNoteTool,
  args: Record<string, unknown>,
  agentId: string | null,
): Promise<Record<string, unknown>> {
  const reason = requireReason(args);
  const review = await reviewNote(scope, tool, args, null, agentId);
  const expected = typeof args.base_version === "number" ? args.base_version : null;
  if (review.action === "delete") {
    if (expected === null) {
      throw new StudioUnprocessableError("base_version is required: the note version studio_get_artifact returned");
    }
    if (expected !== review.baseVersion) {
      throw new StudioConflictError(
        `base_version ${expected} is stale; the live version is ${review.baseVersion}. Read it again and rebuild the request.`,
      );
    }
  }
  return awaitOperator(review.title, reason, {
    kind: "note",
    action: review.action,
    target: review.target,
    ...(review.baseVersion !== null ? { base_version: review.baseVersion } : {}),
    base_hash: review.baseHash,
    proposed_hash: review.proposedHash,
    lines: lineDelta(review.live, review.proposed),
    effects: review.effects,
  });
}

// An access tool's widget: the agent's access before and after, and what applying does.
export async function accessEditRequest(
  scope: EditScope,
  agentId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reason = requireReason(args);
  const review = await reviewAccess(scope, agentId, args, true);
  return awaitOperator(review.title, reason, {
    kind: "access",
    target: review.target,
    base_hash: review.baseHash,
    proposed_hash: review.proposedHash,
    lines: lineDelta(review.live, review.proposed),
    effects: review.effects,
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
  metadata: Record<string, unknown>;
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

export function findEditRecord(messages: Array<Record<string, unknown>>, seq: number): EditRecord {
  const message = messages.find((row) => Number(row.seq) === seq);
  const payload = (jsonObj(message?.payload) as Record<string, unknown> | null) ?? {};
  const widget = payload.role === "tool" ? parseJsonObject(payload.content) : null;
  if (!message || !widget || widget.widget !== STUDIO_EDIT_WIDGET) {
    throw new StudioError(404, "edit request not found");
  }
  const toolCallId = String(payload.tool_call_id ?? "");
  for (const row of messages) {
    const assistant = (jsonObj(row.payload) as Record<string, unknown> | null) ?? {};
    if (assistant.role !== "assistant" || !Array.isArray(assistant.tool_calls)) continue;
    for (const call of assistant.tool_calls as Array<Record<string, unknown>>) {
      if (String(call.id ?? "") !== toolCallId) continue;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      const name = String(fn.name ?? "");
      const args = parseJsonObject(fn.arguments);
      if (!args || !(STUDIO_EDIT_TOOLS as readonly string[]).includes(name)) break;
      return {
        seq,
        toolName: name as StudioEditTool,
        toolCallId,
        widget,
        args,
        metadata: (jsonObj(message.metadata) as Record<string, unknown> | null) ?? {},
      };
    }
  }
  throw new StudioError(404, "edit request not found");
}

export function editStatus(record: EditRecord): StudioEditStatus {
  const status = record.metadata.edit_status;
  return status === "applied" || status === "declined" ? status : "pending";
}

async function loadBaseFor(scope: EditScope, record: EditRecord): Promise<EditBase> {
  const edit = (record.widget.edit ?? {}) as Record<string, unknown>;
  const target = (edit.target ?? {}) as Record<string, unknown>;
  if (record.toolName === "studio_edit_memory") {
    const agent = await scope.repo.getAgent(String(target.agent_id ?? ""));
    if (!agent || String(agent.guild_id) !== scope.sourceGuildId) {
      throw new StudioUnprocessableError("agent is not in the source guild");
    }
    return loadMemoryBase(scope, agent);
  }
  if (record.toolName === "studio_edit_artifact") {
    return loadNoteBase(scope, String(target.display_path ?? ""));
  }
  if (record.toolName === "studio_edit_guild") {
    return loadGuildBase(scope);
  }
  throw new StudioError(404, "edit request not found");
}

function liveContent(base: EditBase): string | GuildText {
  return base.kind === "guild" ? base.text : base.content;
}

// What the operator reviews: the live content, the proposal, and whether the
// live content still matches the base the proposal was built on.
export async function viewEdit(scope: EditScope, record: EditRecord): Promise<Record<string, unknown>> {
  const edit = (record.widget.edit ?? {}) as Record<string, unknown>;
  const status = editStatus(record);
  if (isTableTool(record.toolName)) {
    const tool = record.toolName;
    return viewReviewedEdit(record, edit, status, () =>
      reviewTable(scope, tool, record.args, (edit.target ?? {}) as Record<string, unknown>),
    );
  }
  if (isNoteTool(record.toolName)) {
    const tool = record.toolName;
    return viewReviewedEdit(record, edit, status, () =>
      reviewNote(scope, tool, record.args, (edit.target ?? {}) as Record<string, unknown>),
    );
  }
  if (isAccessTool(record.toolName)) {
    return viewReviewedEdit(record, edit, status, () =>
      reviewAccess(scope, recordedAgentId(edit), record.args, false),
    );
  }
  let live: EditBase | null = null;
  let error: string | null = null;
  try {
    live = await loadBaseFor(scope, record);
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

// A table, note create or delete, or access edit rendered as text on both
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

// Write the proposal as the operator. The live content must still hash to
// the base the proposal was built on; anything else is a conflict.
export async function applyEdit(
  scope: EditScope,
  record: EditRecord,
): Promise<{ version: number | null; guild?: Record<string, unknown> }> {
  const edit = (record.widget.edit ?? {}) as Record<string, unknown>;
  if (isTableTool(record.toolName)) {
    const review = await reviewTable(scope, record.toolName, record.args, (edit.target ?? {}) as Record<string, unknown>);
    assertBound(review, edit, "table");
    await applyTable(scope, review.plan);
    return { version: null };
  }
  if (isNoteTool(record.toolName)) {
    const review = await reviewNote(scope, record.toolName, record.args, (edit.target ?? {}) as Record<string, unknown>);
    assertBound(review, edit, "note");
    return { version: await applyNote(scope, review.plan) };
  }
  if (isAccessTool(record.toolName)) {
    const agentId = recordedAgentId(edit);
    const review = await reviewAccess(scope, agentId, record.args, false);
    assertBound(review, edit, "access");
    await applyAccess(scope, agentId, review);
    return { version: null };
  }
  const base = await loadBaseFor(scope, record);
  if (baseHash(base) !== String(edit.base_hash ?? "")) {
    throw new StudioConflictError("the live content changed since this edit was proposed");
  }
  const proposed = proposedFor(base, record.args);
  if (proposedHash(proposed) !== String(edit.proposed_hash ?? "")) {
    throw new StudioConflictError("the proposal no longer matches its request");
  }
  const toolCall = { id: record.toolCallId, name: record.toolName };
  if (base.kind === "memory") {
    const actor = { ...operator(scope, { agentId: base.agentId }), toolCall };
    try {
      const row = await scope.artifacts.writeMemory(
        actor,
        base.agentId,
        proposed as string,
        record.toolName,
        base.version > 0 ? base.version : undefined,
      );
      return { version: row.version };
    } catch (error) {
      artifactFailure(error);
    }
  }
  if (base.kind === "note") {
    const parsed = parseDisplayPath(base.displayPath);
    if (parsed.kind !== "artifact" || parsed.path) {
      throw new StudioUnprocessableError("artifact not found");
    }
    const actor = {
      ...operator(scope, {
        guildId: base.guildId,
        ...(base.level === "agent" ? { agentId: base.ownerId } : {}),
      }),
      toolCall,
    };
    try {
      const row = await scope.artifacts.writeNote(actor, {
        level: base.level,
        key: parsed.key,
        content: proposed as string,
        ...(base.title ? { title: base.title } : {}),
        expectedVersion: base.version,
      });
      return { version: row.version };
    } catch (error) {
      artifactFailure(error);
    }
  }
  const text = proposed as GuildText;
  const row = await scope.repo.updateGuild(base.guildId, new Date(), {
    about: text.about,
    description: text.description,
  });
  if (!row) {
    throw new StudioUnprocessableError("source guild not found");
  }
  return { version: null, guild: row };
}

export async function markEdit(
  store: StudioStore,
  sessionId: string,
  record: EditRecord,
  status: Exclude<StudioEditStatus, "pending">,
  version: number | null,
): Promise<void> {
  const message = await store.getMessage(sessionId, record.seq);
  if (!message) return;
  await store.updateMessage(
    sessionId,
    record.seq,
    (jsonObj(message.payload) as Record<string, unknown>) ?? {},
    {
      ...record.metadata,
      edit_status: status,
      edit_resolved_at: new Date().toISOString(),
      ...(status === "applied" ? { edit_version: version } : {}),
    },
  );
}
