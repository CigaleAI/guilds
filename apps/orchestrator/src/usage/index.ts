import type { AgentRow, AgentSummaryRow } from "../db/agents.js";
import { formatColumnTimestamp } from "../db/codecs.js";
import type { GuildRow } from "../db/guilds.js";
import type { OrgRow } from "../db/orgs.js";
import { GLOBAL_SCOPE, GLOBAL_SCOPE_ID } from "../db/usage.js";

/**
 * What a usage line counts, as the operator app shows it. The `browser_*` fields count `browse`
 * calls, whose cost is also part of `cost_usd`.
 */
export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** Input plus output; cache reads are counted apart. */
  total_tokens: number;
  cost_usd: number;
  calls: number;
  browser_input_tokens: number;
  browser_output_tokens: number;
  browser_cost_usd: number;
  browser_calls: number;
  updated_at: string | null;
};

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
] as const satisfies ReadonlyArray<keyof UsageTotals>;

/** A field a usage row counts, read from the column of the same name. */
type CountedField = (typeof COUNTED_FIELDS)[number];

/**
 * A counted column as the driver reads it: a `bigint` as a number, a `numeric` (a cost, or a
 * sum of `bigint`s) as its decimal text.
 */
export type UsageCount = number | string;

/**
 * What a usage row counts: a counter's, a month's, or a coach's conversations', each column in
 * its own form, and when it last counted; a source without a column counts none of it.
 */
export type UsageSource = { readonly [F in CountedField]?: UsageCount } & {
  readonly updated_at?: string | null;
};

/** Usage rows by key: a counter's scope key, or an organisation id. */
export type UsageRows = ReadonlyMap<string, UsageSource>;

/** The usage the box has recorded: its counters by scope key, and what the Studio and Builder coaches spent, by organisation. */
export type RecordedUsage = {
  counters: UsageRows;
  studioByOrg?: UsageRows;
  builderByOrg?: UsageRows;
};

/** An organisation as its usage line names it. */
type UsageOrg = Pick<OrgRow, "id" | "name" | "slug">;

/** A guild as the usage tree places it. */
type UsageGuild = Pick<GuildRow, "id" | "name" | "org_id">;

/** An agent's share of its guild's usage. */
export type GuildAgentUsage = UsageTotals & Pick<AgentSummaryRow, "id" | "name" | "avatar_shape" | "avatar_color">;

/** A guild's usage, with each agent's share. */
export type GuildUsage = UsageTotals & Pick<GuildRow, "id" | "name"> & { agents: GuildAgentUsage[] };

/**
 * One organisation's usage by guild and agent, with the Studio coach's, the Builder coach's when
 * it spent anything, and what guilds and agents since deleted spent, when they spent anything.
 */
export type OrgUsage = UsageTotals &
  UsageOrg & {
    studio: UsageTotals;
    builder: UsageTotals | null;
    archived: UsageTotals | null;
    guilds: GuildUsage[];
  };

/** Every organisation's usage, and the server's total. */
export type PlatformUsage = { global: UsageTotals; organisations: OrgUsage[] };

/** An agent's usage, with its home's size against its cap and its machine's against the machine's. */
export type AgentUsage = UsageTotals &
  Pick<AgentRow, "id" | "name" | "guild_id" | "guild_name" | "workspace_mib"> & {
    max_workspace_mib: AgentRow["config"]["max_workspace_mib"];
    machine: {
      id: AgentRow["machine_id"];
      name: AgentRow["machine_name"];
      workspace_mib: AgentRow["machine_workspace_mib"];
      max_workspace_mib: AgentRow["machine_max_workspace_mib"];
    };
  };

export function usageCounterKey(scope: string, scopeId: string): string {
  return `${scope}\0${scopeId}`;
}

/** A counted column's value as a number; 0 when the source has no such column. */
function countedValue(value: UsageCount | undefined): number {
  return Number(value ?? 0);
}

/** A cost in dollars, rounded to the 8 decimal places a cost is recorded with. */
function roundedCost(value: number): number {
  return Number(value.toFixed(8));
}

const NO_USAGE: UsageTotals = {
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

export function usageFields(row: UsageSource | null | undefined): UsageTotals {
  if (row === null || row === undefined) {
    return { ...NO_USAGE };
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
    updated_at: row.updated_at === null || row.updated_at === undefined ? null : formatColumnTimestamp(row.updated_at),
  };
}

/** The later of two times a usage line last counted; a line that never counted has no time. */
function laterUpdate(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left >= right ? left : right;
}

export function addUsageFields(left: UsageTotals, right: UsageTotals): UsageTotals {
  const sum = (key: CountedField) => left[key] + right[key];
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
    updated_at: laterUpdate(left.updated_at, right.updated_at),
  };
}

export function subtractUsageFields(total: UsageTotals, parts: UsageTotals[]): UsageTotals {
  const summed = parts.reduce((acc, part) => addUsageFields(acc, part), usageFields(null));
  const rest = (key: CountedField | "total_tokens") => Math.max(0, total[key] - summed[key]);
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
    updated_at: total.updated_at,
  };
}

function hasUsage(fields: UsageTotals): boolean {
  return COUNTED_FIELDS.some((key) => fields[key] > 0);
}

/** Items by the id of what holds them. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    grouped.set(keyOf(item), [...(grouped.get(keyOf(item)) ?? []), item]);
  }
  return grouped;
}

/** The usage line `recorded` counts for `scope` and `scopeId`. */
function counted(recorded: RecordedUsage, scope: string, scopeId: string): UsageTotals {
  return usageFields(recorded.counters.get(usageCounterKey(scope, scopeId)));
}

/** One organisation's usage, by its `guilds` and the agents in them among `agents`. */
export function orgUsage(
  org: UsageOrg,
  guilds: UsageGuild[],
  agents: AgentSummaryRow[],
  recorded: RecordedUsage,
): OrgUsage {
  const agentsByGuild = groupBy(agents, (agent) => agent.guild_id);
  const orgGuilds = guilds.map((guild) => ({
    id: guild.id,
    name: guild.name,
    ...counted(recorded, "guild", guild.id),
    agents: (agentsByGuild.get(guild.id) ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      avatar_shape: agent.avatar_shape,
      avatar_color: agent.avatar_color,
      ...counted(recorded, "agent", agent.id),
    })),
  }));
  const orgFields = counted(recorded, "org", org.id);
  const studio = usageFields(recorded.studioByOrg?.get(org.id));
  const builder = usageFields(recorded.builderByOrg?.get(org.id));
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
}

/** Every organisation's usage by guild and agent, and the server's total. */
export function usageTree(
  args: { orgs: UsageOrg[]; guilds: UsageGuild[]; agents: AgentSummaryRow[] } & RecordedUsage,
): PlatformUsage {
  const guildsByOrg = groupBy(args.guilds, (guild) => guild.org_id);
  const agentsByGuild = groupBy(args.agents, (agent) => agent.guild_id);
  return {
    global: counted(args, GLOBAL_SCOPE, GLOBAL_SCOPE_ID),
    organisations: args.orgs.map((org) => {
      const guilds = guildsByOrg.get(org.id) ?? [];
      const agents = guilds.flatMap((guild) => agentsByGuild.get(guild.id) ?? []);
      return orgUsage(org, guilds, agents, args);
    }),
  };
}
