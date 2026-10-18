import type pg from "pg";
import { jsonObj } from "../db/json.js";
import { firstRow, stamp, withTransaction } from "../db/pg.js";
import { utcMonth } from "../usage.js";
import { GLOBAL_SCOPE, GLOBAL_SCOPE_ID, usageDelta } from "../usage.js";

function mapSession(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    org_id: row.org_id,
    created_by_user_id: row.created_by_user_id,
    created_by_name: row.created_by_name,
    recipe_id: row.recipe_id,
    config_snapshot: jsonObj(row.config_snapshot),
    status: row.status,
    blocked_reason: row.blocked_reason,
    generation_state: row.generation_state,
    generation_number: Number(row.generation_number),
    generation_token: row.generation_token,
    generation_started_at: row.generation_started_at,
    errors: jsonObj(row.errors),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

function mapMessage(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    session_id: row.session_id,
    seq: Number(row.seq),
    generation: Number(row.generation),
    payload: jsonObj(row.payload),
    metadata: jsonObj(row.metadata),
    cost_usd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    created_at: row.created_at,
  };
}

export class BuilderStore {
  constructor(public pool: pg.Pool) {}

  async insertSession(row: Record<string, unknown>, client?: pg.PoolClient): Promise<Record<string, unknown>> {
    const db = client ?? this.pool;
    const result = await db.query(
      `INSERT INTO builder_sessions (
         id, org_id, created_by_user_id, created_by_name, recipe_id, config_snapshot,
         status, blocked_reason, generation_state, generation_number, errors, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6::jsonb,$7,NULL,'idle',0,'[]'::jsonb,$8,$8
       ) RETURNING *`,
      [
        row.id,
        row.org_id,
        row.created_by_user_id,
        row.created_by_name,
        row.recipe_id,
        JSON.stringify(row.config_snapshot ?? {}),
        row.status,
        stamp(row.now as Date),
      ],
    );
    const inserted = firstRow(result);
    if (!inserted) {
      throw new Error("builder session insert failed");
    }
    return mapSession(inserted);
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT * FROM builder_sessions WHERE id = $1`, [sessionId]);
    const row = firstRow(result);
    return row ? mapSession(row) : null;
  }

  async listSessions(orgId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT s.*, r.name AS recipe_name, r.status AS recipe_status, r.body_version AS recipe_body_version
         FROM builder_sessions s
         LEFT JOIN recipes r ON r.id = s.recipe_id
        WHERE s.org_id = $1 AND s.created_by_user_id = $2
        ORDER BY s.updated_at DESC
        LIMIT 50`,
      [orgId, userId],
    );
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      ...mapSession(row),
      recipe_name: row.recipe_name ?? null,
      recipe_status: row.recipe_status ?? null,
      recipe_body_version:
        row.recipe_body_version === null || row.recipe_body_version === undefined
          ? null
          : Number(row.recipe_body_version),
    }));
  }

  async withSessionLock<T>(
    sessionId: string,
    fn: (client: pg.PoolClient, session: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`SELECT * FROM builder_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
      const row = firstRow(result);
      if (!row) {
        throw new Error("builder session not found");
      }
      return fn(client, mapSession(row));
    });
  }

  async updateSession(
    sessionId: string,
    patch: Record<string, unknown>,
    now: Date,
    client?: pg.PoolClient,
  ): Promise<Record<string, unknown> | null> {
    const db = client ?? this.pool;
    const sets: string[] = ["updated_at = $2"];
    const values: unknown[] = [sessionId, stamp(now)];
    let index = 3;
    const mapping: Record<string, string> = {
      status: "status",
      blocked_reason: "blocked_reason",
      generation_state: "generation_state",
      generation_number: "generation_number",
      generation_token: "generation_token",
      generation_started_at: "generation_started_at",
      errors: "errors",
      archived_at: "archived_at",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) {
        continue;
      }
      const value = patch[key];
      if (key === "errors") {
        sets.push(`${column} = $${index}::jsonb`);
        values.push(JSON.stringify(value ?? []));
      } else if (key === "generation_started_at" || key === "archived_at") {
        sets.push(`${column} = $${index}`);
        values.push(value instanceof Date ? stamp(value) : value);
      } else {
        sets.push(`${column} = $${index}`);
        values.push(value);
      }
      index += 1;
    }
    const result = await db.query(
      `UPDATE builder_sessions SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );
    const row = firstRow(result);
    return row ? mapSession(row) : null;
  }

  async insertMessage(
    sessionId: string,
    seq: number,
    generation: number,
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
    now: Date,
    client?: pg.PoolClient,
  ): Promise<Record<string, unknown>> {
    const db = client ?? this.pool;
    const delta = usageDelta(metadata);
    const result = await db.query(
      `INSERT INTO builder_messages (session_id, seq, generation, payload, metadata, cost_usd, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        sessionId,
        seq,
        generation,
        JSON.stringify(payload),
        JSON.stringify(metadata),
        delta ? delta.cost_usd : null,
        stamp(now),
      ],
    );
    const row = firstRow(result);
    if (!row) {
      throw new Error("builder message insert failed");
    }
    return mapMessage(row);
  }

  /** Replace one stored message in place: the system prompt at seq 0 is refreshed every generation. */
  async updateMessage(
    sessionId: string,
    seq: number,
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
    client?: pg.PoolClient,
  ): Promise<Record<string, unknown> | null> {
    const db = client ?? this.pool;
    const result = await db.query(
      `UPDATE builder_messages
          SET payload = $3::jsonb, metadata = $4::jsonb
        WHERE session_id = $1 AND seq = $2
        RETURNING *`,
      [sessionId, seq, JSON.stringify(payload), JSON.stringify(metadata)],
    );
    const row = firstRow(result);
    return row ? mapMessage(row) : null;
  }

  async listMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM builder_messages WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    return (result.rows as Array<Record<string, unknown>>).map(mapMessage);
  }

  async nextSeq(sessionId: string, client?: pg.PoolClient): Promise<number> {
    const db = client ?? this.pool;
    const result = await db.query(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM builder_messages WHERE session_id = $1`,
      [sessionId],
    );
    return Number(firstRow(result)?.seq ?? 0);
  }

  /** What Builder sessions spent, per organisation. */
  async builderUsageByOrg(): Promise<Map<string, Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT s.org_id,
              COALESCE(SUM(m.cost_usd), 0) AS cost_usd,
              COALESCE(SUM(COALESCE((m.metadata->'usage'->>'input_tokens')::bigint, 0)), 0) AS input_tokens,
              COALESCE(SUM(COALESCE((m.metadata->'usage'->>'output_tokens')::bigint, 0)), 0) AS output_tokens,
              COALESCE(SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0)), 0) AS cache_read_tokens,
              COUNT(*) FILTER (WHERE m.cost_usd IS NOT NULL) AS calls,
              MAX(m.created_at) AS updated_at
         FROM builder_messages m
         JOIN builder_sessions s ON s.id = m.session_id
        GROUP BY s.org_id`,
    );
    const map = new Map<string, Record<string, unknown>>();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      map.set(String(row.org_id), row);
    }
    return map;
  }

  async incrementUsage(
    orgId: string,
    metadata: Record<string, unknown>,
    now: Date,
    client?: pg.PoolClient,
  ): Promise<void> {
    const delta = usageDelta(metadata);
    if (delta === null) {
      return;
    }
    const db = client ?? this.pool;
    for (const [scope, scopeId] of [
      ["org", orgId],
      [GLOBAL_SCOPE, GLOBAL_SCOPE_ID],
    ] as const) {
      await db.query(
        `INSERT INTO usage_counters (
           scope, scope_id, input_tokens, output_tokens, cache_read_tokens,
           cost_usd, calls, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
         ON CONFLICT (scope, scope_id) DO UPDATE SET
           input_tokens = usage_counters.input_tokens + EXCLUDED.input_tokens,
           output_tokens = usage_counters.output_tokens + EXCLUDED.output_tokens,
           cache_read_tokens = usage_counters.cache_read_tokens + EXCLUDED.cache_read_tokens,
           cost_usd = usage_counters.cost_usd + EXCLUDED.cost_usd,
           calls = usage_counters.calls + 1,
           updated_at = EXCLUDED.updated_at`,
        [
          scope,
          scopeId,
          delta.input_tokens,
          delta.output_tokens,
          delta.cache_read_tokens,
          delta.cost_usd,
          stamp(now),
        ],
      );
    }
    await db.query(
      `INSERT INTO org_monthly_usage (
         org_id, month, input_tokens, output_tokens, cache_read_tokens,
         cost_usd, calls, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
       ON CONFLICT (org_id, month) DO UPDATE SET
         input_tokens = org_monthly_usage.input_tokens + EXCLUDED.input_tokens,
         output_tokens = org_monthly_usage.output_tokens + EXCLUDED.output_tokens,
         cache_read_tokens = org_monthly_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
         cost_usd = org_monthly_usage.cost_usd + EXCLUDED.cost_usd,
         calls = org_monthly_usage.calls + 1,
         updated_at = EXCLUDED.updated_at`,
      [
        orgId,
        utcMonth(now),
        delta.input_tokens,
        delta.output_tokens,
        delta.cache_read_tokens,
        delta.cost_usd,
        stamp(now),
      ],
    );
  }
}
