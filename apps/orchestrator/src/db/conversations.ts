import type { InferSelectModel } from "drizzle-orm";
import { patchAssignments } from "./columns.js";
import { RowMissing } from "./errors.js";
import { type Queryable, stamp } from "./pg.js";
import type { builderMessages, SessionError } from "./schema/index.js";
import { usageDelta } from "./usage.js";

/** Whose conversation it is: a Studio session's or a Builder session's, each with tables of its own. */
export type ConversationKind = "studio" | "builder";

/** A Studio or Builder session, by its kind and id. */
export type ConversationSessionKey = { kind: ConversationKind; sessionId: string };

/** A message of a Studio or Builder conversation, its cost as a number. */
export type ConversationMessageRow = Omit<InferSelectModel<typeof builderMessages>, "cost_usd"> & {
  cost_usd: number | null;
};

export type NewConversationMessage = Pick<
  ConversationMessageRow,
  "session_id" | "seq" | "generation" | "payload" | "metadata"
>;

/** What a conversation's generation changes on its session, whichever kind it is. */
export type ConversationSessionPatch = {
  status?: "active" | "blocked" | "archived";
  blocked_reason?: string | null;
  generation_state?: "idle" | "generating" | "cancelling";
  generation_number?: number;
  generation_token?: string | null;
  generation_started_at?: Date | null;
  errors?: SessionError[];
  archived_at?: Date | null;
};

/** What a conversation's sessions spent, per organisation. */
export type ConversationUsageRow = {
  org_id: string;
  cost_usd: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  calls: number;
  updated_at: string | null;
};

const MESSAGE_COLUMNS =
  "id, session_id, seq, generation, payload, metadata, cost_usd::float8 AS cost_usd, created_at";

/** The columns a conversation's generation writes on its session. */
export const CONVERSATION_SESSION_COLUMNS = [
  "status",
  "blocked_reason",
  "generation_state",
  "generation_number",
  "generation_token",
  "generation_started_at",
  "errors",
  "archived_at",
] as const;

export async function insertConversationMessage(
  pool: Queryable,
  kind: ConversationKind,
  message: NewConversationMessage,
  now: Date,
): Promise<ConversationMessageRow> {
  const result = await pool.query<ConversationMessageRow>(
    `INSERT INTO ${kind}_messages (session_id, seq, generation, payload, metadata, cost_usd, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      message.session_id,
      message.seq,
      message.generation,
      JSON.stringify(message.payload),
      JSON.stringify(message.metadata),
      usageDelta(message.metadata)?.cost_usd ?? null,
      stamp(now),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RowMissing(`${kind} message insert failed`);
  }
  return row;
}

/** Replaces a stored message's payload and metadata in place. */
export async function updateConversationMessage(
  pool: Queryable,
  kind: ConversationKind,
  message: Omit<NewConversationMessage, "generation">,
): Promise<ConversationMessageRow | null> {
  const result = await pool.query<ConversationMessageRow>(
    `UPDATE ${kind}_messages
        SET payload = $3::jsonb, metadata = $4::jsonb
      WHERE session_id = $1 AND seq = $2
      RETURNING ${MESSAGE_COLUMNS}`,
    [message.session_id, message.seq, JSON.stringify(message.payload), JSON.stringify(message.metadata)],
  );
  return result.rows[0] ?? null;
}

export async function getConversationMessage(
  pool: Queryable,
  kind: ConversationKind,
  sessionId: string,
  seq: number,
): Promise<ConversationMessageRow | null> {
  const result = await pool.query<ConversationMessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM ${kind}_messages WHERE session_id = $1 AND seq = $2`,
    [sessionId, seq],
  );
  return result.rows[0] ?? null;
}

export async function listConversationMessages(
  pool: Queryable,
  kind: ConversationKind,
  sessionId: string,
): Promise<ConversationMessageRow[]> {
  const result = await pool.query<ConversationMessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM ${kind}_messages WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return result.rows;
}

/** The seq the session's next message takes. */
export async function nextConversationSeq(
  pool: Queryable,
  kind: ConversationKind,
  sessionId: string,
): Promise<number> {
  const result = await pool.query<{ seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ${kind}_messages WHERE session_id = $1`,
    [sessionId],
  );
  return result.rows[0]?.seq ?? 0;
}

/** Applies `patch` to the session, through the columns every conversation's session has. */
export async function updateConversationSession(
  pool: Queryable,
  session: ConversationSessionKey,
  patch: ConversationSessionPatch,
  now: Date,
): Promise<void> {
  const { sets, values } = patchAssignments(patch, CONVERSATION_SESSION_COLUMNS, 3);
  await pool.query(
    `UPDATE ${session.kind}_sessions SET ${["updated_at = $2", ...sets].join(", ")} WHERE id = $1`,
    [session.sessionId, stamp(now), ...values],
  );
}

/** The errors recorded on the session, or null when it is gone. */
export async function conversationSessionErrors(
  pool: Queryable,
  session: ConversationSessionKey,
): Promise<SessionError[] | null> {
  const result = await pool.query<{ errors: SessionError[] }>(
    `SELECT errors FROM ${session.kind}_sessions WHERE id = $1`,
    [session.sessionId],
  );
  return result.rows[0]?.errors ?? null;
}

export async function conversationUsageByOrg(
  pool: Queryable,
  kind: ConversationKind,
): Promise<Map<string, ConversationUsageRow>> {
  const result = await pool.query<ConversationUsageRow>(
    `SELECT s.org_id,
            COALESCE(SUM(m.cost_usd), 0) AS cost_usd,
            COALESCE(SUM(COALESCE((m.metadata->'usage'->>'input_tokens')::bigint, 0)), 0) AS input_tokens,
            COALESCE(SUM(COALESCE((m.metadata->'usage'->>'output_tokens')::bigint, 0)), 0) AS output_tokens,
            COALESCE(SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0)), 0) AS cache_read_tokens,
            COUNT(*) FILTER (WHERE m.cost_usd IS NOT NULL) AS calls,
            MAX(m.created_at) AS updated_at
       FROM ${kind}_messages m
       JOIN ${kind}_sessions s ON s.id = m.session_id
      GROUP BY s.org_id`,
  );
  return new Map(result.rows.map((row) => [row.org_id, row]));
}
