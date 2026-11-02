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
import type { AccessGrant } from "../artifacts/types.js";
import { listAgents, type GuildAgentRow } from "../db/agents.js";
import { getGuild } from "../db/guilds.js";
import { editActor } from "./actor.js";
import type { EditNoteArguments } from "./edit-arguments.js";
import {
  assertContent,
  awaitOperator,
  lineDelta,
  requireReason,
  type NoteLifecycleTarget,
  type StudioEditWidget,
} from "./edit-request.js";
import type { EditBase, EditDeps, EditScope } from "./edits.js";
import { StudioConflictError, StudioUnprocessableError, artifactRefusal } from "./errors.js";
import { studioReachesParsed } from "./reach.js";

// One tool creates, edits, or deletes a note. An edit replaces an existing
// note's body like a Memory edit; a create or delete is reviewed as a plan.
export const STUDIO_NOTE_TOOL = "studio_edit_note";
export type NoteAction = "create" | "delete";

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
    if (!(await studioReachesParsed(deps, scope, parsed))) {
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
      title: row.title,
      guildId: scope.sourceGuildId,
      version: row.version,
      content: row.content_text ?? "",
    };
  } catch (error) {
    throw artifactRefusal(error);
  }
}

type NotePlan =
  | {
      action: "create";
      key: string;
      title: string | null;
      content: string;
      startingAccess: AccessGrant[];
    }
  | { action: "delete"; displayPath: string; guildId: string };

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

function names(rows: Array<Pick<GuildAgentRow, "name">>): string {
  return rows.map((row) => row.name).join(", ");
}

/** A note at a display path, or null when none is live there. */
async function liveNoteAt(
  deps: EditDeps,
  scope: EditScope,
  displayPath: string,
): Promise<{ version: number } | null> {
  try {
    const view = await artifactAt(deps.artifacts, editActor(scope), displayPath);
    return view.kind === "row" && !view.deleted ? { version: view.row.version } : null;
  } catch (error) {
    if (error instanceof ArtifactError && error.status === 404) return null;
    throw artifactRefusal(error);
  }
}

async function reviewNoteCreate(
  deps: EditDeps,
  scope: EditScope,
  args: EditNoteArguments,
  agentId: string | null,
): Promise<NoteReview> {
  const { content = "" } = args;
  const title = (args.title ?? "").trim() || null;
  let planned: PlannedNote;
  try {
    planned = planNote(scope.orgId, { key: args.key ?? "", content, ...(title ? { title } : {}) });
  } catch (error) {
    throw artifactRefusal(error);
  }
  if (!content.trim()) {
    throw new StudioUnprocessableError("content is required: the complete note body");
  }
  assertContent(content);
  let reader: string;
  let startingAccess: AccessGrant[];
  if (agentId !== null) {
    const agents = await listAgents(deps.db, scope.sourceGuildId);
    const agent = agents.find((row) => row.id === agentId);
    if (!agent) {
      throw new StudioUnprocessableError("agent_id must name a live agent of the source guild");
    }
    reader = `Only ${agent.name} reads and writes it.`;
    startingAccess = [{ type: "agent", id: agent.id, mode: "write" }];
  } else {
    const guild = await getGuild(deps.db, scope.sourceGuildId);
    reader = `Every agent of ${guild?.name ?? "the guild"} reads and writes it.`;
    startingAccess = [{ type: "guild", id: scope.sourceGuildId, mode: "write" }];
  }
  const { href: displayPath, key } = planned;
  const live = await liveNoteAt(deps, scope, displayPath);
  if (live) {
    throw new StudioConflictError(`a note already exists at ${displayPath}; change it with studio_edit_note action edit`);
  }
  return {
    action: "create",
    title: `Create ${title || key}`,
    target: { display_path: displayPath, title, ...(agentId !== null ? { agent_id: agentId } : {}) },
    baseVersion: null,
    baseHash: createHash("sha256").update(JSON.stringify(["absent", displayPath]), "utf8").digest("hex"),
    proposedHash: planned.hash,
    live: "",
    proposed: content,
    effects: [
      `Creates ${displayPath}. ${reader}`,
      "An agent reads it once its Task embeds it or names it for note_get.",
    ],
    plan: { action: "create", key, title, content, startingAccess },
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
  const embedding = members.filter((row) => row.task.includes(`![[${base.displayPath}]]`));
  const naming = members.filter(
    (row) => !embedding.includes(row) && row.task.includes(base.displayPath),
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
    target: { display_path: base.displayPath, title: base.title },
    baseVersion: base.version,
    baseHash: hashArtifactContent(base.content),
    proposedHash: createHash("sha256").update(JSON.stringify(["delete", base.displayPath]), "utf8").digest("hex"),
    live: base.content,
    proposed: "",
    effects,
    plan: { action: "delete", displayPath: base.displayPath, guildId: base.guildId },
  };
}

/** Checks a requested note create or delete again, finding the note by the target its request recorded. */
export async function reviewRecordedNote(
  deps: EditDeps,
  scope: EditScope,
  action: NoteAction,
  args: EditNoteArguments,
  recorded: NoteLifecycleTarget,
): Promise<NoteReview> {
  if (action === "create") {
    return reviewNoteCreate(deps, scope, args, recorded.agent_id || null);
  }
  return reviewNoteDelete(deps, scope, recorded.display_path);
}

export async function applyNote(deps: EditDeps, scope: EditScope, plan: NotePlan): Promise<number | null> {
  const toolActor = editActor(scope, plan.action === "delete" ? { guildId: plan.guildId } : {});
  try {
    if (plan.action === "create") {
      const written = await writeNote(deps.artifacts, toolActor, {
        startingAccess: plan.startingAccess,
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
    throw artifactRefusal(error);
  }
}

// A note create widget: the note it creates for the agent its handle named, and what applying does.
export async function noteCreateRequest(
  deps: EditDeps,
  scope: EditScope,
  args: EditNoteArguments,
  agentId: string | null,
): Promise<StudioEditWidget> {
  const reason = requireReason(args.reason);
  return noteWidget(await reviewNoteCreate(deps, scope, args, agentId), reason);
}

// A note delete widget: the note at `display_path`, at the version the coach read, and what applying does.
export async function noteDeleteRequest(
  deps: EditDeps,
  scope: EditScope,
  args: EditNoteArguments,
): Promise<StudioEditWidget> {
  const reason = requireReason(args.reason);
  const review = await reviewNoteDelete(deps, scope, args.display_path ?? "");
  const expected = args.base_version;
  if (expected === undefined) {
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
