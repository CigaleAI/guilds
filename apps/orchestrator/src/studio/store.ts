import type pg from "pg";
import { jsonObj } from "../db/json.js";
import { firstRow, stamp, withTransaction } from "../db/pg.js";
import { utcMonth } from "../usage.js";
import { GLOBAL_SCOPE, GLOBAL_SCOPE_ID, usageDelta } from "../usage.js";

export class StudioStore {
  constructor(public pool: pg.Pool) {}

  async insertSession(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `INSERT INTO studio_sessions (
         id, org_id, created_by_user_id, created_by_name, mode, source_guild_id,
         source_guild_snapshot, coach_agent_id, coach_snapshot, config_snapshot,
         selected_target_agent_id, parent_session_id, status, blocked_reason,
         generation_state, generation_number, errors, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,'idle',0,'[]'::jsonb,$15,$15
       )
       RETURNING *`,
      [
        row.id,
        row.org_id,
        row.created_by_user_id,
        row.created_by_name,
        row.mode,
        row.source_guild_id,
        JSON.stringify(row.source_guild_snapshot ?? {}),
        row.coach_agent_id ?? null,
        row.coach_snapshot ? JSON.stringify(row.coach_snapshot) : null,
        JSON.stringify(row.config_snapshot ?? {}),
        row.selected_target_agent_id ?? null,
        row.parent_session_id ?? null,
        row.status,
        row.blocked_reason ?? null,
        stamp(row.now as Date),
      ],
    );
    return mapSession(result.rows[0] as Record<string, unknown>);
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT * FROM studio_sessions WHERE id = $1`, [sessionId]);
    const row = firstRow(result);
    return row ? mapSession(row) : null;
  }

  async listSessions(orgId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM studio_sessions
        WHERE org_id = $1 AND created_by_user_id = $2
        ORDER BY updated_at DESC
        LIMIT 50`,
      [orgId, userId],
    );
    return (result.rows as Array<Record<string, unknown>>).map(mapSession);
  }

  async withSessionLock<T>(
    sessionId: string,
    fn: (client: pg.PoolClient, session: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`SELECT * FROM studio_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
      const row = firstRow(result);
      if (!row) {
        throw new Error("studio session not found");
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
      selected_target_agent_id: "selected_target_agent_id",
      status: "status",
      blocked_reason: "blocked_reason",
      generation_state: "generation_state",
      generation_number: "generation_number",
      generation_token: "generation_token",
      generation_started_at: "generation_started_at",
      errors: "errors",
      archived_at: "archived_at",
      source_guild_id: "source_guild_id",
      granted_connection_ids: "granted_connection_ids",
      source_guild_snapshot: "source_guild_snapshot",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) {
        continue;
      }
      const value = patch[key];
      if (key === "errors" || key === "granted_connection_ids") {
        sets.push(`${column} = $${index}::jsonb`);
        values.push(JSON.stringify(value ?? []));
      } else if (key === "source_guild_snapshot") {
        sets.push(`${column} = $${index}::jsonb`);
        values.push(JSON.stringify(value ?? {}));
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
      `UPDATE studio_sessions SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
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
      `INSERT INTO studio_messages (session_id, seq, generation, payload, metadata, cost_usd, created_at)
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
      throw new Error("studio message insert failed");
    }
    return mapMessage(row);
  }

  async listMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM studio_messages WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    return (result.rows as Array<Record<string, unknown>>).map(mapMessage);
  }

  async nextSeq(sessionId: string, client?: pg.PoolClient): Promise<number> {
    const db = client ?? this.pool;
    const result = await db.query(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM studio_messages WHERE session_id = $1`,
      [sessionId],
    );
    return Number(firstRow(result)?.seq ?? 0);
  }

  async getMessage(sessionId: string, seq: number, client?: pg.PoolClient): Promise<Record<string, unknown> | null> {
    const db = client ?? this.pool;
    const result = await db.query(
      `SELECT * FROM studio_messages WHERE session_id = $1 AND seq = $2`,
      [sessionId, seq],
    );
    const row = firstRow(result);
    return row ? mapMessage(row) : null;
  }

  async updateMessage(
    sessionId: string,
    seq: number,
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
    client?: pg.PoolClient,
  ): Promise<Record<string, unknown> | null> {
    const db = client ?? this.pool;
    const result = await db.query(
      `UPDATE studio_messages
          SET payload = $3::jsonb, metadata = $4::jsonb
        WHERE session_id = $1 AND seq = $2
        RETURNING *`,
      [sessionId, seq, JSON.stringify(payload), JSON.stringify(metadata)],
    );
    const row = firstRow(result);
    return row ? mapMessage(row) : null;
  }

  async insertDraft(row: Record<string, unknown>, client?: pg.PoolClient): Promise<Record<string, unknown>> {
    const db = client ?? this.pool;
    const result = await db.query(
      `INSERT INTO studio_drafts (
         id, session_id, org_id, source_guild_id, resource_kind, target_agent_id,
         target_snapshot, source_artifact_id, source_display_path, base_version,
         base_hash, base_content, proposed_content, rationale, evidence_refs,
         evidence_warnings, risks, status, draft_number, supersedes_draft_id,
         created_generation, created_message_seq, created_at
       ) VALUES (
         $1,$2,$3,$4,'agent_task',$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
         $15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22
       )
       RETURNING *`,
      [
        row.id,
        row.session_id,
        row.org_id,
        row.source_guild_id,
        row.target_agent_id,
        JSON.stringify(row.target_snapshot ?? {}),
        row.source_artifact_id,
        row.source_display_path,
        row.base_version,
        row.base_hash,
        row.base_content,
        row.proposed_content,
        row.rationale,
        JSON.stringify(row.evidence_refs ?? []),
        JSON.stringify(row.evidence_warnings ?? []),
        JSON.stringify(row.risks ?? []),
        row.status,
        row.draft_number,
        row.supersedes_draft_id ?? null,
        row.created_generation,
        row.created_message_seq,
        stamp(row.now as Date),
      ],
    );
    return mapDraft(result.rows[0] as Record<string, unknown>);
  }

  async getDraft(draftId: string, client?: pg.PoolClient): Promise<Record<string, unknown> | null> {
    const db = client ?? this.pool;
    const result = await db.query(`SELECT * FROM studio_drafts WHERE id = $1`, [draftId]);
    const row = firstRow(result);
    return row ? mapDraft(row) : null;
  }

  async lockDraft(draftId: string, client: pg.PoolClient): Promise<Record<string, unknown> | null> {
    const result = await client.query(`SELECT * FROM studio_drafts WHERE id = $1 FOR UPDATE`, [draftId]);
    const row = firstRow(result);
    return row ? mapDraft(row) : null;
  }

  async listDrafts(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM studio_drafts WHERE session_id = $1 ORDER BY created_at DESC`,
      [sessionId],
    );
    return (result.rows as Array<Record<string, unknown>>).map(mapDraft);
  }

  async listDraftHeads(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT * FROM studio_drafts
        WHERE session_id = $1 AND status IN ('draft', 'conflicted')
        ORDER BY created_at DESC`,
      [sessionId],
    );
    return (result.rows as Array<Record<string, unknown>>).map(mapDraft);
  }

  async updateDraft(
    draftId: string,
    patch: Record<string, unknown>,
    client?: pg.PoolClient,
  ): Promise<Record<string, unknown> | null> {
    const db = client ?? this.pool;
    const sets: string[] = [];
    const values: unknown[] = [draftId];
    let index = 2;
    for (const [column, value] of Object.entries(patch)) {
      if (column === "id") {
        continue;
      }
      if (value instanceof Date) {
        sets.push(`${column} = $${index}`);
        values.push(stamp(value));
      } else if (column === "evidence_refs" || column === "evidence_warnings" || column === "risks") {
        sets.push(`${column} = $${index}::jsonb`);
        values.push(JSON.stringify(value ?? []));
      } else {
        sets.push(`${column} = $${index}`);
        values.push(value);
      }
      index += 1;
    }
    if (!sets.length) {
      return this.getDraft(draftId, client);
    }
    const result = await db.query(
      `UPDATE studio_drafts SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );
    const row = firstRow(result);
    return row ? mapDraft(row) : null;
  }

  async listOrphanDrafts(orgId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT d.*
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
    return (result.rows as Array<Record<string, unknown>>).map(mapDraft);
  }

  async incrementStudioUsage(
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

  async studioUsageByOrg(): Promise<Map<string, Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT s.org_id,
              COALESCE(SUM(m.cost_usd), 0) AS cost_usd,
              COALESCE(SUM(COALESCE((m.metadata->'usage'->>'input_tokens')::bigint, 0)), 0) AS input_tokens,
              COALESCE(SUM(COALESCE((m.metadata->'usage'->>'output_tokens')::bigint, 0)), 0) AS output_tokens,
              COALESCE(SUM(COALESCE((m.metadata->'usage'->>'cache_read_tokens')::bigint, 0)), 0) AS cache_read_tokens,
              COUNT(*) FILTER (WHERE m.cost_usd IS NOT NULL) AS calls,
              MAX(m.created_at) AS updated_at
         FROM studio_messages m
         JOIN studio_sessions s ON s.id = m.session_id
        GROUP BY s.org_id`,
    );
    const map = new Map<string, Record<string, unknown>>();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      map.set(String(row.org_id), row);
    }
    return map;
  }

  async inventory(guildId: string, sessionId: string | null): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT a.id, a.name, a.focus, a.avatar_shape, a.avatar_color, a.archived_at, a.config, a.updated_at,
              a.task_version, a.task_hash, a.task AS task_content, a.task_updated_at,
              (SELECT COUNT(*)::int FROM schedules s WHERE s.agent_id = a.id) AS routine_count,
              (SELECT COUNT(*)::int FROM schedules s WHERE s.agent_id = a.id AND s.paused) AS paused_count,
              r.id AS latest_run_id, r.kind AS latest_run_kind, r.status AS latest_run_status,
              r.updated_at AS latest_run_at, r.task_prompt_hash AS latest_task_hash,
              r.errors AS latest_run_errors, r.metadata AS latest_run_metadata,
              d.id AS draft_id, d.status AS draft_status, d.base_version AS draft_base_version
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT id, kind, status, updated_at, task_prompt_hash, errors, metadata
             FROM runs
            WHERE agent_id = a.id
            ORDER BY updated_at DESC
            LIMIT 1
         ) r ON true
         LEFT JOIN studio_drafts d
           ON d.session_id = $2 AND d.target_agent_id = a.id AND d.status IN ('draft', 'conflicted')
        WHERE a.guild_id = $1
        ORDER BY a.archived_at NULLS FIRST, a.name`,
      [guildId, sessionId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }
}

function mapSession(row: Record<string, unknown>): Record<string, unknown> {
  const granted = jsonObj(row.granted_connection_ids);
  return {
    ...row,
    source_guild_snapshot: jsonObj(row.source_guild_snapshot) ?? {},
    coach_snapshot: row.coach_snapshot ? jsonObj(row.coach_snapshot) : null,
    config_snapshot: jsonObj(row.config_snapshot) ?? {},
    errors: jsonObj(row.errors) ?? [],
    granted_connection_ids: Array.isArray(granted) ? granted.map((id) => String(id)) : [],
  };
}

function mapMessage(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    payload: jsonObj(row.payload) ?? {},
    metadata: jsonObj(row.metadata) ?? {},
    cost_usd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
  };
}

function mapDraft(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    target_snapshot: jsonObj(row.target_snapshot) ?? {},
    evidence_refs: jsonObj(row.evidence_refs) ?? [],
    evidence_warnings: jsonObj(row.evidence_warnings) ?? [],
    risks: jsonObj(row.risks) ?? [],
  };
}
