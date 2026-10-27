/** Agents, their runs and messages, the guild group chat, routines, and issues. */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  type PgTableExtraConfigValue,
  smallint,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";
import { guilds, machines, orgs, users } from "./organisations.js";

/**
 * A random wake window: every day, between `start` and `end` local time in
 * `timezone`, the routine wakes at random instants, aiming for `max_wakes`
 * wake-ups. `end` earlier than `start` spans midnight.
 */
export type WakeWindow = {
  timezone: string;
  start: string;
  end: string;
  max_wakes: number;
};

/** The coding harnesses a coding agent delegates code work to. */
export const HARNESSES = ["claude-code", "codex", "cursor", "antigravity"] as const;
export type Harness = (typeof HARNESSES)[number];

/** The reasoning efforts a harness can run a model at, lowest first. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];

export const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** What `agents.harness_logins` records per harness: when a check last found a login, and whose it is. */
export type HarnessLogin = { seen_at: string | null; account: string | null };
export type HarnessLogins = Partial<Record<Harness, HarnessLogin>>;

/** An agent's settings, as `agents.config` stores them: every key present. */
export type AgentConfig = {
  model: string;
  temperature: number;
  max_tokens: number;
  max_steps: number;
  max_tool_calls: number;
  max_input_tokens: number;
  keep_tool_result_generations: number;
  max_scripts: number;
  max_workspace_mib: number;
  browser: boolean;
  browser_language: string;
  coding: boolean;
  harness: Harness | null;
  /** The model the harness runs; null leaves it to the harness's subscription. */
  harness_model: string | null;
  /** The effort the harness runs its model at; null leaves it to the harness. */
  harness_effort: Effort | null;
  /**
   * Variable names the agent's commands see beside the secrets reaching it, each holding the
   * value of the secret it names: `{ CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" }`. An alias wins over
   * a secret of its own name.
   */
  secret_aliases: Record<string, string>;
  scripting: boolean;
  memory: boolean;
  thinking_level: ThinkingLevel;
};

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    guild_id: text("guild_id").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<AgentConfig>().notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    group_chat_delivered_through: bigint("group_chat_delivered_through", {
      mode: "number",
    })
      .notNull()
      .default(0),
    focus: text("focus").notNull().default(""),
    wake_triggers: text("wake_triggers").notNull().default(""),
    avatar_shape: text("avatar_shape").notNull().default("teardrop"),
    avatar_color: text("avatar_color").notNull().default("#7c5cff"),
    org_id: text("org_id").notNull(),
    task: text("task").notNull(),
    task_version: integer("task_version").notNull().default(1),
    task_hash: text("task_hash").notNull(),
    task_updated_at: timestamptz("task_updated_at").notNull(),
    workspace_mib: integer("workspace_mib"),
    machine_id: text("machine_id").notNull(),
    machine_slot: smallint("machine_slot").notNull(),
    harness_logins: jsonb("harness_logins").$type<HarnessLogins>().notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    unique("agents_name_key").on(table.name),
    unique("agents_org_id_id_unique").on(table.org_id, table.id),
    unique("agents_machine_slot_key").on(table.machine_id, table.machine_slot),
    check("agents_machine_slot_range", sql`${table.machine_slot} >= 0 AND ${table.machine_slot} < 32`),
    foreignKey({
      columns: [table.org_id, table.machine_id],
      foreignColumns: [machines.org_id, machines.id],
      name: "agents_machine_fkey",
    }).onDelete("restrict"),
    index("agents_by_machine").on(table.machine_id),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "agents_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "agents_org_id_fkey",
    }),
    index("agents_by_group_delivery").on(
      table.guild_id,
      table.group_chat_delivered_through,
      table.created_at,
    ),
    index("agents_by_guild").on(table.guild_id, table.updated_at),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agent_id: text("agent_id").notNull(),
    status: text("status", { enum: ["active", "completed"] }).notNull(),
    config_snapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),
    errors: jsonb("errors").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    system_prompt_hash: text("system_prompt_hash"),
    task_prompt_hash: text("task_prompt_hash"),
    kind: text("kind", { enum: ["direct", "group", "schedule"] }).notNull().default("direct"),
    group_chat_through_seq: bigint("group_chat_through_seq", { mode: "number" }),
    memory_prompt_hash: text("memory_prompt_hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    org_id: text("org_id").notNull(),
    schedule_id: text("schedule_id"),
    wake_group_message_id: bigint("wake_group_message_id", { mode: "number" }),
    started_by_user_id: text("started_by_user_id"),
  },
  // Typed, since runs and group_messages reference each other.
  (table): PgTableExtraConfigValue[] => [
    check("runs_kind_valid", sql`${table.kind} IN ('direct', 'group', 'schedule')`),
    check("runs_status_valid", sql`${table.status} IN ('active', 'completed')`),
    foreignKey({
      columns: [table.agent_id],
      foreignColumns: [agents.id],
      name: "runs_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "runs_org_id_fkey",
    }),
    foreignKey({
      columns: [table.wake_group_message_id],
      foreignColumns: [groupMessages.id],
      name: "runs_wake_group_message_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.started_by_user_id],
      foreignColumns: [users.id],
      name: "runs_started_by_user_id_fkey",
    }).onDelete("set null"),
    index("runs_by_agent").on(table.agent_id, table.updated_at),
    index("runs_by_org").on(table.org_id),
    index("runs_by_agent_task_hash").on(table.agent_id, table.task_prompt_hash),
    index("runs_by_schedule").on(table.schedule_id, table.created_at),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    run_id: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    created_at: timestamptz("created_at").notNull(),
    cost_usd: numeric("cost_usd"),
  },
  (table) => [
    unique("messages_run_id_seq_key").on(table.run_id, table.seq),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [runs.id],
      name: "messages_run_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const groupMessages = pgTable(
  "group_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    guild_id: text("guild_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    author_type: text("author_type", { enum: ["user", "agent"] }).notNull(),
    author_name: text("author_name").notNull(),
    author_agent_id: text("author_agent_id"),
    source_run_id: text("source_run_id"),
    content: text("content").notNull(),
    created_at: timestamptz("created_at").notNull(),
    tagged_names: jsonb("tagged_names").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tagged_agent_ids: jsonb("tagged_agent_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tagged_user_ids: jsonb("tagged_user_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    author_user_id: text("author_user_id"),
  },
  (table) => [
    unique("group_messages_guild_id_seq_key").on(table.guild_id, table.seq),
    check("group_messages_author_type_check", sql`${table.author_type} IN ('user', 'agent')`),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "group_messages_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.author_agent_id],
      foreignColumns: [agents.id],
      name: "group_messages_author_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.source_run_id],
      foreignColumns: [runs.id],
      name: "group_messages_source_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.author_user_id],
      foreignColumns: [users.id],
      name: "group_messages_author_user_id_fkey",
    }).onDelete("set null"),
  ],
);

export const groupChatReads = pgTable(
  "group_chat_reads",
  {
    guild_id: text("guild_id").notNull(),
    user_id: text("user_id").notNull(),
    seen_through_seq: bigint("seen_through_seq", { mode: "number" }).notNull().default(0),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guild_id, table.user_id] }),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "group_chat_reads_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_id],
      foreignColumns: [users.id],
      name: "group_chat_reads_user_id_fkey",
    }).onDelete("cascade"),
    index("group_chat_reads_by_user").on(table.user_id),
  ],
);

export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    agent_id: text("agent_id").notNull(),
    instruction: text("instruction").notNull(),
    next_run_at: timestamptz("next_run_at").notNull(),
    last_run_at: timestamptz("last_run_at"),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    cron: text("cron"),
    paused: boolean("paused").notNull().default(false),
    description: text("description").notNull().default(""),
    wake_window: jsonb("wake_window").$type<WakeWindow>(),
    window_fires: integer("window_fires").notNull().default(0),
  },
  (table) => [
    check("schedules_timing_check", sql`(${table.cron} IS NULL) <> (${table.wake_window} IS NULL)`),
    foreignKey({
      columns: [table.agent_id],
      foreignColumns: [agents.id],
      name: "schedules_agent_id_fkey",
    }).onDelete("cascade"),
    index("schedules_by_agent").on(table.agent_id, table.created_at),
    index("schedules_due").on(table.next_run_at),
  ],
);

export const guildIssues = pgTable(
  "guild_issues",
  {
    id: text("id").primaryKey(),
    guild_id: text("guild_id").notNull(),
    org_id: text("org_id").notNull(),
    agent_id: text("agent_id"),
    agent_name: text("agent_name").notNull(),
    run_id: text("run_id"),
    kind: text("kind", { enum: ["tool_failure", "truncated", "api", "other"] }).notNull(),
    severity: text("severity", { enum: ["low", "medium", "high"] }).notNull(),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    summary: text("summary").notNull(),
    detail: text("detail").notNull(),
    tool_name: text("tool_name"),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    resolved_at: timestamptz("resolved_at"),
    resolved_by: text("resolved_by"),
  },
  (table) => [
    check(
      "guild_issues_kind_check",
      sql`${table.kind} IN ('tool_failure', 'truncated', 'api', 'other')`,
    ),
    check(
      "guild_issues_severity_check",
      sql`${table.severity} IN ('low', 'medium', 'high')`,
    ),
    check(
      "guild_issues_status_check",
      sql`${table.status} IN ('open', 'resolved')`,
    ),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "guild_issues_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "guild_issues_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agent_id],
      foreignColumns: [agents.id],
      name: "guild_issues_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [runs.id],
      name: "guild_issues_run_id_fkey",
    }).onDelete("set null"),
    index("guild_issues_by_guild").on(table.guild_id, table.status, table.created_at),
  ],
);
