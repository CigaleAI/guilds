/** Usage counters and each organisation's monthly usage. */
import {
  bigint,
  check,
  foreignKey,
  numeric,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { orgs } from "./organisations.js";

export const usageCounters = pgTable(
  "usage_counters",
  {
    scope: text("scope", { enum: ["global", "org", "guild", "agent"] }).notNull(),
    scope_id: text("scope_id").notNull(),
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cache_read_tokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cost_usd: numeric("cost_usd").notNull().default("0"),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.scope_id] }),
    check("usage_counters_scope_check", sql`${table.scope} IN ('global', 'org', 'guild', 'agent')`),
  ],
);

export const orgMonthlyUsage = pgTable(
  "org_monthly_usage",
  {
    org_id: text("org_id").notNull(),
    month: text("month").notNull(),
    input_tokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    output_tokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cache_read_tokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cost_usd: numeric("cost_usd").notNull().default("0"),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    studio_builder_runs: bigint("studio_builder_runs", { mode: "number" }).notNull().default(0),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org_id, table.month] }),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "org_monthly_usage_org_id_fkey",
    }).onDelete("cascade"),
  ],
);
