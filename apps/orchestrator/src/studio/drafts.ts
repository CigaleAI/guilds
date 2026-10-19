import {
  ArtifactError,
  collectTaskEmbeds,
  displayPathFor,
  hashArtifactContent,
  inlineTaskEmbeds,
  type ArtifactStore,
} from "../artifacts/index.js";
import { WRITE_MAX_BYTES } from "../artifacts/types.js";
import { jsonObj as _jsonObj } from "../db/json.js";
import { newId } from "../lib/ids.js";
import { memoryOf } from "../agents/validation.js";
import { composeAgentSystemPrompt, hydrateStanding, promptHash, schemasOffer } from "../prompts/index.js";
import { countInputTokens } from "../llm/tokens.js";
import { instructionHash } from "../schedules/item.js";
import { capBytes } from "../toolbox/output.js";
import {
  STUDIO_EVIDENCE_EXCERPT_BYTES,
  STUDIO_EVIDENCE_REF_MAX,
  STUDIO_LARGE_DELETION_RATIO,
} from "./constants.js";
import { StudioConflictError, StudioError, StudioUnprocessableError } from "./errors.js";
import { previewCurrentState, projectOfferedToolSchemas } from "./preview.js";
import type { StudioStore } from "./store.js";
import type { StudioToolContext } from "./tools.js";
import { resolveSourceGuildAgent, studioAgentHandleFromArgs } from "./tools.js";
import { argString } from "../toolbox/schema.js";
import { excerptBytes } from "./system.js";

export type StudioDraftService = {
  createFromTool(ctx: StudioToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const REF_KINDS = new Set([
  "run_message",
  "group_message",
  "artifact",
  "task_revision",
  "memory_revision",
  "routine",
]);

// A draft is decided like an edit: the tool returns this widget and the turn
// pauses until the operator publishes or discards it.
export const STUDIO_TASK_DRAFT_WIDGET = "studio_task_draft";

export class StudioDrafts implements StudioDraftService {
  constructor(
    public store: StudioStore,
    public artifacts: ArtifactStore,
  ) {}

  async createFromTool(ctx: StudioToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handle = studioAgentHandleFromArgs(args);
    const agent = await resolveSourceGuildAgent(ctx, handle);
    if (!agent) {
      throw new StudioUnprocessableError(await missingDraftAgentMessage(ctx, handle));
    }
    const targetId = String(agent.id);
    const proposed = argString(args, "proposed_content");
    const rationale = argString(args, "rationale");
    if (!proposed.trim() || !rationale.trim()) {
      throw new StudioUnprocessableError("studio_create_task_draft requires complete proposed_content and rationale");
    }
    if (Buffer.byteLength(proposed, "utf8") > WRITE_MAX_BYTES) {
      throw new StudioUnprocessableError("proposed_content exceeds the 256 KiB artifact write limit");
    }
    const task = await ctx.repo.getAgentTask(ctx.orgId, targetId);
    if (!task) {
      throw new StudioUnprocessableError("task.md not found");
    }
    const messages = await ctx.store.listMessages(String(ctx.session.id));
    const { refs, warnings } = resolveEvidenceRefs(args.evidence_refs, messages);
    const now = new Date();
    return this.store.withSessionLock(String(ctx.session.id), async (client, session) => {
      if (session.generation_state !== "generating" && session.generation_state !== "idle") {
        throw new StudioConflictError("session cannot accept a draft");
      }
      const heads = (await this.store.listDraftHeads(String(session.id))).filter(
        (row) => row.target_agent_id === targetId && row.status === "draft",
      );
      const previous = heads[0] ?? null;
      if (previous) {
        await this.store.updateDraft(String(previous.id), { status: "superseded", resolved_at: now }, client);
      }
      const seq = await this.store.nextSeq(String(session.id), client);
      const draft = await this.store.insertDraft(
        {
          id: newId("std"),
          session_id: session.id,
          org_id: ctx.orgId,
          source_guild_id: ctx.sourceGuildId,
          target_agent_id: targetId,
          target_snapshot: {
            id: agent.id,
            name: agent.name,
            focus: agent.focus,
          },
          source_artifact_id: null,
          source_display_path: displayPathFor({
            orgId: ctx.orgId,
            level: "agent",
            ownerId: targetId,
            kind: "task",
            path: "",
            key: "task.md",
          }),
          base_version: task.version,
          base_hash: task.content_hash,
          base_content: task.content_text ?? "",
          proposed_content: proposed,
          rationale,
          evidence_refs: refs,
          evidence_warnings: warnings,
          risks: Array.isArray(args.risks) ? args.risks : [],
          status: "draft",
          draft_number: Number(previous?.draft_number ?? 0) + 1,
          supersedes_draft_id: previous ? previous.id : null,
          created_generation: ctx.generation,
          created_message_seq: ctx.nextMessageSeq ?? seq,
          now,
        },
        client,
      );
      return {
        widget: STUDIO_TASK_DRAFT_WIDGET,
        await_operator: true,
        agent: { id: targetId, name: String(agent.name) },
        draft_id: draft.id,
        rationale,
        draft: viewDraft(draft),
        evidence_warnings: warnings,
        verified_evidence: refs.length > 0,
      };
    });
  }

  async revise(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    draftId: string,
    proposed: string,
    expectedHeadId: string,
  ): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(proposed, "utf8") > WRITE_MAX_BYTES) {
      throw new StudioUnprocessableError("proposed_content exceeds the 256 KiB artifact write limit");
    }
    const now = new Date();
    return this.store.withSessionLock(String(session.id), async (client) => {
      const current = await this.store.lockDraft(draftId, client);
      if (!current || current.session_id !== session.id) {
        throw new StudioError(404, "draft not found");
      }
      if (current.status !== "draft" && current.status !== "conflicted") {
        throw new StudioConflictError("draft is not editable");
      }
      if (String(current.id) !== expectedHeadId) {
        throw new StudioConflictError("stale draft head");
      }
      await this.store.updateDraft(String(current.id), { status: "superseded", resolved_at: now }, client);
      const next = await this.store.insertDraft(
        {
          ...current,
          id: newId("std"),
          proposed_content: proposed,
          status: "draft",
          draft_number: Number(current.draft_number) + 1,
          supersedes_draft_id: current.id,
          created_generation: current.created_generation,
          created_message_seq: current.created_message_seq,
          now,
        },
        client,
      );
      return viewDraft(next);
    });
  }

  async discard(
    session: Record<string, unknown>,
    user: Record<string, unknown>,
    draftId: string,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.store.withSessionLock(String(session.id), async (client) => {
      const current = await this.store.lockDraft(draftId, client);
      if (!current || current.session_id !== session.id) {
        throw new StudioError(404, "draft not found");
      }
      if (current.status !== "draft" && current.status !== "conflicted") {
        throw new StudioConflictError("draft cannot be discarded");
      }
      const updated = await this.store.updateDraft(
        String(current.id),
        { status: "discarded", resolved_at: now, discarded_by_user_id: user.id ?? null },
        client,
      );
      return viewDraft(updated ?? current);
    });
  }

  async publish(args: {
    session: Record<string, unknown>;
    user: Record<string, unknown>;
    draftId: string;
    repo: StudioToolContext["repo"];
    preview: StudioToolContext["preview"];
    notesSystemPath: string;
    publishFilesChanged?: (guildId: string) => Promise<void>;
    orphan?: boolean;
  }): Promise<Record<string, unknown>> {
    const { session, user, draftId } = args;
    const now = new Date();
    const preflight = await this.preflight(args);
    return this.store.withSessionLock(String(session.id), async (client) => {
      const draft = await this.store.lockDraft(draftId, client);
      if (!draft) {
        throw new StudioError(404, "draft not found");
      }
      if (!args.orphan && draft.session_id !== session.id) {
        throw new StudioError(404, "draft not found");
      }
      if (draft.status !== "draft" && draft.status !== "conflicted") {
        throw new StudioConflictError("draft is not publishable");
      }
      if (!draft.target_agent_id || !draft.source_guild_id) {
        throw new StudioUnprocessableError("draft target is no longer live");
      }
      const agent = await args.repo.getAgent(String(draft.target_agent_id));
      if (!agent) {
        throw new StudioUnprocessableError("target is not a publishable agent");
      }
      const currentHash = JSON.stringify(agent.config ?? {});
      if (currentHash !== preflight.config_hash) {
        const again = await this.runPreflight(agent, String(draft.proposed_content), args);
        Object.assign(preflight, again);
      }
      const actor = this.artifacts.operatorContext(
        String(session.org_id),
        String(user.id ?? "orphan"),
        String(user.name ?? "operator"),
        { guildId: String(draft.source_guild_id), agentId: String(draft.target_agent_id) },
      );
      const live = await args.repo.getAgentTask(String(session.org_id), String(draft.target_agent_id), client);
      if (!live) {
        throw new StudioUnprocessableError("task.md not found");
      }
      if (Number(live.version) !== Number(draft.base_version)) {
        await this.store.updateDraft(String(draft.id), { status: "conflicted", resolved_at: now }, client);
        throw new StudioConflictError("task version conflict");
      }
      const proposedHash = hashArtifactContent(String(draft.proposed_content));
      if (proposedHash === live.content_hash) {
        const unchanged = await this.store.updateDraft(
          String(draft.id),
          { status: "unchanged", resolved_at: now, published_at: now, published_by_user_id: user.id ?? null },
          client,
        );
        return { outcome: "unchanged", draft: viewDraft(unchanged ?? draft), preflight };
      }
      let written;
      try {
        written = await args.repo.writeAgentTask(
          actor,
          String(draft.target_agent_id),
          String(draft.proposed_content),
          Number(draft.base_version),
          client,
        );
      } catch (error) {
        if (error instanceof ArtifactError && error.status === 409) {
          await this.store.updateDraft(String(draft.id), { status: "conflicted", resolved_at: now }, client);
          throw new StudioConflictError("task version conflict");
        }
        throw error;
      }
      const published = await this.store.updateDraft(
        String(draft.id),
        {
          status: "published",
          resolved_at: now,
          published_at: now,
          published_by_user_id: user.id ?? null,
          published_resource_version: written.version,
        },
        client,
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
    session: Record<string, unknown>;
    draftId: string;
    repo: StudioToolContext["repo"];
    preview: StudioToolContext["preview"];
    notesSystemPath: string;
  }): Promise<Record<string, unknown>> {
    const draft = await this.store.getDraft(args.draftId);
    if (!draft || !draft.target_agent_id) {
      throw new StudioError(404, "draft not found");
    }
    const agent = await args.repo.getAgent(String(draft.target_agent_id));
    if (!agent) {
      throw new StudioUnprocessableError("target agent not found");
    }
    return this.runPreflight(agent, String(draft.proposed_content), args);
  }

  private async runPreflight(
    agent: Record<string, unknown>,
    proposed: string,
    args: { preview: StudioToolContext["preview"]; notesSystemPath: string },
  ): Promise<Record<string, unknown>> {
    const actor = this.artifacts.operatorContext(
      String(agent.org_id),
      "studio-preflight",
      "studio",
      { guildId: String(agent.guild_id), agentId: String(agent.id) },
    );
    let expanded: string;
    try {
      expanded = await inlineTaskEmbeds(this.artifacts, actor, proposed);
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new StudioUnprocessableError(error.message);
      }
      throw error;
    }
    const standing = hydrateStanding({
      systemPath: args.notesSystemPath,
      agentName: String(agent.name),
      agentId: String(agent.id),
    });
    const memoryRow = await this.artifacts.getMemoryRow(actor, String(agent.id));
    const preview = await previewCurrentState(args.preview, agent);
    const tools = await projectOfferedToolSchemas(args.preview, agent);
    const config = (agent.config && typeof agent.config === "object" ? agent.config : {}) as Record<string, unknown>;
    const memoryEnabled = memoryOf(config);
    const composed = composeAgentSystemPrompt(
      standing,
      expanded,
      preview.state,
      memoryRow?.content_text ?? "",
      memoryEnabled,
      memoryEnabled && schemasOffer(tools.schemas, "memory_write"),
    );
    const tokens = countInputTokens(String(config.model ?? ""), [{ role: "system", content: composed }], tools.schemas);
    const maxInput = Number(config.max_input_tokens ?? 100_000);
    if (tokens > maxInput) {
      throw new StudioUnprocessableError("composed prompt exceeds the target agent's max_input_tokens");
    }
    const liveContent = String(agent.task ?? "");
    let priorEffective = typeof agent.task_hash === "string" ? agent.task_hash : null;
    if (liveContent) {
      try {
        priorEffective = promptHash(await inlineTaskEmbeds(this.artifacts, actor, liveContent));
      } catch {
        priorEffective = typeof agent.task_hash === "string" ? agent.task_hash : null;
      }
    }
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

export function viewDraft(row: Record<string, unknown>): Record<string, unknown> {
  const base = String(row.base_content ?? "");
  const proposed = String(row.proposed_content ?? "");
  const baseBytes = Buffer.byteLength(base, "utf8");
  const proposedBytes = Buffer.byteLength(proposed, "utf8");
  const deleted = Math.max(0, baseBytes - proposedBytes);
  const deletionRatio = baseBytes === 0 ? 0 : deleted / baseBytes;
  const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs : [];
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

function resolveEvidenceRefs(
  raw: unknown,
  messages: Array<Record<string, unknown>>,
): { refs: Array<Record<string, unknown>>; warnings: Array<Record<string, unknown>> } {
  const refs: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  if (!Array.isArray(raw)) {
    return { refs, warnings };
  }
  const bySeq = new Map<number, Record<string, unknown>>();
  for (const message of messages) {
    bySeq.set(Number(message.seq), message);
  }
  for (const item of raw.slice(0, STUDIO_EVIDENCE_REF_MAX)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      warnings.push({ reason: "invalid_reference" });
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const kind = String(candidate.kind ?? candidate.type ?? "");
    if (!REF_KINDS.has(kind)) {
      warnings.push({ reason: "unknown_kind", kind });
      continue;
    }
    const seq = Number(candidate.tool_message_seq);
    const message = bySeq.get(seq);
    if (!message) {
      warnings.push({ reason: "missing_tool_message", tool_message_seq: seq });
      continue;
    }
    const payload = JSON.stringify(message.payload ?? {});
    const coordinates = evidenceCoordinates(kind, candidate);
    if (!coordinates.every((value) => payload.includes(String(value)))) {
      warnings.push({ reason: "coordinates_not_in_tool_result", kind, tool_message_seq: seq });
      continue;
    }
    const excerpt = excerptBytes(payload, STUDIO_EVIDENCE_EXCERPT_BYTES).text;
    refs.push({
      kind,
      tool_message_seq: seq,
      ...Object.fromEntries(
        Object.entries(candidate).filter(([key]) => !["content_hash", "instruction_hash", "excerpt"].includes(key)),
      ),
      content_hash: kind === "routine" ? instructionHash(String(candidate.instruction ?? excerpt)) : promptHash(excerpt),
      excerpt: capBytes(excerpt, STUDIO_EVIDENCE_EXCERPT_BYTES)[0],
    });
  }
  return { refs, warnings };
}

async function missingDraftAgentMessage(
  ctx: StudioToolContext,
  handle: string | null | undefined,
): Promise<string> {
  let known = "";
  try {
    const members = await ctx.repo.listAgents(ctx.sourceGuildId);
    const live = members.filter((row) => String(row.guild_id) === String(ctx.sourceGuildId));
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

