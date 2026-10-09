import { formatColumnTimestamp } from "./db/codecs.js";

export const GLOBAL_SCOPE = "global";
export const GLOBAL_SCOPE_ID = "";

export type UsageDelta = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
};

/** The UTC month a usage row is counted under, as `YYYY-MM`. */
export function utcMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function usageCounterKey(scope: string, scopeId: string): string {
  return `${scope}\0${scopeId}`;
}

function rowGet(row: unknown, key: string): unknown {
  if (row && typeof row === "object" && !Array.isArray(row) && key in row) {
    return (row as Record<string, unknown>)[key];
  }
  return undefined;
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

export function usageDelta(metadata: Record<string, unknown>): UsageDelta | null {
  const usage = metadata.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const record = usage as Record<string, unknown>;
  return {
    input_tokens: Number(record.input_tokens || 0),
    output_tokens: Number(record.output_tokens || 0),
    cache_read_tokens: Number(record.cache_read_tokens || 0),
    cost_usd: Number(metadata.cost_usd || 0),
  };
}

export function messageCostUsd(metadata: Record<string, unknown>): number | null {
  const delta = usageDelta(metadata);
  return delta === null ? null : delta.cost_usd;
}

export function usageFields(row: unknown): Record<string, unknown> {
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
  const inputTokens = Number(rowGet(row, "input_tokens") || 0);
  const outputTokens = Number(rowGet(row, "output_tokens") || 0);
  const cacheRead = Number(rowGet(row, "cache_read_tokens") || 0);
  const cost = rowGet(row, "cost_usd");
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    total_tokens: inputTokens + outputTokens,
    cost_usd: Number(Number(cost || 0).toFixed(8)),
    calls: Number(rowGet(row, "calls") || 0),
    updated_at: formatUpdatedAt(rowGet(row, "updated_at")),
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

export function usageTree(args: {
  orgs: unknown[];
  guilds: unknown[];
  agents: unknown[];
  counters: Map<string, unknown> | Record<string, unknown>;
  studioByOrg?: Map<string, unknown> | Record<string, unknown>;
}): Record<string, unknown> {
  const lookup = (scope: string, scopeId: string): unknown => {
    const key = usageCounterKey(scope, scopeId);
    if (args.counters instanceof Map) {
      return args.counters.get(key);
    }
    return args.counters[key];
  };
  const lookupStudio = (orgId: string): unknown => {
    if (!args.studioByOrg) {
      return null;
    }
    if (args.studioByOrg instanceof Map) {
      return args.studioByOrg.get(orgId);
    }
    return args.studioByOrg[orgId];
  };
  const agentsByGuild = new Map<string, unknown[]>();
  for (const agent of args.agents) {
    const guildId = String(rowGet(agent, "guild_id") ?? "");
    const list = agentsByGuild.get(guildId) ?? [];
    list.push(agent);
    agentsByGuild.set(guildId, list);
  }
  const guildsByOrg = new Map<string, unknown[]>();
  for (const guild of args.guilds) {
    const orgId = String(rowGet(guild, "org_id") ?? "");
    const list = guildsByOrg.get(orgId) ?? [];
    list.push(guild);
    guildsByOrg.set(orgId, list);
  }
  const organisations = [];
  for (const org of args.orgs) {
    const orgId = String(rowGet(org, "id") ?? "");
    const orgGuilds = [];
    for (const guild of guildsByOrg.get(orgId) ?? []) {
      const guildId = String(rowGet(guild, "id") ?? "");
      orgGuilds.push({
        id: guildId,
        name: rowGet(guild, "name"),
        ...usageFields(lookup("guild", guildId)),
        agents: (agentsByGuild.get(guildId) ?? []).map((agent) => ({
          id: rowGet(agent, "id"),
          name: rowGet(agent, "name"),
          avatar_shape: rowGet(agent, "avatar_shape") || "teardrop",
          avatar_color: rowGet(agent, "avatar_color") || "#7c5cff",
          ...usageFields(lookup("agent", String(rowGet(agent, "id") ?? ""))),
        })),
      });
    }
    const orgFields = usageFields(lookup("org", orgId));
    const studio = usageFields(lookupStudio(orgId));
    const liveGuilds = orgGuilds.reduce((acc, guild) => addUsageFields(acc, usageFields(guild)), usageFields(null));
    const archived = subtractUsageFields(orgFields, [liveGuilds, studio]);
    organisations.push({
      id: orgId,
      name: rowGet(org, "name"),
      slug: rowGet(org, "slug"),
      ...orgFields,
      studio,
      archived: hasUsage(archived) ? archived : null,
      guilds: orgGuilds,
    });
  }
  return {
    global: usageFields(lookup(GLOBAL_SCOPE, GLOBAL_SCOPE_ID)),
    organisations,
  };
}
