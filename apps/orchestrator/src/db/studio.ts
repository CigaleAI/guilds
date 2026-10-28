import type { InferSelectModel } from "drizzle-orm";
import type pg from "pg";
import { patchAssignments, tableColumns } from "./columns.js";
import { CONVERSATION_SESSION_COLUMNS, type ConversationSessionPatch } from "./conversations.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import { agents, runs, studioDrafts, studioSessions } from "./schema/index.js";

type Agent = InferSelectModel<typeof agents>;
type Run = InferSelectModel<typeof runs>;

export type StudioSessionRow = InferSelectModel<typeof studioSessions>;

export type StudioDraftRow = InferSelectModel<typeof studioDrafts>;

export type NewStudioSession = Pick<
  StudioSessionRow,
  | "id"
  | "org_id"
  | "created_by_user_id"
  | "created_by_name"
  | "mode"
  | "source_guild_id"
  | "source_guild_snapshot"
  | "config_snapshot"
  | "status"
> &
  Partial<Pick<StudioSessionRow, "selected_target_agent_id" | "parent_session_id" | "blocked_reason">>;

/** What may change on a Studio session: its generation's fields and the session's own. */
export type StudioSessionPatch = ConversationSessionPatch &
  Partial<
    Pick<
      StudioSessionRow,
      "selected_target_agent_id" | "source_guild_id" | "source_guild_snapshot" | "granted_connection_ids"
    >
  >;

export type NewStudioDraft = Pick<
  StudioDraftRow,
  | "id"
  | "session_id"
  | "org_id"
  | "source_guild_id"
  | "target_agent_id"
  | "target_snapshot"
  | "source_artifact_id"
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
>;

/** How a draft is resolved: its new status and who or what resolved it. */
export type StudioDraftPatch = Partial<
  Pick<
    StudioDraftRow,
    "status" | "published_by_user_id" | "published_resource_version" | "discarded_by_user_id"
  >
> & {
  resolved_at?: Date;
  published_at?: Date;
};

/** An agent of the session's guild, with its routines, latest run, and open draft in the session. */
export type StudioInventoryRow = Pick<
  Agent,
  | "id"
  | "name"
  | "focus"
  | "avatar_shape"
  | "avatar_color"
  | "config"
  | "updated_at"
  | "task_version"
  | "task_hash"
  | "task_updated_at"
> & {
  task_content: Agent["task"];
  routine_count: number;
  paused_count: number;
  latest_run_id: Run["id"] | null;
  latest_run_kind: Run["kind"] | null;
  latest_run_status: Run["status"] | null;
  latest_run_at: Run["updated_at"] | null;
  latest_task_hash: Run["task_prompt_hash"] | null;
  latest_run_errors: Run["errors"] | null;
  draft_id: StudioDraftRow["id"] | null;
  draft_status: StudioDraftRow["status"] | null;
  draft_base_version: StudioDraftRow["base_version"] | null;
};

const SESSION_COLUMNS = tableColumns(studioSessions);
const DRAFT_COLUMNS = tableColumns(studioDrafts);
const STUDIO_SESSION_COLUMNS = [
  ...CONVERSATION_SESSION_COLUMNS,
  "selected_target_agent_id",
  "source_guild_id",
  "source_guild_snapshot",
  "granted_connection_ids",
] as const;
const DRAFT_PATCH_COLUMNS = [
  "status",
  "resolved_at",
  "published_at",
  "published_by_user_id",
  "published_resource_version",
  "discarded_by_user_id",
] as const;

export async function insertStudioSession(
  pool: Queryable,
  session: NewStudioSession,
  now: Date,
): Promise<StudioSessionRow> {
  const result = await pool.query<StudioSessionRow>(
    `INSERT INTO studio_sessions (
       id, org_id, created_by_user_id, created_by_name, mode, source_guild_id,
       source_guild_snapshot, config_snapshot, selected_target_agent_id, parent_session_id,
       status, blocked_reason, generation_state, generation_number, errors, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12,
       'idle', 0, '[]'::jsonb, $13, $13
     )
     RETURNING ${SESSION_COLUMNS}`,
    [
      session.id,
      session.org_id,
      session.created_by_user_id,
      session.created_by_name,
      session.mode,
      session.source_guild_id,
      JSON.stringify(session.source_guild_snapshot),
      JSON.stringify(session.config_snapshot),
      session.selected_target_agent_id ?? null,
      session.parent_session_id ?? null,
      session.status,
      session.blocked_reason ?? null,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("studio session insert failed");
  }
  return row;
}

export async function getStudioSession(pool: Queryable, sessionId: string): Promise<StudioSessionRow | null> {
  const result = await pool.query<StudioSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM studio_sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/** The user's fifty most recently updated sessions in the organisation. */
export async function listStudioSessions(
  pool: Queryable,
  orgId: string,
  userId: string,
): Promise<StudioSessionRow[]> {
  const result = await pool.query<StudioSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM studio_sessions
      WHERE org_id = $1 AND created_by_user_id = $2
      ORDER BY updated_at DESC
      LIMIT 50`,
    [orgId, userId],
  );
  return result.rows;
}

/** The sessions a generation was running or cancelling on when the process stopped. */
export async function listGeneratingStudioSessions(pool: Queryable): Promise<StudioSessionRow[]> {
  const result = await pool.query<StudioSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM studio_sessions WHERE generation_state IN ('generating', 'cancelling')`,
  );
  return result.rows;
}

/**
 * The session, locked for the rest of the transaction `client` is in. NO KEY UPDATE still
 * serialises the session's writers, and lets the change logs the locked work writes reference
 * the session without waiting on this lock.
 */
export async function lockStudioSession(
  client: pg.PoolClient,
  sessionId: string,
): Promise<StudioSessionRow | null> {
  const result = await client.query<StudioSessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM studio_sessions WHERE id = $1 FOR NO KEY UPDATE`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function updateStudioSession(
  pool: Queryable,
  sessionId: string,
  patch: StudioSessionPatch,
  now: Date,
): Promise<StudioSessionRow | null> {
  const { sets, values } = patchAssignments(patch, STUDIO_SESSION_COLUMNS, 3);
  const result = await pool.query<StudioSessionRow>(
    `UPDATE studio_sessions SET ${["updated_at = $2", ...sets].join(", ")}
      WHERE id = $1
      RETURNING ${SESSION_COLUMNS}`,
    [sessionId, stamp(now), ...values],
  );
  return result.rows[0] ?? null;
}

export async function insertStudioDraft(
  pool: Queryable,
  draft: NewStudioDraft,
  now: Date,
): Promise<StudioDraftRow> {
  const result = await pool.query<StudioDraftRow>(
    `INSERT INTO studio_drafts (
       id, session_id, org_id, source_guild_id, resource_kind, target_agent_id,
       target_snapshot, source_artifact_id, source_display_path, base_version,
       base_hash, base_content, proposed_content, rationale, evidence_refs,
       evidence_warnings, risks, status, draft_number, supersedes_draft_id,
       created_generation, created_message_seq, created_at
     ) VALUES (
       $1, $2, $3, $4, 'agent_task', $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
       $15::jsonb, $16::jsonb, $17, $18, $19, $20, $21, $22
     )
     RETURNING ${DRAFT_COLUMNS}`,
    [
      draft.id,
      draft.session_id,
      draft.org_id,
      draft.source_guild_id,
      draft.target_agent_id,
      JSON.stringify(draft.target_snapshot),
      draft.source_artifact_id,
      draft.source_display_path,
      draft.base_version,
      draft.base_hash,
      draft.base_content,
      draft.proposed_content,
      draft.rationale,
      JSON.stringify(draft.evidence_refs),
      JSON.stringify(draft.evidence_warnings),
      JSON.stringify(draft.risks),
      draft.status,
      draft.draft_number,
      draft.supersedes_draft_id,
      draft.created_generation,
      draft.created_message_seq,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing("studio draft insert failed");
  }
  return row;
}

export async function getStudioDraft(pool: Queryable, draftId: string): Promise<StudioDraftRow | null> {
  const result = await pool.query<StudioDraftRow>(`SELECT ${DRAFT_COLUMNS} FROM studio_drafts WHERE id = $1`, [
    draftId,
  ]);
  return result.rows[0] ?? null;
}

/** The draft, locked for the rest of the transaction `client` is in. */
export async function lockStudioDraft(client: pg.PoolClient, draftId: string): Promise<StudioDraftRow | null> {
  const result = await client.query<StudioDraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM studio_drafts WHERE id = $1 FOR UPDATE`,
    [draftId],
  );
  return result.rows[0] ?? null;
}

/** Every draft of the session, newest first. */
export async function listStudioDrafts(pool: Queryable, sessionId: string): Promise<StudioDraftRow[]> {
  const result = await pool.query<StudioDraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM studio_drafts WHERE session_id = $1 ORDER BY created_at DESC`,
    [sessionId],
  );
  return result.rows;
}

/** The session's drafts still open, a draft or a conflict, newest first. */
export async function listStudioDraftHeads(pool: Queryable, sessionId: string): Promise<StudioDraftRow[]> {
  const result = await pool.query<StudioDraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM studio_drafts
      WHERE session_id = $1 AND status IN ('draft', 'conflicted')
      ORDER BY created_at DESC`,
    [sessionId],
  );
  return result.rows;
}

/** The organisation's open drafts whose session's user is gone, newest first. */
export async function listOrphanStudioDrafts(pool: Queryable, orgId: string): Promise<StudioDraftRow[]> {
  const result = await pool.query<StudioDraftRow>(
    `SELECT ${tableColumns(studioDrafts, "d")}
       FROM studio_drafts d
       JOIN studio_sessions s ON s.id = d.session_id
      WHERE d.org_id = $1
        AND s.created_by_user_id IS NULL
        AND d.status = 'draft'
        AND d.target_agent_id IS NOT NULL
        AND d.source_guild_id IS NOT NULL
      ORDER BY d.created_at DESC`,
    [orgId],
  );
  return result.rows;
}

export async function updateStudioDraft(
  pool: Queryable,
  draftId: string,
  patch: StudioDraftPatch,
): Promise<StudioDraftRow | null> {
  const { sets, values } = patchAssignments(patch, DRAFT_PATCH_COLUMNS, 2);
  if (!sets.length) {
    return getStudioDraft(pool, draftId);
  }
  const result = await pool.query<StudioDraftRow>(
    `UPDATE studio_drafts SET ${sets.join(", ")} WHERE id = $1 RETURNING ${DRAFT_COLUMNS}`,
    [draftId, ...values],
  );
  return result.rows[0] ?? null;
}

/** The guild's agents as the Studio coach sees them, each with its open draft in `sessionId`. */
export async function studioInventory(
  pool: Queryable,
  guildId: string,
  sessionId: string | null,
): Promise<StudioInventoryRow[]> {
  const result = await pool.query<StudioInventoryRow>(
    `SELECT a.id, a.name, a.focus, a.avatar_shape, a.avatar_color, a.config, a.updated_at,
            a.task_version, a.task_hash, a.task AS task_content, a.task_updated_at,
            (SELECT COUNT(*)::int FROM schedules s WHERE s.agent_id = a.id) AS routine_count,
            (SELECT COUNT(*)::int FROM schedules s WHERE s.agent_id = a.id AND s.paused) AS paused_count,
            r.id AS latest_run_id, r.kind AS latest_run_kind, r.status AS latest_run_status,
            r.updated_at AS latest_run_at, r.task_prompt_hash AS latest_task_hash,
            r.errors AS latest_run_errors,
            d.id AS draft_id, d.status AS draft_status, d.base_version AS draft_base_version
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT id, kind, status, updated_at, task_prompt_hash, errors
           FROM runs
          WHERE agent_id = a.id
          ORDER BY updated_at DESC
          LIMIT 1
       ) r ON true
       LEFT JOIN studio_drafts d
         ON d.session_id = $2 AND d.target_agent_id = a.id AND d.status IN ('draft', 'conflicted')
      WHERE a.guild_id = $1
      ORDER BY a.name`,
    [guildId, sessionId],
  );
  return result.rows;
}
