import { collectTaskEmbeds } from "../artifacts/embeds.js";
import { ArtifactError } from "../artifacts/errors.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { operatorActor } from "../artifacts/actors.js";
import { agentTask, expandTaskText, publishAgentTask, taskDisplayPath } from "../artifacts/task.js";
import { WRITE_MAX_BYTES } from "../artifacts/types.js";
import { jsonObj as _jsonObj } from "../db/json.js";
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
import { studioAgentHandleFromArgs } from "./arguments.js";
import { argString } from "../toolbox/schema.js";
import { excerptBytes } from "./system.js";
import { getAgent, getAgentTask, listAgents, type AgentRow } from "../db/agents.js";
import { nextConversationSeq } from "../db/conversations.js";
import type { Queryable } from "../db/pg.js";
import { getStudioDraft, insertStudioDraft, listStudioDraftHeads, lockStudioDraft, updateStudioDraft, type StudioDraftRow, type StudioSessionRow } from "../db/studio.js";
import { listConversationMessages, type ConversationMessageRow } from "../db/conversations.js";
import { isPlainRecord } from "../db/json.js";
import { EVIDENCE_REF_KINDS, type EvidenceRef, type EvidenceRefKind, type EvidenceWarning } from "../db/schema/index.js";
import type { UserRow } from "../db/users.js";

export type StudioDraftService = {
  createFromTool(
    db: Queryable,
    call: StudioToolCall,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

// A draft is decided like an edit: the tool returns this widget and the turn
// pauses until the operator publishes or discards it.
export const STUDIO_TASK_DRAFT_WIDGET = "studio_task_draft";

/** The risks the coach lists for a draft: its text entries. */
function risksOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function userIdOf(user: UserRow): string | null {
  return typeof user.id === "string" ? user.id : null;
}

export class StudioDrafts implements StudioDraftService {
  constructor(
    public db: Queryable,
    public artifacts: ArtifactStore,
  ) {}

  async createFromTool(
    db: Queryable,
    call: StudioToolCall,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const handle = studioAgentHandleFromArgs(args);
    const agent = await resolveSourceGuildAgent(sourceGuildAgents(db), call, handle);
    if (!agent) {
      throw new StudioUnprocessableError(await missingDraftAgentMessage(db, call, handle));
    }
    const targetId = agent.id;
    const proposed = argString(args, "proposed_content");
    const rationale = argString(args, "rationale");
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
    const messages = await listConversationMessages(db, "studio", String(call.session.id));
    const { refs, warnings } = resolveEvidenceRefs(args.evidence_refs, messages);
    const now = new Date();
    return withLockedSession(this.db, String(call.session.id), async (client, session) => {
      if (session.generation_state !== "generating" && session.generation_state !== "idle") {
        throw new StudioConflictError("session cannot accept a draft");
      }
      const heads = (await listStudioDraftHeads(this.db, session.id)).filter(
        (row) => row.target_agent_id === targetId && row.status === "draft",
      );
      const previous = heads[0] ?? null;
      if (previous) {
        await updateStudioDraft(client, String(previous.id), { status: "superseded", resolved_at: now });
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
          risks: risksOf(args.risks),
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
  ): Promise<Record<string, unknown>> {
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
      if (String(current.id) !== expectedHeadId) {
        throw new StudioConflictError("stale draft head");
      }
      await updateStudioDraft(client, String(current.id), { status: "superseded", resolved_at: now });
      const next = await insertStudioDraft(
        client,
        {
          ...current,
          id: newId("std"),
          proposed_content: proposed,
          status: "draft",
          draft_number: Number(current.draft_number) + 1,
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
  ): Promise<Record<string, unknown>> {
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
        String(current.id),
        { status: "discarded", resolved_at: now, discarded_by_user_id: userIdOf(user) },
      );
      return viewDraft(updated ?? current);
    });
  }

  async publish(args: {
    session: StudioSessionRow;
    user: UserRow;
    draftId: string;
    db: Queryable;
    preview: PreviewDeps;
    notesSystemPath: string;
    publishFilesChanged?: (guildId: string) => Promise<void>;
    orphan?: boolean;
  }): Promise<Record<string, unknown>> {
    const { session, user, draftId } = args;
    const now = new Date();
    const preflight = await this.preflight(args);
    return withLockedSession(this.db, session.id, async (client) => {
      const draft = await lockStudioDraft(client, draftId);
      if (!draft) {
        throw new StudioNotFoundError("draft not found");
      }
      if (!args.orphan && draft.session_id !== session.id) {
        throw new StudioNotFoundError("draft not found");
      }
      if (draft.status !== "draft" && draft.status !== "conflicted") {
        throw new StudioConflictError("draft is not publishable");
      }
      if (!draft.target_agent_id || !draft.source_guild_id) {
        throw new StudioUnprocessableError("draft target is no longer live");
      }
      const agent = await getAgent(args.db, String(draft.target_agent_id));
      if (!agent) {
        throw new StudioUnprocessableError("target is not a publishable agent");
      }
      const currentHash = JSON.stringify(agent.config);
      if (currentHash !== preflight.config_hash) {
        const again = await this.runPreflight(agent, String(draft.proposed_content), args);
        Object.assign(preflight, again);
      }
      const actor = operatorActor({
        orgId: session.org_id,
        actorId: String(user.id ?? "orphan"),
        actorName: user.name,
        guildId: String(draft.source_guild_id),
        agentId: String(draft.target_agent_id),
      });
      const result = await publishAgentTask(client, actor, String(draft.target_agent_id), {
        content: String(draft.proposed_content),
        baseVersion: Number(draft.base_version),
      });
      if (result.outcome === "missing") {
        throw new StudioUnprocessableError("task.md not found");
      }
      if (result.outcome === "conflict") {
        await updateStudioDraft(client, String(draft.id), { status: "conflicted", resolved_at: now });
        throw new StudioConflictError("task version conflict");
      }
      if (result.outcome === "unchanged") {
        const unchanged = await updateStudioDraft(
          client,
          String(draft.id),
          { status: "unchanged", resolved_at: now, published_at: now, published_by_user_id: userIdOf(user) },
        );
        return { outcome: "unchanged", draft: viewDraft(unchanged ?? draft), preflight };
      }
      const written = result.task;
      const published = await updateStudioDraft(
        client,
        String(draft.id),
        {
          status: "published",
          resolved_at: now,
          published_at: now,
          published_by_user_id: userIdOf(user),
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

  async preflight(args: {
    session: StudioSessionRow;
    draftId: string;
    db: Queryable;
    preview: PreviewDeps;
    notesSystemPath: string;
  }): Promise<Record<string, unknown>> {
    const draft = await getStudioDraft(this.db, args.draftId);
    if (!draft || !draft.target_agent_id) {
      throw new StudioNotFoundError("draft not found");
    }
    const agent = await getAgent(args.db, String(draft.target_agent_id));
    if (!agent) {
      throw new StudioUnprocessableError("target agent not found");
    }
    return this.runPreflight(agent, String(draft.proposed_content), args);
  }

  private async runPreflight(
    agent: AgentRow,
    proposed: string,
    args: { preview: PreviewDeps; notesSystemPath: string },
  ): Promise<Record<string, unknown>> {
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
      systemPath: args.notesSystemPath,
      agentName: agent.name,
      agentId: agent.id,
    });
    const preview = await previewCurrentState(args.preview, agent);
    const tools = await projectOfferedToolSchemas(args.preview, agent);
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

export function viewDraft(row: StudioDraftRow): Record<string, unknown> {
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

function isEvidenceRefKind(value: string): value is EvidenceRefKind {
  return EVIDENCE_REF_KINDS.some((kind) => kind === value);
}

/** One cited reference checked against the tool result it names: the reference, or why it does not check out. */
type CheckedRef = { ref: EvidenceRef } | { warning: EvidenceWarning };

function resolveEvidenceRef(item: unknown, bySeq: Map<number, ConversationMessageRow>): CheckedRef {
  if (!isPlainRecord(item)) {
    return { warning: { reason: "invalid_reference" } };
  }
  const kind = String(item.kind ?? item.type ?? "");
  if (!isEvidenceRefKind(kind)) {
    return { warning: { reason: "unknown_kind", kind } };
  }
  const seq = Number(item.tool_message_seq);
  const message = bySeq.get(seq);
  if (!message) {
    return { warning: { reason: "missing_tool_message", tool_message_seq: seq } };
  }
  const payload = JSON.stringify(message.payload);
  if (!evidenceCoordinates(kind, item).every((value) => payload.includes(String(value)))) {
    return { warning: { reason: "coordinates_not_in_tool_result", kind, tool_message_seq: seq } };
  }
  const excerpt = excerptBytes(payload, STUDIO_EVIDENCE_EXCERPT_BYTES).text;
  const ref: EvidenceRef = {
    ...Object.fromEntries(Object.entries(item).filter(([key]) => !["content_hash", "instruction_hash", "excerpt"].includes(key))),
    kind,
    tool_message_seq: seq,
    content_hash: kind === "routine" ? instructionHash(String(item.instruction ?? excerpt)) : promptHash(excerpt),
    excerpt: capBytes(excerpt, STUDIO_EVIDENCE_EXCERPT_BYTES)[0],
  };
  return { ref };
}

function resolveEvidenceRefs(
  raw: unknown,
  messages: ConversationMessageRow[],
): { refs: EvidenceRef[]; warnings: EvidenceWarning[] } {
  const refs: EvidenceRef[] = [];
  const warnings: EvidenceWarning[] = [];
  if (!Array.isArray(raw)) {
    return { refs, warnings };
  }
  const bySeq = new Map(messages.map((message) => [message.seq, message]));
  for (const item of raw.slice(0, STUDIO_EVIDENCE_REF_MAX)) {
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
  let known = "";
  try {
    const members = await listAgents(db, call.sourceGuildId);
    const live = members.filter((row) => String(row.guild_id) === String(call.sourceGuildId));
    if (live.length) {
      known = ` Known agents: ${live.map((row) => `${row.name} (${row.id})`).join(", ")}.`;
    }
  } catch {
    known = "";
  }
  const needle = String(handle ?? "").trim();
  if (needle) {
    return `studio_create_task_draft agent ${needle} is not a source-guild member.${known}`;
  }
  return `studio_create_task_draft requires agent_id of a source-guild member.${known}`;
}

function evidenceCoordinates(kind: string, candidate: Record<string, unknown>): unknown[] {
  if (kind === "run_message") return [candidate.run_id, candidate.seq_start ?? candidate.seq];
  if (kind === "group_message") return [candidate.seq];
  if (kind === "artifact") return [candidate.display_path, candidate.version];
  if (kind === "task_revision") return [candidate.agent_id, candidate.version];
  if (kind === "memory_revision") return [candidate.revision_id];
  if (kind === "routine") return [candidate.schedule_id];
  return [];
}

