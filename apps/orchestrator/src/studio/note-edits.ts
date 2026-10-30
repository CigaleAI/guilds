// Note edits: the note a body edit replaces, and a note proposed into or out of existence, from the
// coach's request to the operator's apply.

import { createHash } from "node:crypto";
import { ArtifactError } from "../artifacts/errors.js";
import {
  artifactAt,
  deleteByDisplayPath,
  parseActorPath,
  type PlannedNote,
  planNote,
  writeNote,
} from "../artifacts/notes.js";
import { hashArtifactContent } from "../artifacts/store.js";
import { listAgents } from "../db/agents.js";
import { getGuild } from "../db/guilds.js";
import { argString } from "../toolbox/schema.js";
import { editActor } from "./actor.js";
import {
  assertContent,
  awaitOperator,
  lineDelta,
  requireReason,
  type NoteLifecycleTarget,
  type StudioEditWidget,
} from "./edit-request.js";
import type { EditBase, EditDeps, EditScope } from "./edits.js";
import { StudioConflictError, StudioUnprocessableError, artifactFailure } from "./errors.js";

// One tool creates, edits, or deletes a note. An edit replaces an existing
// note's body like a Memory edit; a create or delete is reviewed as a plan.
export const STUDIO_NOTE_TOOL = "studio_edit_note";
export type NoteAction = "create" | "delete";

async function sourceAgentIds(deps: EditDeps, scope: EditScope): Promise<Set<string>> {
  const agents = await listAgents(deps.db, scope.sourceGuildId);
  return new Set(agents.map((row) => String(row.id)));
}

export async function loadNoteBase(
  deps: EditDeps,
  scope: EditScope,
  displayPath: string,
): Promise<EditBase> {
  const actor = editActor(scope);
  try {
    const parsed = parseActorPath(actor, displayPath);
    if (parsed.kind !== "artifact") {
      throw new StudioUnprocessableError("only notes can be edited here; records and memory revisions are not notes");
    }
    if (parsed.level === "agent" && !(await sourceAgentIds(deps, scope)).has(parsed.ownerId)) {
      throw new StudioUnprocessableError("artifact is not in the source guild");
    }
    if (parsed.level === "guild" && parsed.ownerId !== scope.sourceGuildId) {
      throw new StudioUnprocessableError("artifact is not in the source guild");
    }
    const view = await artifactAt(deps.artifacts, actor, displayPath);
    if (view.kind !== "row" || view.deleted) {
      throw new StudioUnprocessableError("artifact not found");
    }
    const row = view.row;
    if (row.kind === "memory") {
      throw new StudioUnprocessableError("memory is edited with studio_edit_memory");
    }
    if (row.kind !== "note") {
      throw new StudioUnprocessableError(`${row.kind} artifacts cannot be edited here; only notes`);
    }
    return {
      kind: "note",
      displayPath: view.href,
      level: row.level,
      ownerId: row.owner_id,
      title: row.title,
      guildId: String(row.guild_id ?? scope.sourceGuildId),
      version: Number(row.version),
      content: row.content_text ?? "",
    };
  } catch (error) {
    artifactFailure(error);
  }
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
  target: NoteLifecycleTarget;
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
async function liveNoteAt(
  deps: EditDeps,
  scope: EditScope,
  displayPath: string,
): Promise<{ version: number } | null> {
  try {
    const view = await artifactAt(deps.artifacts, editActor(scope), displayPath);
    return view.kind === "row" && !view.deleted ? { version: Number(view.row.version) } : null;
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) return null;
    artifactFailure(error);
  }
}

async function reviewNoteCreate(
  deps: EditDeps,
  scope: EditScope,
  args: Record<string, unknown>,
  agentId: string | null,
): Promise<NoteReview> {
  const level = argString(args, "level");
  if (level !== "agent" && level !== "guild" && level !== "org") {
    throw new StudioUnprocessableError("level must be agent, guild, or org");
  }
  const content = typeof args.content === "string" ? args.content : "";
  const title = argString(args, "title").trim() || null;
  // An agent note's owner is the agent the handle names; whether that agent is in the guild is checked below.
  const ownerId = { agent: agentId ?? "", guild: scope.sourceGuildId, org: scope.orgId }[level];
  let planned: PlannedNote;
  try {
    planned = planNote({ orgId: scope.orgId, ownerId }, { level, key: argString(args, "key"), content, ...(title ? { title } : {}) });
  } catch (error) {
    artifactFailure(error);
  }
  if (!content.trim()) {
    throw new StudioUnprocessableError("content is required: the complete note body");
  }
  assertContent(content);
  let reader: string;
  if (level === "agent") {
    const agents = await listAgents(deps.db, scope.sourceGuildId);
    const agent = agents.find((row) => String(row.id) === agentId);
    if (!agent) {
      throw new StudioUnprocessableError("an agent note needs agent_id: a live agent of the source guild");
    }
    reader = `Only ${agent.name} reads it.`;
  } else if (level === "guild") {
    const guild = await getGuild(deps.db, scope.sourceGuildId);
    reader = `Every agent of ${guild?.name ?? "the guild"} that reads guild notes reaches it.`;
  } else {
    reader = "Every agent in the organisation that reads organisation notes reaches it.";
  }
  const { href: displayPath, key } = planned;
  const live = await liveNoteAt(deps, scope, displayPath);
  if (live) {
    throw new StudioConflictError(`a note already exists at ${displayPath}; change it with studio_edit_note action edit`);
  }
  return {
    action: "create",
    title: `Create ${title || key}`,
    target: { display_path: displayPath, title, level, ...(level === "agent" ? { agent_id: ownerId } : {}) },
    baseVersion: null,
    baseHash: createHash("sha256").update(JSON.stringify(["absent", displayPath]), "utf8").digest("hex"),
    proposedHash: planned.hash,
    live: "",
    proposed: content,
    effects: [
      `Creates ${displayPath}. ${reader}`,
      "An agent reads it once its Task embeds it or names it for note_get.",
    ],
    plan: { action: "create", level, key, title, content, agentId: level === "agent" ? ownerId : null },
  };
}

async function reviewNoteDelete(
  deps: EditDeps,
  scope: EditScope,
  displayPath: string,
): Promise<NoteReview> {
  const base = await loadNoteBase(deps, scope, displayPath);
  if (base.kind !== "note") {
    throw new StudioUnprocessableError("only notes can be deleted here");
  }
  const members = await listAgents(deps.db, scope.sourceGuildId);
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

/** Checks a requested note create or delete again, finding the note by the target its request recorded. */
export async function reviewRecordedNote(
  deps: EditDeps,
  scope: EditScope,
  action: NoteAction,
  args: Record<string, unknown>,
  recorded: NoteLifecycleTarget,
): Promise<NoteReview> {
  if (action === "create") {
    return reviewNoteCreate(deps, scope, args, recorded.agent_id || null);
  }
  return reviewNoteDelete(deps, scope, recorded.display_path);
}

export async function applyNote(deps: EditDeps, scope: EditScope, plan: NotePlan): Promise<number | null> {
  const toolActor = editActor(scope, {
    ...(plan.action === "delete" ? { guildId: plan.guildId } : {}),
    ...(plan.agentId ? { agentId: plan.agentId } : {}),
  });
  try {
    if (plan.action === "create") {
      const written = await writeNote(deps.artifacts, toolActor, {
        level: plan.level,
        key: plan.key,
        content: plan.content,
        ...(plan.title ? { title: plan.title } : {}),
        // No live note has version 0, so a note written meanwhile is a conflict, not overwritten.
        expectedVersion: 0,
      });
      return written.row.version;
    }
    await deleteByDisplayPath(deps.artifacts, toolActor, plan.displayPath);
    return null;
  } catch (error) {
    artifactFailure(error);
  }
}

// A note create widget: the note it creates for the agent its handle named, and what applying does.
export async function noteCreateRequest(
  deps: EditDeps,
  scope: EditScope,
  args: Record<string, unknown>,
  agentId: string | null,
): Promise<StudioEditWidget> {
  const reason = requireReason(args);
  return noteWidget(await reviewNoteCreate(deps, scope, args, agentId), reason);
}

// A note delete widget: the note at `display_path`, at the version the coach read, and what applying does.
export async function noteDeleteRequest(
  deps: EditDeps,
  scope: EditScope,
  args: Record<string, unknown>,
): Promise<StudioEditWidget> {
  const reason = requireReason(args);
  const review = await reviewNoteDelete(deps, scope, argString(args, "display_path"));
  const expected = typeof args.base_version === "number" ? args.base_version : null;
  if (expected === null) {
    throw new StudioUnprocessableError("base_version is required: the note version studio_get_artifact returned");
  }
  if (expected !== review.baseVersion) {
    throw new StudioConflictError(
      `base_version ${expected} is stale; the live version is ${review.baseVersion}. Read it again and rebuild the request.`,
    );
  }
  return noteWidget(review, reason);
}

function noteWidget(review: NoteReview, reason: string): StudioEditWidget {
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
