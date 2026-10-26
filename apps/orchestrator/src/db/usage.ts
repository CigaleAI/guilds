import type pg from "pg";
import { GLOBAL_SCOPE, GLOBAL_SCOPE_ID, usageDelta, utcMonth } from "../usage.js";
import { type Queryable, stamp } from "./pg.js";

export type UsageCounterRow = {
  scope: string;
  scope_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: string;
  calls: number;
  updated_at: string;
};

export type OrgMonthlyUsageRow = {
  org_id: string;
  month: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: string;
  calls: number;
  studio_builder_runs: number;
  updated_at: string;
};

export async function listUsageCounters(pool: Queryable): Promise<UsageCounterRow[]> {
  const result = await pool.query<UsageCounterRow>(
    `SELECT scope, scope_id, input_tokens, output_tokens,
            cache_read_tokens, cost_usd, calls, updated_at
     FROM usage_counters`,
  );
  return result.rows;
}

export async function getUsage(
  pool: Queryable,
  scope: string,
  scopeId: string,
): Promise<UsageCounterRow | null> {
  const result = await pool.query<UsageCounterRow>(
    `SELECT scope, scope_id, input_tokens, output_tokens,
            cache_read_tokens, cost_usd, calls, updated_at
     FROM usage_counters WHERE scope = $1 AND scope_id = $2`,
    [scope, scopeId],
  );
  return result.rows[0] ?? null;
}

export async function getOrgMonthlyUsage(
  pool: Queryable,
  orgId: string,
  month: string,
): Promise<OrgMonthlyUsageRow | null> {
  const result = await pool.query<OrgMonthlyUsageRow>(
    `SELECT org_id, month, input_tokens, output_tokens, cache_read_tokens,
            cost_usd, calls, studio_builder_runs, updated_at
     FROM org_monthly_usage
     WHERE org_id = $1 AND month = $2`,
    [orgId, month],
  );
  return result.rows[0] ?? null;
}

/**
 * Adds one Studio or Builder generation to this month's count. When `limit` is set, the
 * increment lands only while the count is still below it; `null` means the increment failed
 * the cap (including a limit of 0).
 */
export async function claimMonthlyStudioBuilderRun(
  db: Queryable,
  orgId: string,
  now: Date,
  limit: number | null,
): Promise<number | null> {
  if (limit === 0) {
    return null;
  }
  const result = await db.query<{ studio_builder_runs: number }>(
    `INSERT INTO org_monthly_usage (
       org_id, month, input_tokens, output_tokens, cache_read_tokens,
       cost_usd, calls, studio_builder_runs, updated_at
     )
     VALUES ($1, $2, 0, 0, 0, 0, 0, 1, $3)
     ON CONFLICT (org_id, month) DO UPDATE SET
       studio_builder_runs = org_monthly_usage.studio_builder_runs + 1,
       updated_at = EXCLUDED.updated_at
     WHERE $4::int IS NULL OR org_monthly_usage.studio_builder_runs < $4
     RETURNING studio_builder_runs`,
    [orgId, utcMonth(now), stamp(now), limit],
  );
  const row = result.rows[0] ?? null;
  return row ? row.studio_builder_runs : null;
}

export async function incrementUsage(
  client: pg.PoolClient,
  runId: string,
  metadata: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const delta = usageDelta(metadata);
  if (delta === null) {
    return;
  }
  const owners = await client.query<{ agent_id: string; guild_id: string; org_id: string }>(
    `SELECT a.id AS agent_id, a.guild_id, p.org_id
     FROM runs r
     JOIN agents a ON a.id = r.agent_id
     JOIN guilds p ON p.id = a.guild_id
     WHERE r.id = $1`,
    [runId],
  );
  const owner = owners.rows[0] ?? null;
  if (!owner) {
    return;
  }
  const scopes: Array<[string, string]> = [
    ["agent", owner.agent_id],
    ["guild", owner.guild_id],
    ["org", owner.org_id],
    [GLOBAL_SCOPE, GLOBAL_SCOPE_ID],
  ];
  for (const [scope, scopeId] of scopes) {
    await client.query(
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
  await client.query(
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
      owner.org_id,
      utcMonth(now),
      delta.input_tokens,
      delta.output_tokens,
      delta.cache_read_tokens,
      delta.cost_usd,
      stamp(now),
    ],
  );
}

export async function deleteGuildUsage(client: pg.PoolClient, guildId: string): Promise<void> {
  const agents = await client.query<{ id: string }>(`SELECT id FROM agents WHERE guild_id = $1`, [
    guildId,
  ]);
  const ids = agents.rows.map((row) => row.id);
  await client.query(
    `DELETE FROM usage_counters
     WHERE (scope = 'guild' AND scope_id = $1)
        OR (scope = 'agent' AND scope_id = ANY($2::text[]))`,
    [guildId, ids],
  );
}
