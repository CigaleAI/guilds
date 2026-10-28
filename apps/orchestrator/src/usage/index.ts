import type { AgentRow } from "../db/agents.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import type { GuildRow } from "../db/guilds.js";
import type { OrgRow } from "../db/orgs.js";
import { GLOBAL_SCOPE, GLOBAL_SCOPE_ID } from "../db/usage.js";

/**
 * What a usage row counts: a counter's, a month's, or a coach's conversations', each in its
 * columns' own form; a source without a column counts none of it.
 */
export type UsageSource = Partial<
  Record<"input_tokens" | "output_tokens" | "cache_read_tokens" | "cost_usd" | "calls" | "updated_at", unknown>
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

export function usageFields(row: UsageSource | null | undefined): Record<string, unknown> {
  if (row === null || row === undefined) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      cost_usd: 0.0,
      calls: 0,
      updated_at: null,
    };
  }
  const inputTokens = Number(row.input_tokens || 0);
  const outputTokens = Number(row.output_tokens || 0);
  const cacheRead = Number(row.cache_read_tokens || 0);
  const cost = row.cost_usd;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    total_tokens: inputTokens + outputTokens,
    cost_usd: Number(Number(cost || 0).toFixed(8)),
    calls: Number(row.calls || 0),
    updated_at: formatUpdatedAt(row.updated_at),
  };
}

export function addUsageFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const inputTokens = Number(left.input_tokens || 0) + Number(right.input_tokens || 0);
  const outputTokens = Number(left.output_tokens || 0) + Number(right.output_tokens || 0);
  const cacheRead = Number(left.cache_read_tokens || 0) + Number(right.cache_read_tokens || 0);
  const leftUpdated = left.updated_at;
  const rightUpdated = right.updated_at;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    total_tokens: inputTokens + outputTokens,
    cost_usd: Number((Number(left.cost_usd || 0) + Number(right.cost_usd || 0)).toFixed(8)),
    calls: Number(left.calls || 0) + Number(right.calls || 0),
    updated_at: !leftUpdated ? rightUpdated : !rightUpdated ? leftUpdated : String(leftUpdated) >= String(rightUpdated) ? leftUpdated : rightUpdated,
  };
}

export function subtractUsageFields(
  total: Record<string, unknown>,
  parts: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const summed = parts.reduce((acc, part) => addUsageFields(acc, part), usageFields(null));
  return {
    input_tokens: Math.max(0, Number(total.input_tokens || 0) - Number(summed.input_tokens || 0)),
    output_tokens: Math.max(0, Number(total.output_tokens || 0) - Number(summed.output_tokens || 0)),
    cache_read_tokens: Math.max(0, Number(total.cache_read_tokens || 0) - Number(summed.cache_read_tokens || 0)),
    total_tokens: Math.max(0, Number(total.total_tokens || 0) - Number(summed.total_tokens || 0)),
    cost_usd: Number(Math.max(0, Number(total.cost_usd || 0) - Number(summed.cost_usd || 0)).toFixed(8)),
    calls: Math.max(0, Number(total.calls || 0) - Number(summed.calls || 0)),
    updated_at: total.updated_at ?? null,
  };
}

function hasUsage(fields: Record<string, unknown>): boolean {
  return (
    Number(fields.input_tokens || 0) > 0 ||
    Number(fields.output_tokens || 0) > 0 ||
    Number(fields.cache_read_tokens || 0) > 0 ||
    Number(fields.cost_usd || 0) > 0 ||
    Number(fields.calls || 0) > 0
  );
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

