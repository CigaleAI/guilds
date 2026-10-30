import type { AgentRow } from "../db/agents.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import type { GuildRow } from "../db/guilds.js";
import type { OrgRow } from "../db/orgs.js";
import { GLOBAL_SCOPE, GLOBAL_SCOPE_ID } from "../db/usage.js";

/**
 * What a usage row counts: a counter's, a month's, or a coach's conversations', each in its
 * columns' own form; a source without a column counts none of it. The `browser_*` columns count
 * `browse` calls, whose cost is also part of `cost_usd`.
 */
export type UsageSource = Partial<
  Record<
    | "input_tokens"
    | "output_tokens"
    | "cache_read_tokens"
    | "cost_usd"
    | "calls"
    | "browser_input_tokens"
    | "browser_output_tokens"
    | "browser_cost_usd"
    | "browser_calls"
    | "updated_at",
    unknown
  >
>;

/** Usage rows by key: a counter's scope key, or an organisation id. */
export type UsageRows = Map<string, UsageSource> | Record<string, UsageSource>;

export function usageCounterKey(scope: string, scopeId: string): string {
  return `${scope}\0${scopeId}`;
}

function formatUpdatedAt(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return formatColumnTimestamp(value);
  }
  if (value instanceof Date) {
    return formatColumnTimestamp(value.toISOString());
  }
  if (value && typeof value === "object" && "toISOString" in value && typeof value.toISOString === "function") {
    return formatColumnTimestamp(String(value.toISOString()));
  }
  return value;
}

/** A counted column's value as a number; 0 when the column is absent or null. */
function countedValue(value: unknown): number {
  return Number(value || 0);
}

/** A cost in dollars, rounded to the 8 decimal places a cost is recorded with. */
function roundedCost(value: number): number {
  return Number(value.toFixed(8));
}

export function usageFields(row: UsageSource | null | undefined): Record<string, unknown> {
  if (row === null || row === undefined) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      cost_usd: 0.0,
      calls: 0,
      browser_input_tokens: 0,
      browser_output_tokens: 0,
      browser_cost_usd: 0.0,
      browser_calls: 0,
      updated_at: null,
    };
  }
  const inputTokens = countedValue(row.input_tokens);
  const outputTokens = countedValue(row.output_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: countedValue(row.cache_read_tokens),
    total_tokens: inputTokens + outputTokens,
    cost_usd: roundedCost(countedValue(row.cost_usd)),
    calls: countedValue(row.calls),
    browser_input_tokens: countedValue(row.browser_input_tokens),
    browser_output_tokens: countedValue(row.browser_output_tokens),
    browser_cost_usd: roundedCost(countedValue(row.browser_cost_usd)),
    browser_calls: countedValue(row.browser_calls),
    updated_at: formatUpdatedAt(row.updated_at),
  };
}

export function addUsageFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const sum = (key: string) => countedValue(left[key]) + countedValue(right[key]);
  const leftUpdated = left.updated_at;
  const rightUpdated = right.updated_at;
  return {
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    total_tokens: sum("input_tokens") + sum("output_tokens"),
    cost_usd: roundedCost(sum("cost_usd")),
    calls: sum("calls"),
    browser_input_tokens: sum("browser_input_tokens"),
    browser_output_tokens: sum("browser_output_tokens"),
    browser_cost_usd: roundedCost(sum("browser_cost_usd")),
    browser_calls: sum("browser_calls"),
    updated_at: !leftUpdated ? rightUpdated : !rightUpdated ? leftUpdated : String(leftUpdated) >= String(rightUpdated) ? leftUpdated : rightUpdated,
  };
}

export function subtractUsageFields(
  total: Record<string, unknown>,
  parts: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const summed = parts.reduce((acc, part) => addUsageFields(acc, part), usageFields(null));
  const rest = (key: string) => Math.max(0, countedValue(total[key]) - countedValue(summed[key]));
  return {
    input_tokens: rest("input_tokens"),
    output_tokens: rest("output_tokens"),
    cache_read_tokens: rest("cache_read_tokens"),
    total_tokens: rest("total_tokens"),
    cost_usd: roundedCost(rest("cost_usd")),
    calls: rest("calls"),
    browser_input_tokens: rest("browser_input_tokens"),
    browser_output_tokens: rest("browser_output_tokens"),
    browser_cost_usd: roundedCost(rest("browser_cost_usd")),
    browser_calls: rest("browser_calls"),
    updated_at: total.updated_at ?? null,
  };
}

/** The fields whose being above zero means a usage line counted something. */
const COUNTED_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cost_usd",
  "calls",
  "browser_input_tokens",
  "browser_output_tokens",
  "browser_cost_usd",
  "browser_calls",
];

function hasUsage(fields: Record<string, unknown>): boolean {
  return COUNTED_FIELDS.some((key) => countedValue(fields[key]) > 0);
}

/** The row `key` has in `rows`, when the rows were given. */
function usageRow(rows: UsageRows | undefined, key: string): UsageSource | undefined {
  if (!rows) {
    return undefined;
  }
  return rows instanceof Map ? rows.get(key) : rows[key];
}

/** Items by the id of what holds them. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    grouped.set(keyOf(item), [...(grouped.get(keyOf(item)) ?? []), item]);
  }
  return grouped;
}

export function usageTree(args: {
  orgs: Array<Pick<OrgRow, "id" | "name" | "slug">>;
  guilds: Array<Pick<GuildRow, "id" | "name" | "org_id">>;
  agents: Array<Pick<AgentRow, "id" | "name" | "guild_id" | "avatar_shape" | "avatar_color">>;
  counters: UsageRows;
  studioByOrg?: UsageRows;
  builderByOrg?: UsageRows;
}): Record<string, unknown> {
  const lookup = (scope: string, scopeId: string) => usageRow(args.counters, usageCounterKey(scope, scopeId));
  const agentsByGuild = groupBy(args.agents, (agent) => agent.guild_id);
  const guildsByOrg = groupBy(args.guilds, (guild) => guild.org_id);
  const organisations = args.orgs.map((org) => {
    const orgGuilds = (guildsByOrg.get(org.id) ?? []).map((guild) => ({
      id: guild.id,
      name: guild.name,
      ...usageFields(lookup("guild", guild.id)),
      agents: (agentsByGuild.get(guild.id) ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        avatar_shape: agent.avatar_shape,
        avatar_color: agent.avatar_color,
        ...usageFields(lookup("agent", agent.id)),
      })),
    }));
    const orgFields = usageFields(lookup("org", org.id));
    const studio = usageFields(usageRow(args.studioByOrg, org.id));
    const builder = usageFields(usageRow(args.builderByOrg, org.id));
    const liveGuilds = orgGuilds.reduce((acc, guild) => addUsageFields(acc, guild), usageFields(null));
    const archived = subtractUsageFields(orgFields, [liveGuilds, studio, builder]);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      ...orgFields,
      studio,
      builder: hasUsage(builder) ? builder : null,
      archived: hasUsage(archived) ? archived : null,
      guilds: orgGuilds,
    };
  });
  return {
    global: usageFields(lookup(GLOBAL_SCOPE, GLOBAL_SCOPE_ID)),
    organisations,
  };
}

