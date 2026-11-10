import { collectTaskEmbeds } from "../artifacts/embeds.js";
import { ArtifactError } from "../artifacts/errors.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { operatorActor } from "../artifacts/actors.js";
import { agentTask, expandTaskText, publishAgentTask, taskDisplayPath } from "../artifacts/task.js";
import { WRITE_MAX_BYTES } from "../artifacts/types.js";
import { newId } from "../lib/ids.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import { countInputTokens } from "../llm/tokens.js";
import { instructionHash } from "../schedules/item.js";
import { capBytes } from "../lib/bytes.js";
import {
  STUDIO_EVIDENCE_EXCERPT_BYTES,
  STUDIO_EVIDENCE_REF_MAX,
  STUDIO_LARGE_DELETION_RATIO,
} from "./constants.js";
import { StudioConflictError, StudioNotFoundError, StudioUnprocessableError } from "./errors.js";
import { previewCurrentState, projectOfferedToolSchemas, type PreviewDeps } from "./preview.js";
import { withLockedSession } from "./session-lock.js";
import type { StudioToolCall } from "./tools.js";
import { resolveSourceGuildAgent, sourceGuildAgents } from "./source-guild.js";
import type { CreateTaskDraftArguments } from "./task-tools.js";
import { excerptBytes } from "./system.js";
import { getAgent, getAgentTask, listAgents, type AgentRow } from "../db/agents.js";
import { nextConversationSeq } from "../db/conversations.js";
import type { Queryable } from "../db/pg.js";
import {
  getStudioDraft,
  getStudioSession,
  insertStudioDraft,
  listOrphanStudioDrafts,
  listStudioDraftHeads,
  listStudioDrafts,
  lockStudioDraft,
  updateStudioDraft,
  type StudioDraftRow,
  type StudioSessionRow,
} from "../db/studio.js";
import { listConversationMessages, type ConversationMessageRow } from "../db/conversations.js";
import {
  EVIDENCE_REF_KINDS,
  EvidenceCoordinates,
  type EvidenceCitation,
  type EvidenceRef,
  type EvidenceRefKind,
  type EvidenceWarning,
} from "../db/schema/index.js";
import type { UserRow } from "../db/users.js";
import { Type } from "typebox";
import { keepMatching } from "../lib/decode.js";
import { isObjectNode, type JsonObject, type JsonValue } from "../lib/json.js";

export type StudioDraftService = {
  createFromTool(db: Queryable, call: StudioToolCall, args: CreateTaskDraftArguments): Promise<StudioDraftWidget>;
};

/** What a draft's preflight and publish read through: its agent in `db`, the agent's offer from `preview`, the standing notes at `notesSystemPath`. */
export type DraftPublishDeps = {
  db: Queryable;
  preview: PreviewDeps;
  notesSystemPath: string;
};

// A draft is decided like an edit: the tool returns this widget and the turn
// pauses until the operator publishes or discards it.
export const STUDIO_TASK_DRAFT_WIDGET = "studio_task_draft";

/** A draft as the operator app reads it: the row, with whether its evidence checked out and how much it changes. */
export type StudioDraft = Pick<
  StudioDraftRow,
  | "id"
  | "session_id"
  | "resource_kind"
  | "target_agent_id"
  | "target_snapshot"
  | "source_display_path"
  | "base_version"
  | "base_hash"
  | "base_content"
  | "proposed_content"
  | "rationale"
  | "evidence_refs"
  | "evidence_warnings"
  | "risks"
  | "status"
  | "draft_number"
  | "supersedes_draft_id"
  | "created_generation"
  | "created_message_seq"
  | "created_at"
  | "published_resource_version"
> & { verified_evidence: boolean; size_delta_bytes: number; large_deletion: boolean };

/** The Task draft the coach wrote, which the turn pauses on until the operator publishes or discards it. */
export type StudioDraftWidget = {
  widget: typeof STUDIO_TASK_DRAFT_WIDGET;
  await_operator: true;
  agent: { id: string; name: string };
  draft_id: string;
  rationale: string;
  draft: StudioDraft;
  evidence_warnings: EvidenceWarning[];
  verified_evidence: boolean;
};

/** What a publish checks a draft against: the target agent's configuration, the catalog, and the prompt the Task composes. */
export type DraftPreflight = {
  config_hash: string;
  projected_at: string;
  catalog_revision: string | null;
  token_estimate: number;
  token_estimate_kind: "stored_catalog_projection";
  effective_hash: string;
  prior_effective_hash: string;
  has_embeds: boolean;
};

/** How a publish ended: the Task already held the draft, or the draft is its new version. */
export type DraftPublication =
  | { outcome: "unchanged"; draft: StudioDraft; preflight: DraftPreflight }
  | {
      outcome: "published";
      draft: StudioDraft;
      version: number;
      prior_effective_hash: string;
      published_effective_hash: string;
      preflight: DraftPreflight;
    };

export class StudioDrafts implements StudioDraftService {
  constructor(
    public db: Queryable,
    public artifacts: ArtifactStore,
  ) {}

  async createFromTool(
    db: Queryable,
    call: StudioToolCall,
    args: CreateTaskDraftArguments,
  ): Promise<StudioDraftWidget> {
    const handle = args.agent_id;
    const agent = await resolveSourceGuildAgent(sourceGuildAgents(db), call, handle);
    if (!agent) {
      throw new StudioUnprocessableError(await missingDraftAgentMessage(db, call, handle));
    }
    const targetId = agent.id;
    const { proposed_content: proposed, rationale } = args;
    if (!proposed.trim() || !rationale.trim()) {
      throw new StudioUnprocessableError("studio_create_task_draft requires complete proposed_content and rationale");
    }
    if (Buffer.byteLength(proposed, "utf8") > WRITE_MAX_BYTES) {
      throw new StudioUnprocessableError("proposed_content exceeds the 256 KiB artifact write limit");
    }
    const task = await getAgentTask(db, call.orgId, targetId);
    if (!task) {
      throw new StudioUnprocessableError("task.md not found");
    }
    const messages = await listConversationMessages(db, "studio", call.session.id);
    const { refs, warnings } = resolveEvidenceRefs(args.evidence_refs, messages);
    const now = new Date();
    return withLockedSession(this.db, call.session.id, async (client, session) => {
      if (session.generation_state !== "generating" && session.generation_state !== "idle") {
        throw new StudioConflictError("session cannot accept a draft");
      }
      const heads = (await listStudioDraftHeads(this.db, session.id)).filter(
        (row) => row.target_agent_id === targetId && row.status === "draft",
      );
      const previous = heads[0] ?? null;
      if (previous) {
        await updateStudioDraft(client, previous.id, { status: "superseded", resolved_at: now });
      }
      const seq = await nextConversationSeq(client, "studio", session.id);
      const draft = await insertStudioDraft(
        client,
        {
          id: newId("std"),
          session_id: session.id,
          org_id: call.orgId,
          source_guild_id: call.sourceGuildId,
          target_agent_id: targetId,
          target_snapshot: {
            id: agent.id,
            name: agent.name,
            focus: agent.focus,
          },
          source_artifact_id: null,
          source_display_path: taskDisplayPath(call.orgId, targetId),
          base_version: task.version,
          base_hash: task.content_hash,
          base_content: task.content_text ?? "",
          proposed_content: proposed,
          rationale,
          evidence_refs: refs,
          evidence_warnings: warnings,
          risks: args.risks ?? [],
          status: "draft",
          draft_number: Number(previous?.draft_number ?? 0) + 1,
          supersedes_draft_id: previous ? previous.id : null,
          created_generation: call.generation,
          created_message_seq: call.nextMessageSeq ?? seq,
        },
        now,
      );
      return {
        widget: STUDIO_TASK_DRAFT_WIDGET,
        await_operator: true,
        agent: { id: targetId, name: agent.name },
        draft_id: draft.id,
        rationale,
        draft: viewDraft(draft),
        evidence_warnings: warnings,
        verified_evidence: refs.length > 0,
      };
    });
  }

  async revise(
    session: StudioSessionRow,
    user: UserRow,
    draftId: string,
    proposed: string,
    expectedHeadId: string,
  ): Promise<StudioDraft> {
    if (Buffer.byteLength(proposed, "utf8") > WRITE_MAX_BYTES) {
      throw new StudioUnprocessableError("proposed_content exceeds the 256 KiB artifact write limit");
    }
    const now = new Date();
    return withLockedSession(this.db, session.id, async (client) => {
      const current = await lockStudioDraft(client, draftId);
      if (!current || current.session_id !== session.id) {
        throw new StudioNotFoundError("draft not found");
      }
      if (current.status !== "draft" && current.status !== "conflicted") {
        throw new StudioConflictError("draft is not editable");
      }
      if (current.id !== expectedHeadId) {
        throw new StudioConflictError("stale draft head");
      }
      await updateStudioDraft(client, current.id, { status: "superseded", resolved_at: now });
      const next = await insertStudioDraft(
        client,
        {
          ...current,
          id: newId("std"),
          proposed_content: proposed,
          status: "draft",
          draft_number: current.draft_number + 1,
          supersedes_draft_id: current.id,
          created_generation: current.created_generation,
          created_message_seq: current.created_message_seq,
        },
        now,
      );
      return viewDraft(next);
    });
  }

  async discard(
    session: StudioSessionRow,
    user: UserRow,
    draftId: string,
  ): Promise<StudioDraft> {
    const now = new Date();
    return withLockedSession(this.db, session.id, async (client) => {
      const current = await lockStudioDraft(client, draftId);
      if (!current || current.session_id !== session.id) {
        throw new StudioNotFoundError("draft not found");
      }
      if (current.status !== "draft" && current.status !== "conflicted") {
        throw new StudioConflictError("draft cannot be discarded");
      }
      const updated = await updateStudioDraft(
        client,
        current.id,
        { status: "discarded", resolved_at: now, discarded_by_user_id: user.id },
      );
      return viewDraft(updated ?? current);
    });
  }

  async publish(
    deps: DraftPublishDeps,
    session: StudioSessionRow,
    user: UserRow,
    draftId: string,
  ): Promise<DraftPublication> {
    const now = new Date();
    const preflight = await this.preflight(deps, draftId);
    return withLockedSession(this.db, session.id, async (client) => {
      const draft = await lockStudioDraft(client, draftId);
      if (!draft) {
        throw new StudioNotFoundError("draft not found");
      }
      if (draft.session_id !== session.id) {
        throw new StudioNotFoundError("draft not found");
      }
      if (draft.status !== "draft" && draft.status !== "conflicted") {
        throw new StudioConflictError("draft is not publishable");
      }
      if (!draft.target_agent_id || !draft.source_guild_id) {
        throw new StudioUnprocessableError("draft target is no longer live");
      }
      const agent = await getAgent(deps.db, draft.target_agent_id);
      if (!agent) {
        throw new StudioUnprocessableError("target is not a publishable agent");
      }
      const currentHash = JSON.stringify(agent.config);
      if (currentHash !== preflight.config_hash) {
        const again = await this.runPreflight(deps, agent, draft.proposed_content);
        Object.assign(preflight, again);
      }
      const actor = operatorActor({
        orgId: session.org_id,
        actorId: String(user.id ?? "orphan"),
        actorName: user.name,
        guildId: draft.source_guild_id,
        agentId: draft.target_agent_id,
      });
      const result = await publishAgentTask(client, actor, draft.target_agent_id, {
        content: draft.proposed_content,
        baseVersion: draft.base_version,
      });
      if (result.outcome === "missing") {
        throw new StudioUnprocessableError("task.md not found");
      }
      if (result.outcome === "conflict") {
        await updateStudioDraft(client, draft.id, { status: "conflicted", resolved_at: now });
        throw new StudioConflictError("task version conflict");
      }
      if (result.outcome === "unchanged") {
        const unchanged = await updateStudioDraft(
          client,
          draft.id,
          { status: "unchanged", resolved_at: now, published_at: now, published_by_user_id: user.id },
        );
        return { outcome: "unchanged", draft: viewDraft(unchanged ?? draft), preflight };
      }
      const written = result.task;
      const published = await updateStudioDraft(
        client,
        draft.id,
        {
          status: "published",
          resolved_at: now,
          published_at: now,
          published_by_user_id: user.id,
          published_resource_version: written.version,
        },
      );
      return {
        outcome: "published",
        draft: viewDraft(published ?? draft),
        version: written.version,
        prior_effective_hash: preflight.prior_effective_hash,
        published_effective_hash: preflight.effective_hash,
        preflight,
      };
    });
  }

  async preflight(deps: DraftPublishDeps, draftId: string): Promise<DraftPreflight> {
    const draft = await getStudioDraft(this.db, draftId);
    if (!draft || !draft.target_agent_id) {
      throw new StudioNotFoundError("draft not found");
    }
    const agent = await getAgent(deps.db, draft.target_agent_id);
    if (!agent) {
      throw new StudioUnprocessableError("target agent not found");
    }
    return this.runPreflight(deps, agent, draft.proposed_content);
  }

  private async runPreflight(
    deps: DraftPublishDeps,
    agent: AgentRow,
    proposed: string,
  ): Promise<DraftPreflight> {
    let expanded: string;
    try {
      expanded = await expandTaskText(this.artifacts, agent, proposed);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    const live = await agentTask(this.artifacts, agent);
    const standing = hydrateStanding({
      systemPath: deps.notesSystemPath,
      agentName: agent.name,
      agentId: agent.id,
    });
    const preview = await previewCurrentState(deps.preview, agent);
    const tools = await projectOfferedToolSchemas(deps.preview, agent);
    const { config } = agent;
    const memoryEnabled = config.memory;
    const composed = composeAgentSystemPrompt(
      standing,
      expanded,
      preview.state,
      live.memoryText,
      memoryEnabled,
      memoryEnabled && schemasOffer(tools.schemas, "memory_write"),
    );
    const tokens = countInputTokens(config.model, [{ role: "system", content: composed }], tools.schemas);
    if (tokens > config.max_input_tokens) {
      throw new StudioUnprocessableError("composed prompt exceeds the target agent's max_input_tokens");
    }
    const priorEffective = live.text && live.expanded.ok ? promptHash(live.expanded.text) : live.hash;
    return {
      config_hash: tools.config_hash,
      projected_at: preview.projected_at,
      catalog_revision: tools.catalog_revision,
      token_estimate: tokens,
      token_estimate_kind: "stored_catalog_projection",
      effective_hash: promptHash(expanded),
      prior_effective_hash: priorEffective,
      has_embeds: collectTaskEmbeds(proposed).length > 0,
    };
  }
}

/** A published or unchanged draft, with whether its target agent is generating now and so reads the new Task on its next run. */
export type PublishedDraft = DraftPublication & { target_generating: boolean };

/** What publishing a session's draft reads and writes through, the source guild's files channel, and whether an agent is generating. */
export type DraftAnnounceDeps = DraftPublishDeps & {
  drafts: StudioDrafts;
  publishFilesChanged?: ((guildId: string) => Promise<void>) | undefined;
  isAgentBusy?: ((agentId: string) => boolean) | undefined;
};

/**
 * Publishes a draft of the session to its target agent's Task as `user`, and tells the source guild
 * its files changed when the Task did.
 */
export async function publishDraft(
  deps: DraftAnnounceDeps,
  session: StudioSessionRow,
  user: UserRow,
  draftId: string,
): Promise<PublishedDraft> {
  const result = await deps.drafts.publish(deps, session, user, draftId);
  if (result.outcome === "published" && deps.publishFilesChanged && session.source_guild_id) {
    await deps.publishFilesChanged(session.source_guild_id);
  }
  const targetId = result.draft.target_agent_id;
  return {
    ...result,
    target_generating: targetId ? Boolean(deps.isAgentBusy?.(targetId)) : false,
  };
}

export function viewDraft(row: StudioDraftRow): StudioDraft {
  const base = row.base_content;
  const proposed = row.proposed_content;
  const baseBytes = Buffer.byteLength(base, "utf8");
  const proposedBytes = Buffer.byteLength(proposed, "utf8");
  const deleted = Math.max(0, baseBytes - proposedBytes);
  const deletionRatio = baseBytes === 0 ? 0 : deleted / baseBytes;
  const refs = row.evidence_refs;
  return {
    id: row.id,
    session_id: row.session_id,
    resource_kind: row.resource_kind,
    target_agent_id: row.target_agent_id,
    target_snapshot: row.target_snapshot,
    source_display_path: row.source_display_path,
    base_version: row.base_version,
    base_hash: row.base_hash,
    base_content: base,
    proposed_content: proposed,
    rationale: row.rationale,
    evidence_refs: refs,
    evidence_warnings: row.evidence_warnings,
    risks: row.risks,
    status: row.status,
    draft_number: row.draft_number,
    supersedes_draft_id: row.supersedes_draft_id,
    created_generation: row.created_generation,
    created_message_seq: row.created_message_seq,
    created_at: row.created_at,
    published_resource_version: row.published_resource_version,
    verified_evidence: refs.length > 0,
    size_delta_bytes: proposedBytes - baseBytes,
    large_deletion: deletionRatio >= STUDIO_LARGE_DELETION_RATIO || deleted > 8 * 1024,
  };
}

/** A draft of an organisation, and the session it was drafted in when that session is still there. */
export type OrgDraft = { draft: StudioDraftRow; session: StudioSessionRow | null };

/** The draft and its session when the draft belongs to the organisation, otherwise null. */
export async function findOrgDraft(db: Queryable, orgId: string, draftId: string): Promise<OrgDraft | null> {
  const draft = await getStudioDraft(db, draftId);
  if (!draft || draft.org_id !== orgId) {
    return null;
  }
  return { draft, session: await getStudioSession(db, draft.session_id) };
}

/** Every draft of the session as the operator app reads it, newest first. */
export async function listSessionDrafts(db: Queryable, sessionId: StudioSessionRow["id"]): Promise<StudioDraft[]> {
  return (await listStudioDrafts(db, sessionId)).map(viewDraft);
}

/** The organisation's open drafts whose session's user is gone, as the operator app reads them. */
export async function listOrphanDrafts(db: Queryable, orgId: string): Promise<StudioDraft[]> {
  return (await listOrphanStudioDrafts(db, orgId)).map(viewDraft);
}

function isEvidenceRefKind(value: string): value is EvidenceRefKind {
  return EVIDENCE_REF_KINDS.some((kind) => kind === value);
}

/** One cited reference checked against the tool result it names: the reference, or why it does not check out. */
type CheckedRef = { ref: EvidenceRef } | { warning: EvidenceWarning };

/** A citation of `kind` from its coordinates; null when the coach did not give them. */
function cite<K extends EvidenceRefKind, C extends JsonObject>(
  kind: K,
  seq: number,
  coordinates: C | null,
): ({ kind: K; tool_message_seq: number } & C) | null {
  return coordinates === null ? null : { kind, tool_message_seq: seq, ...coordinates };
}

/** What the coach cited, as the coordinates its kind takes; null when they are not there. */
function citation(kind: EvidenceRefKind, seq: number, item: JsonObject): EvidenceCitation | null {
  switch (kind) {
    case "run_message":
      return cite(kind, seq, keepMatching(EvidenceCoordinates.run_message, item));
    case "group_message":
      return cite(kind, seq, keepMatching(EvidenceCoordinates.group_message, item));
    case "artifact":
      return cite(kind, seq, keepMatching(EvidenceCoordinates.artifact, item));
    case "task_revision":
      return cite(kind, seq, keepMatching(EvidenceCoordinates.task_revision, item));
    case "memory_revision":
      return cite(kind, seq, keepMatching(EvidenceCoordinates.memory_revision, item));
    case "routine":
      return cite(kind, seq, keepMatching(EvidenceCoordinates.routine, item));
  }
}

/** What the tool result a citation names must contain for the citation to check out. */
function citedValues(cited: EvidenceCitation): Array<string | number> {
  switch (cited.kind) {
    case "run_message":
      return [cited.run_id, cited.seq];
    case "group_message":
      return [cited.seq];
    case "artifact":
      return [cited.display_path, cited.version];
    case "task_revision":
      return [cited.agent_id, cited.version];
    case "memory_revision":
      return [cited.revision_id];
    case "routine":
      return [cited.schedule_id];
  }
}

/** What a citation names, as the coach sent it: its kind and the tool result it cites, before its coordinates are read. */
const CitationHead = Type.Object({ kind: Type.String(), tool_message_seq: Type.Integer() });

function resolveEvidenceRef(item: JsonValue, bySeq: Map<number, ConversationMessageRow>): CheckedRef {
  if (!isObjectNode(item)) {
    return { warning: { reason: "invalid_reference" } };
  }
  const head = keepMatching(CitationHead, item);
  if (!head) {
    return { warning: { reason: "invalid_reference" } };
  }
  const { kind, tool_message_seq: seq } = head;
  if (!isEvidenceRefKind(kind)) {
    return { warning: { reason: "unknown_kind", kind } };
  }
  const message = bySeq.get(seq);
  if (!message) {
    return { warning: { reason: "missing_tool_message", tool_message_seq: seq } };
  }
  const cited = citation(kind, seq, item);
  if (!cited) {
    return { warning: { reason: "invalid_reference" } };
  }
  const payload = JSON.stringify(message.payload);
  if (!citedValues(cited).every((value) => payload.includes(String(value)))) {
    return { warning: { reason: "coordinates_not_in_tool_result", kind, tool_message_seq: seq } };
  }
  const excerpt = excerptBytes(payload, STUDIO_EVIDENCE_EXCERPT_BYTES).text;
  const contentHash =
    cited.kind === "routine" ? instructionHash(cited.instruction ?? excerpt) : promptHash(excerpt);
  return { ref: { ...cited, content_hash: contentHash, excerpt: capBytes(excerpt, STUDIO_EVIDENCE_EXCERPT_BYTES)[0] } };
}

/** The references a draft cites that checked out, and a warning for each that did not. */
type CheckedEvidence = { refs: EvidenceRef[]; warnings: EvidenceWarning[] };

function resolveEvidenceRefs(raw: JsonValue[] | undefined, messages: ConversationMessageRow[]): CheckedEvidence {
  const refs: EvidenceRef[] = [];
  const warnings: EvidenceWarning[] = [];
  const bySeq = new Map(messages.map((message) => [message.seq, message]));
  for (const item of (raw ?? []).slice(0, STUDIO_EVIDENCE_REF_MAX)) {
    const checked = resolveEvidenceRef(item, bySeq);
    if ("ref" in checked) {
      refs.push(checked.ref);
    } else {
      warnings.push(checked.warning);
    }
  }
  return { refs, warnings };
}

async function missingDraftAgentMessage(
  db: Queryable,
  call: StudioToolCall,
  handle: string | null | undefined,
): Promise<string> {
  const members = await listAgents(db, call.sourceGuildId);
  const live = members.filter((row) => row.guild_id === call.sourceGuildId);
  const known = live.length ? ` Known agents: ${live.map((row) => `${row.name} (${row.id})`).join(", ")}.` : "";
  const needle = (handle ?? "").trim();
  if (needle) {
    return `studio_create_task_draft agent ${needle} is not a source-guild member.${known}`;
  }
  return `studio_create_task_draft requires agent_id of a source-guild member.${known}`;
}

