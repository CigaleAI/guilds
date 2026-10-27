import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  numeric,
  pgTable,
  type PgTableExtraConfigValue,
  smallint,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Overrides } from "../../connectors/load.js";
import type { Manifest } from "../../connectors/manifest.js";
import type { WakeWindow } from "../../schedules/window.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    image: text("image"),
    email: text("email"),
    timezone: text("timezone"),
    color: text("color"),
  },
  (table) => [
    unique("users_name_key").on(table.name),
    check("users_color_hex", sql`${table.color} IS NULL OR ${table.color} ~ '^#[0-9a-f]{6}$'`),
    uniqueIndex("users_email_lower_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
  ],
);

export const orgs = pgTable(
  "orgs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    /** The organisation's default model, `{provider}/{model}`, or null while none is named. */
    default_model: text("default_model"),
  },
  (table) => [unique("orgs_slug_key").on(table.slug)],
);

export const orgMembers = pgTable(
  "org_members",
  {
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org_id, table.user_id] }),
    check(
      "org_members_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member')`,
    ),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "org_members_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.user_id],
      foreignColumns: [users.id],
      name: "org_members_user_id_fkey",
    }).onDelete("cascade"),
    index("org_members_by_user").on(table.user_id),
  ],
);

export const guilds = pgTable(
  "guilds",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    group_chat_seq: bigint("group_chat_seq", { mode: "number" }).notNull().default(0),
    group_agent_message_count: integer("group_agent_message_count").notNull().default(0),
    group_agent_message_limit: integer("group_agent_message_limit").notNull().default(200),
    group_chat_errors: jsonb("group_chat_errors").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    group_chat_cleared_at: timestamptz("group_chat_cleared_at"),
    about: text("about").notNull().default(""),
    org_id: text("org_id").notNull(),
    visibility: text("visibility", { enum: ["org", "private"] }).notNull().default("org"),
    routines_enabled: boolean("routines_enabled").notNull().default(true),
    description: text("description").notNull().default(""),
    max_agents: integer("max_agents").notNull().default(15),
    git_author_email: text("git_author_email").notNull().default(""),
  },
  (table) => [
    unique("guilds_org_name_unique").on(table.org_id, table.name),
    unique("guilds_org_id_id_unique").on(table.org_id, table.id),
    check("group_agent_message_limit_positive", sql`${table.group_agent_message_limit} > 0`),
    check("guilds_max_agents_positive", sql`${table.max_agents} > 0`),
    check("guilds_visibility_check", sql`${table.visibility} IN ('org', 'private')`),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "guilds_org_id_fkey",
    }),
    index("guilds_by_org").on(table.org_id),
  ],
);

export const guildOperators = pgTable(
  "guild_operators",
  {
    org_id: text("org_id").notNull(),
    guild_id: text("guild_id").notNull(),
    user_id: text("user_id").notNull(),
    role: text("role", { enum: ["admin", "operator"] }).notNull(),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guild_id, table.user_id] }),
    check("guild_operators_role_check", sql`${table.role} IN ('admin', 'operator')`),
    foreignKey({
      columns: [table.org_id, table.guild_id],
      foreignColumns: [guilds.org_id, guilds.id],
      name: "guild_operators_guild_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.org_id, table.user_id],
      foreignColumns: [orgMembers.org_id, orgMembers.user_id],
      name: "guild_operators_member_fkey",
    }).onDelete("cascade"),
    index("guild_operators_by_user").on(table.user_id),
  ],
);

export const machines = pgTable(
  "machines",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    name: text("name").notNull(),
    box: text("box", { enum: ["standard", "code", "custom"] }).notNull(),
    cpu: numeric("cpu"),
    memory_mib: integer("memory_mib"),
    max_workspace_mib: integer("max_workspace_mib").notNull().default(10240),
    workspace_mib: integer("workspace_mib"),
    harnesses: text("harnesses").array(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    unique("machines_org_id_name_key").on(table.org_id, table.name),
    unique("machines_org_id_id_unique").on(table.org_id, table.id),
    check("machines_box_check", sql`${table.box} IN ('standard', 'code', 'custom')`),
    check(
      "machines_size_check",
      sql`(${table.box} = 'custom' AND ${table.cpu} IS NOT NULL AND ${table.memory_mib} IS NOT NULL) OR (${table.box} <> 'custom' AND ${table.cpu} IS NULL AND ${table.memory_mib} IS NULL)`,
    ),
    check("machines_max_workspace_mib_positive", sql`${table.max_workspace_mib} > 0`),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "machines_org_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    guild_id: text("guild_id").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
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
    harness_logins: jsonb("harness_logins").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
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

export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    rotated_at: timestamptz("rotated_at").notNull(),
    description: text("description").notNull(),
    org_id: text("org_id").notNull(),
    org_wide: boolean("org_wide").notNull().default(false),
    created_by_user_id: text("created_by_user_id"),
    created_by_agent_id: text("created_by_agent_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "secrets_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.created_by_user_id],
      foreignColumns: [users.id],
      name: "secrets_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.created_by_agent_id],
      foreignColumns: [agents.id],
      name: "secrets_created_by_agent_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("secrets_org_name_unique").on(table.org_id, table.name),
  ],
);

export const secretGrants = pgTable(
  "secret_grants",
  {
    secret_id: text("secret_id").notNull(),
    guild_id: text("guild_id"),
    agent_id: text("agent_id"),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "secret_grants_one_target",
      sql`(${table.guild_id} IS NULL) <> (${table.agent_id} IS NULL)`,
    ),
    foreignKey({
      columns: [table.secret_id],
      foreignColumns: [secrets.id],
      name: "secret_grants_secret_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "secret_grants_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agent_id],
      foreignColumns: [agents.id],
      name: "secret_grants_agent_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("secret_grants_guild_unique")
      .on(table.secret_id, table.guild_id)
      .where(sql`${table.guild_id} IS NOT NULL`),
    uniqueIndex("secret_grants_agent_unique")
      .on(table.secret_id, table.agent_id)
      .where(sql`${table.agent_id} IS NOT NULL`),
    index("secret_grants_by_guild").on(table.guild_id),
    index("secret_grants_by_agent").on(table.agent_id),
  ],
);

export const connectors = pgTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    tool_prefix: text("tool_prefix").notNull(),
    owner_org_id: text("owner_org_id"),
    manifest: jsonb("manifest").$type<Manifest>().notNull(),
    source: text("source", { enum: ["core", "registry", "local"] }).notNull(),
    version: text("version").notNull().default(""),
    verified: boolean("verified").notNull().default(false),
    experimental: boolean("experimental").notNull().default(false),
    publisher: text("publisher").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    oauth_client: jsonb("oauth_client"),
    overrides: jsonb("overrides").$type<Overrides>().notNull().default(sql`'{}'::jsonb`),
    installed_at: timestamptz("installed_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check("connectors_source_check", sql`${table.source} IN ('core', 'registry', 'local')`),
    foreignKey({
      columns: [table.owner_org_id],
      foreignColumns: [orgs.id],
      name: "connectors_owner_org_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("connectors_tool_prefix_key").on(table.tool_prefix),
    uniqueIndex("connectors_platform_slug_key")
      .on(table.slug)
      .where(sql`${table.owner_org_id} IS NULL`),
    uniqueIndex("connectors_org_slug_key")
      .on(table.owner_org_id, table.slug)
      .where(sql`${table.owner_org_id} IS NOT NULL`),
  ],
);

export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    mcp_server_id: text("mcp_server_id").notNull(),
    owner_scope: text("owner_scope", { enum: ["platform", "org", "guild", "agent"] }).notNull(),
    owner_id: text("owner_id"),
    guild_id: text("guild_id"),
    agent_id: text("agent_id"),
    account_hint: text("account_hint").notNull().default(""),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    rotated_at: timestamptz("rotated_at").notNull(),
    status: text("status", { enum: ["pending", "connected", "disconnected"] }).notNull().default("pending"),
    oauth_state: text("oauth_state"),
    org_id: text("org_id"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    check(
      "mcp_connections_owner_scope_check",
      sql`${table.owner_scope} IN ('platform', 'org', 'guild', 'agent')`,
    ),
    check(
      "mcp_connections_status_check",
      sql`${table.status} IN ('pending', 'connected', 'disconnected')`,
    ),
    foreignKey({
      columns: [table.mcp_server_id],
      foreignColumns: [connectors.id],
      name: "mcp_connections_mcp_server_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agent_id],
      foreignColumns: [agents.id],
      name: "mcp_connections_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "mcp_connections_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "mcp_connections_guild_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("mcp_connections_oauth_state")
      .on(table.oauth_state)
      .where(sql`${table.oauth_state} IS NOT NULL`),
    uniqueIndex("mcp_connections_platform_unique")
      .on(table.mcp_server_id)
      .where(sql`${table.owner_scope} = 'platform'`),
    uniqueIndex("mcp_connections_scoped_unique")
      .on(table.mcp_server_id, table.owner_scope, table.owner_id)
      .where(sql`${table.owner_id} IS NOT NULL`),
    unique("mcp_connections_id_server_key").on(table.id, table.mcp_server_id),
  ],
);

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: text("id").primaryKey(),
    connection_id: text("connection_id").notNull(),
    mcp_server_id: text("mcp_server_id").notNull(),
    remote_name: text("remote_name").notNull(),
    namespaced_name: text("namespaced_name").notNull(),
    description: text("description").notNull().default(""),
    input_schema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    listed_at: timestamptz("listed_at").notNull(),
    read_only_hint: boolean("read_only_hint"),
    destructive_hint: boolean("destructive_hint"),
  },
  (table) => [
    unique("mcp_tools_connection_id_namespaced_name_key").on(
      table.connection_id,
      table.namespaced_name,
    ),
    foreignKey({
      columns: [table.connection_id],
      foreignColumns: [mcpConnections.id],
      name: "mcp_tools_connection_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connection_id, table.mcp_server_id],
      foreignColumns: [mcpConnections.id, mcpConnections.mcp_server_id],
      name: "mcp_tools_connection_server_fkey",
    }).onDelete("cascade"),
    index("mcp_tools_by_connection").on(table.connection_id),
  ],
);

export const connectorCalls = pgTable(
  "connector_calls",
  {
    org_id: text("org_id").notNull(),
    connector_id: text("connector_id").notNull(),
    month: text("month").notNull(),
    calls: integer("calls").notNull().default(0),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org_id, table.connector_id, table.month], name: "connector_calls_pkey" }),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "connector_calls_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connector_id],
      foreignColumns: [connectors.id],
      name: "connector_calls_connector_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const bindings = pgTable(
  "bindings",
  {
    id: text("id").primaryKey(),
    catalog_kind: text("catalog_kind", { enum: ["native_tool", "mcp", "mcp_tool"] }).notNull(),
    catalog_id: text("catalog_id").notNull(),
    scope: text("scope", { enum: ["platform", "org", "guild", "agent"] }).notNull(),
    scope_id: text("scope_id"),
    guild_id: text("guild_id"),
    agent_id: text("agent_id"),
    enabled: boolean("enabled").notNull(),
    connection_id: text("connection_id"),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    org_id: text("org_id"),
  },
  (table) => [
    check(
      "bindings_catalog_kind_check",
      sql`${table.catalog_kind} IN ('native_tool', 'mcp', 'mcp_tool')`,
    ),
    check("bindings_scope_check", sql`${table.scope} IN ('platform', 'org', 'guild', 'agent')`),
    foreignKey({
      columns: [table.agent_id],
      foreignColumns: [agents.id],
      name: "bindings_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connection_id],
      foreignColumns: [mcpConnections.id],
      name: "bindings_connection_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "bindings_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "bindings_guild_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("bindings_platform_unique")
      .on(table.catalog_kind, table.catalog_id)
      .where(sql`${table.scope} = 'platform'`),
    uniqueIndex("bindings_scoped_unique")
      .on(table.catalog_kind, table.catalog_id, table.scope, table.scope_id)
      .where(sql`${table.scope_id} IS NOT NULL`),
  ],
);

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

export const orgModelProviders = pgTable(
  "org_model_providers",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    provider: text("provider").notNull(),
    ciphertext: bytea("ciphertext"),
    nonce: bytea("nonce"),
    key_hint: text("key_hint"),
    /** The chosen model ids, `{provider}/{model}`, the pickers offer. */
    models: text("models").array().notNull().default(sql`'{}'::text[]`),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "org_model_providers_org_id_fkey",
    }).onDelete("cascade"),
    unique("org_model_providers_org_provider_unique").on(table.org_id, table.provider),
  ],
);

/** A store integration's values, encrypted under the master key; one row per integration id. */
export const instanceKeys = pgTable(
  "instance_keys",
  {
    integration: text("integration").primaryKey(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    set_by_user_id: text("set_by_user_id"),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.set_by_user_id],
      foreignColumns: [users.id],
      name: "instance_keys_set_by_user_id_fkey",
    }).onDelete("set null"),
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

export const artifactCollections = pgTable(
  "artifact_collections",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    guild_id: text("guild_id"),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    columns: json("columns").$type<unknown[]>().notNull().default(sql`'[]'::json`),
    next_id: integer("next_id").notNull().default(1),
    created_by_type: text("created_by_type").notNull(),
    created_by_id: text("created_by_id").notNull(),
    created_by_name: text("created_by_name").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    deleted_at: timestamptz("deleted_at"),
  },
  (table) => [
    check("artifact_collections_columns_array", sql`json_typeof(${table.columns}) = 'array'`),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "artifact_collections_org_id_fkey",
    }),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "artifact_collections_guild_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("artifact_collections_org_name")
      .on(table.org_id, table.name)
      .where(sql`${table.deleted_at} IS NULL`),
    index("artifact_collections_by_guild").on(table.guild_id),
  ],
);

export const artifactAccess = pgTable(
  "artifact_access",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    target_kind: text("target_kind", { enum: ["note", "collection", "file"] }).notNull(),
    target_id: text("target_id").notNull(),
    subject_type: text("subject_type", { enum: ["org", "guild", "agent"] }).notNull(),
    subject_id: text("subject_id").notNull(),
    mode: text("mode", { enum: ["read", "write", "none"] }).notNull(),
    created_by_type: text("created_by_type").notNull(),
    created_by_id: text("created_by_id").notNull(),
    created_by_name: text("created_by_name").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_by_type: text("updated_by_type").notNull(),
    updated_by_id: text("updated_by_id").notNull(),
    updated_by_name: text("updated_by_name").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check("artifact_access_target_check", sql`${table.target_kind} IN ('note', 'collection', 'file')`),
    check("artifact_access_subject_check", sql`${table.subject_type} IN ('org', 'guild', 'agent')`),
    check("artifact_access_mode_check", sql`${table.mode} IN ('read', 'write', 'none')`),
    check("artifact_access_none_is_agent", sql`${table.mode} <> 'none' OR ${table.subject_type} = 'agent'`),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "artifact_access_org_id_fkey",
    }).onDelete("cascade"),
    unique("artifact_access_subject_key").on(table.target_kind, table.target_id, table.subject_type, table.subject_id),
    index("artifact_access_by_subject").on(table.subject_type, table.subject_id),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    level: text("level", { enum: ["agent", "guild", "org"] }).notNull(),
    owner_id: text("owner_id").notNull(),
    guild_id: text("guild_id"),
    agent_id: text("agent_id"),
    origin_guild_id: text("origin_guild_id"),
    kind: text("kind", { enum: ["note", "object", "memory", "script", "file"] }).notNull(),
    collection_id: text("collection_id"),
    path: text("path").notNull().default(""),
    key: text("key").notNull(),
    title: text("title"),
    content_text: text("content_text"),
    content_json: jsonb("content_json"),
    search_text: text("search_text"),
    search_blob: text("search_blob"),
    search_document: tsvector("search_document").generatedAlwaysAs(
      sql`CASE
        WHEN kind IN ('note', 'memory') THEN to_tsvector('simple', COALESCE(content_text, ''))
        WHEN kind = 'object' THEN (setweight(to_tsvector('simple', COALESCE(search_text, '')), 'A') || setweight(to_tsvector('simple', COALESCE(search_blob, '')), 'B'))
        WHEN kind = 'file' THEN to_tsvector('simple', COALESCE(search_text, ''))
        ELSE NULL::tsvector
      END`,
    ),
    identity: text("identity"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    mime: text("mime"),
    bytes: integer("bytes"),
    content_hash: text("content_hash").notNull(),
    version: integer("version").notNull().default(1),
    created_by_type: text("created_by_type").notNull(),
    created_by_id: text("created_by_id").notNull(),
    created_by_name: text("created_by_name").notNull(),
    updated_by_type: text("updated_by_type").notNull(),
    updated_by_id: text("updated_by_id").notNull(),
    updated_by_name: text("updated_by_name").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    deleted_at: timestamptz("deleted_at"),
  },
  (table) => [
    check("artifacts_level_check", sql`${table.level} IN ('agent', 'guild', 'org')`),
    check("artifacts_kind_check", sql`${table.kind} IN ('note', 'object', 'memory', 'script', 'file')`),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "artifacts_org_id_fkey",
    }),
    foreignKey({
      columns: [table.collection_id],
      foreignColumns: [artifactCollections.id],
      name: "artifacts_collection_fkey",
    }),
    index("artifacts_search_document").using("gin", table.search_document),
    uniqueIndex("artifacts_record_identity")
      .on(table.collection_id, table.identity)
      .where(sql`${table.deleted_at} IS NULL AND ${table.identity} IS NOT NULL`),
  ],
);

export const fileChanges = pgTable(
  "file_changes",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    artifact_id: text("artifact_id"),
    task_agent_id: text("task_agent_id"),
    display_path: text("display_path").notNull(),
    operation: text("operation", { enum: ["create", "update", "delete"] }).notNull(),
    version: integer("version").notNull(),
    actor_type: text("actor_type", { enum: ["user", "agent", "run"] }).notNull(),
    actor_id: text("actor_id").notNull(),
    actor_name: text("actor_name").notNull(),
    run_id: text("run_id"),
    tool_call_id: text("tool_call_id"),
    tool_name: text("tool_name"),
    created_at: timestamptz("created_at").notNull(),
    studio_session_id: text("studio_session_id"),
    studio_seq: integer("studio_seq"),
  },
  (table) => [
    check(
      "file_changes_target_check",
      sql`(${table.artifact_id} IS NOT NULL AND ${table.task_agent_id} IS NULL)
          OR (${table.artifact_id} IS NULL AND ${table.task_agent_id} IS NOT NULL)`,
    ),
    check(
      "file_changes_operation_check",
      sql`${table.operation} IN ('create', 'update', 'delete')`,
    ),
    check(
      "file_changes_actor_type_check",
      sql`${table.actor_type} IN ('user', 'agent', 'run')`,
    ),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "file_changes_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.artifact_id],
      foreignColumns: [artifacts.id],
      name: "file_changes_artifact_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.task_agent_id],
      foreignColumns: [agents.id],
      name: "file_changes_task_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [runs.id],
      name: "file_changes_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.studio_session_id],
      foreignColumns: [studioSessions.id],
      name: "file_changes_studio_session_id_fkey",
    }).onDelete("set null"),
    index("file_changes_by_path").on(table.org_id, table.display_path, table.created_at),
    index("file_changes_by_org_time").on(table.org_id, table.created_at),
    index("file_changes_by_artifact").on(table.artifact_id, table.created_at),
    index("file_changes_by_tool_call").on(table.run_id, table.tool_call_id),
  ],
);

export const configChanges = pgTable(
  "config_changes",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    guild_id: text("guild_id"),
    agent_id: text("agent_id"),
    target_kind: text("target_kind", { enum: ["routine", "access", "guild_text", "collection", "note", "file"] }).notNull(),
    target_id: text("target_id").notNull(),
    operation: text("operation", { enum: ["create", "update", "delete"] }).notNull(),
    summary: text("summary").notNull(),
    actor_type: text("actor_type", { enum: ["user", "agent", "run"] }).notNull(),
    actor_id: text("actor_id").notNull(),
    actor_name: text("actor_name").notNull(),
    run_id: text("run_id"),
    tool_call_id: text("tool_call_id"),
    tool_name: text("tool_name"),
    studio_session_id: text("studio_session_id"),
    studio_seq: integer("studio_seq"),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "config_changes_target_kind_check",
      sql`${table.target_kind} IN ('routine', 'access', 'guild_text', 'collection', 'note', 'file')`,
    ),
    check("config_changes_operation_check", sql`${table.operation} IN ('create', 'update', 'delete')`),
    check("config_changes_actor_type_check", sql`${table.actor_type} IN ('user', 'agent', 'run')`),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "config_changes_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "config_changes_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agent_id],
      foreignColumns: [agents.id],
      name: "config_changes_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.run_id],
      foreignColumns: [runs.id],
      name: "config_changes_run_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.studio_session_id],
      foreignColumns: [studioSessions.id],
      name: "config_changes_studio_session_id_fkey",
    }).onDelete("set null"),
    index("config_changes_by_target").on(table.org_id, table.target_kind, table.target_id, table.created_at),
    index("config_changes_by_guild").on(table.guild_id, table.created_at),
  ],
);

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    agent_id: text("agent_id").notNull(),
    content_text: text("content_text").notNull(),
    replaced_at: timestamptz("replaced_at").notNull(),
    replaced_by_type: text("replaced_by_type").notNull(),
    replaced_by_id: text("replaced_by_id").notNull(),
    replaced_by_name: text("replaced_by_name").notNull(),
    replaced_by_detail: text("replaced_by_detail").notNull(),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "memory_revisions_org_id_fkey",
    }),
    index("memory_revisions_by_agent").on(table.org_id, table.agent_id, table.replaced_at),
  ],
);

export const taskRevisions = pgTable(
  "task_revisions",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    agent_id: text("agent_id").notNull(),
    version: integer("version").notNull(),
    content_text: text("content_text").notNull(),
    replaced_at: timestamptz("replaced_at").notNull(),
    replaced_by_type: text("replaced_by_type").notNull(),
    replaced_by_id: text("replaced_by_id").notNull(),
    replaced_by_name: text("replaced_by_name").notNull(),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "task_revisions_org_id_fkey",
    }),
    unique("task_revisions_agent_version_unique").on(table.org_id, table.agent_id, table.version),
    index("task_revisions_by_agent").on(table.org_id, table.agent_id, table.version),
  ],
);

export const studioSessions = pgTable(
  "studio_sessions",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    created_by_user_id: text("created_by_user_id"),
    created_by_name: text("created_by_name").notNull(),
    mode: text("mode", { enum: ["optimize", "create"] }).notNull(),
    source_guild_id: text("source_guild_id"),
    source_guild_snapshot: jsonb("source_guild_snapshot").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    coach_agent_id: text("coach_agent_id"),
    coach_snapshot: jsonb("coach_snapshot"),
    config_snapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),
    selected_target_agent_id: text("selected_target_agent_id"),
    parent_session_id: text("parent_session_id"),
    status: text("status", { enum: ["active", "blocked", "archived"] }).notNull(),
    blocked_reason: text("blocked_reason"),
    generation_state: text("generation_state", { enum: ["idle", "generating", "cancelling"] }).notNull(),
    generation_number: integer("generation_number").notNull().default(0),
    generation_token: text("generation_token"),
    generation_started_at: timestamptz("generation_started_at"),
    errors: jsonb("errors").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    granted_connection_ids: jsonb("granted_connection_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    archived_at: timestamptz("archived_at"),
  },
  (table) => [
    check("studio_sessions_mode_check", sql`${table.mode} IN ('optimize', 'create')`),
    check("studio_sessions_status_check", sql`${table.status} IN ('active', 'blocked', 'archived')`),
    check(
      "studio_sessions_generation_state_check",
      sql`${table.generation_state} IN ('idle', 'generating', 'cancelling')`,
    ),
    check(
      "studio_sessions_blocked_reason_check",
      sql`${table.blocked_reason} IS NULL OR ${table.blocked_reason} IN ('source_deleted', 'input_token_limit')`,
    ),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "studio_sessions_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.created_by_user_id],
      foreignColumns: [users.id],
      name: "studio_sessions_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.source_guild_id],
      foreignColumns: [guilds.id],
      name: "studio_sessions_source_guild_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.coach_agent_id],
      foreignColumns: [agents.id],
      name: "studio_sessions_coach_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.selected_target_agent_id],
      foreignColumns: [agents.id],
      name: "studio_sessions_selected_target_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.parent_session_id],
      foreignColumns: [table.id],
      name: "studio_sessions_parent_session_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("studio_sessions_generation_token_unique")
      .on(table.generation_token)
      .where(sql`${table.generation_token} IS NOT NULL`),
    index("studio_sessions_by_owner").on(table.org_id, table.created_by_user_id, table.updated_at),
    index("studio_sessions_by_source_guild").on(table.source_guild_id, table.updated_at),
  ],
);

export const studioMessages = pgTable(
  "studio_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    session_id: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    generation: integer("generation").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    cost_usd: numeric("cost_usd"),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    unique("studio_messages_session_id_seq_key").on(table.session_id, table.seq),
    foreignKey({
      columns: [table.session_id],
      foreignColumns: [studioSessions.id],
      name: "studio_messages_session_id_fkey",
    }).onDelete("cascade"),
    index("studio_messages_by_session").on(table.session_id, table.seq),
  ],
);

export const studioDrafts = pgTable(
  "studio_drafts",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    org_id: text("org_id").notNull(),
    source_guild_id: text("source_guild_id"),
    resource_kind: text("resource_kind").notNull(),
    target_agent_id: text("target_agent_id"),
    target_snapshot: jsonb("target_snapshot").notNull(),
    source_artifact_id: text("source_artifact_id"),
    source_display_path: text("source_display_path"),
    base_version: integer("base_version").notNull(),
    base_hash: text("base_hash").notNull(),
    base_content: text("base_content").notNull(),
    proposed_content: text("proposed_content").notNull(),
    rationale: text("rationale").notNull(),
    evidence_refs: jsonb("evidence_refs").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    evidence_warnings: jsonb("evidence_warnings").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    risks: jsonb("risks").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status", { enum: ["draft", "superseded", "published", "unchanged", "discarded", "conflicted"] }).notNull(),
    draft_number: integer("draft_number").notNull(),
    supersedes_draft_id: text("supersedes_draft_id"),
    created_generation: integer("created_generation").notNull(),
    created_message_seq: integer("created_message_seq").notNull(),
    created_at: timestamptz("created_at").notNull(),
    resolved_at: timestamptz("resolved_at"),
    published_at: timestamptz("published_at"),
    published_by_user_id: text("published_by_user_id"),
    published_resource_version: integer("published_resource_version"),
    discarded_by_user_id: text("discarded_by_user_id"),
  },
  (table) => [
    check("studio_drafts_resource_kind_check", sql`${table.resource_kind} = 'agent_task'`),
    check(
      "studio_drafts_status_check",
      sql`${table.status} IN ('draft', 'superseded', 'published', 'unchanged', 'discarded', 'conflicted')`,
    ),
    foreignKey({
      columns: [table.session_id],
      foreignColumns: [studioSessions.id],
      name: "studio_drafts_session_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "studio_drafts_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.source_guild_id],
      foreignColumns: [guilds.id],
      name: "studio_drafts_source_guild_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.target_agent_id],
      foreignColumns: [agents.id],
      name: "studio_drafts_target_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.source_artifact_id],
      foreignColumns: [artifacts.id],
      name: "studio_drafts_source_artifact_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.supersedes_draft_id],
      foreignColumns: [table.id],
      name: "studio_drafts_supersedes_draft_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.published_by_user_id],
      foreignColumns: [users.id],
      name: "studio_drafts_published_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.discarded_by_user_id],
      foreignColumns: [users.id],
      name: "studio_drafts_discarded_by_user_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("studio_drafts_head_unique")
      .on(table.session_id, table.target_agent_id, table.resource_kind)
      .where(sql`${table.status} = 'draft'`),
    index("studio_drafts_by_session").on(table.session_id, table.created_at),
  ],
);

export const recipes = pgTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    created_by_user_id: text("created_by_user_id"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    visibility: text("visibility", { enum: ["private", "org"] }).notNull().default("private"),
    status: text("status", { enum: ["draft", "ready"] }).notNull().default("draft"),
    body: jsonb("body").notNull(),
    body_version: integer("body_version").notNull().default(1),
    source_kind: text("source_kind", { enum: ["guild", "builder", "file"] }).notNull(),
    source_guild_id: text("source_guild_id"),
    source_builder_session_id: text("source_builder_session_id"),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check("recipes_visibility_check", sql`${table.visibility} IN ('private', 'org')`),
    check("recipes_status_check", sql`${table.status} IN ('draft', 'ready')`),
    check("recipes_source_kind_check", sql`${table.source_kind} IN ('guild', 'builder', 'file')`),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "recipes_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.created_by_user_id],
      foreignColumns: [users.id],
      name: "recipes_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.source_guild_id],
      foreignColumns: [guilds.id],
      name: "recipes_source_guild_id_fkey",
    }).onDelete("set null"),
    index("recipes_by_org").on(table.org_id, table.updated_at),
  ],
);

export const builderSessions = pgTable(
  "builder_sessions",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    created_by_user_id: text("created_by_user_id"),
    created_by_name: text("created_by_name").notNull(),
    recipe_id: text("recipe_id").notNull(),
    config_snapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["active", "blocked", "archived"] }).notNull(),
    blocked_reason: text("blocked_reason"),
    generation_state: text("generation_state", { enum: ["idle", "generating", "cancelling"] }).notNull(),
    generation_number: integer("generation_number").notNull().default(0),
    generation_token: text("generation_token"),
    generation_started_at: timestamptz("generation_started_at"),
    errors: jsonb("errors").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    archived_at: timestamptz("archived_at"),
  },
  (table) => [
    check("builder_sessions_status_check", sql`${table.status} IN ('active', 'blocked', 'archived')`),
    check(
      "builder_sessions_generation_state_check",
      sql`${table.generation_state} IN ('idle', 'generating', 'cancelling')`,
    ),
    check(
      "builder_sessions_blocked_reason_check",
      sql`${table.blocked_reason} IS NULL OR ${table.blocked_reason} IN ('input_token_limit')`,
    ),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "builder_sessions_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.created_by_user_id],
      foreignColumns: [users.id],
      name: "builder_sessions_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.recipe_id],
      foreignColumns: [recipes.id],
      name: "builder_sessions_recipe_id_fkey",
    }).onDelete("restrict"),
    uniqueIndex("builder_sessions_generation_token_unique")
      .on(table.generation_token)
      .where(sql`${table.generation_token} IS NOT NULL`),
    uniqueIndex("builder_sessions_recipe_unique").on(table.recipe_id),
    index("builder_sessions_by_owner").on(table.org_id, table.created_by_user_id, table.updated_at),
  ],
);

export const builderMessages = pgTable(
  "builder_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    session_id: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    generation: integer("generation").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    cost_usd: numeric("cost_usd"),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    unique("builder_messages_session_id_seq_key").on(table.session_id, table.seq),
    foreignKey({
      columns: [table.session_id],
      foreignColumns: [builderSessions.id],
      name: "builder_messages_session_id_fkey",
    }).onDelete("cascade"),
    index("builder_messages_by_session").on(table.session_id, table.seq),
  ],
);

export const recipeApplies = pgTable(
  "recipe_applies",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    recipe_id: text("recipe_id").notNull(),
    created_by_user_id: text("created_by_user_id"),
    guild_id: text("guild_id"),
    created_guild: boolean("created_guild").notNull().default(false),
    status: text("status", { enum: ["preview", "skeleton", "checklist", "ready", "aborted"] }).notNull(),
    recipe_body_version: integer("recipe_body_version").notNull(),
    preview: jsonb("preview").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    checklist: jsonb("checklist").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check(
      "recipe_applies_status_check",
      sql`${table.status} IN ('preview', 'skeleton', 'checklist', 'ready', 'aborted')`,
    ),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "recipe_applies_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.recipe_id],
      foreignColumns: [recipes.id],
      name: "recipe_applies_recipe_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.created_by_user_id],
      foreignColumns: [users.id],
      name: "recipe_applies_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "recipe_applies_guild_id_fkey",
    }).onDelete("set null"),
    index("recipe_applies_by_org").on(table.org_id, table.updated_at),
    index("recipe_applies_by_guild").on(table.guild_id, table.updated_at),
    uniqueIndex("recipe_applies_open_guild")
      .on(table.guild_id)
      .where(sql`${table.guild_id} IS NOT NULL AND ${table.status} IN ('skeleton', 'checklist')`),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    uploaded_by: text("uploaded_by").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime", { enum: ["image/jpeg", "image/png", "image/gif", "image/webp"] }).notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    kind: text("kind", { enum: ["image", "file"] }).notNull(),
    created_at: timestamptz("created_at").notNull(),
  },
  (table) => [
    check("attachments_kind_check", sql`${table.kind} IN ('image', 'file')`),
    check("attachments_bytes_check", sql`${table.bytes} > 0`),
    check(
      "attachments_mime_check",
      sql`${table.mime} IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')`,
    ),
    foreignKey({
      columns: [table.org_id],
      foreignColumns: [orgs.id],
      name: "attachments_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.uploaded_by],
      foreignColumns: [users.id],
      name: "attachments_uploaded_by_fkey",
    }).onDelete("restrict"),
    index("attachments_by_org").on(table.org_id, table.created_at),
  ],
);

export const guildRepositories = pgTable(
  "guild_repositories",
  {
    id: text("id").primaryKey(),
    guild_id: text("guild_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    default_branch: text("default_branch").notNull(),
    connection_id: text("connection_id"),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    github_id: bigint("github_id", { mode: "number" }),
  },
  (table) => [
    unique("guild_repositories_guild_name_key").on(table.guild_id, table.name),
    check("guild_repositories_name_check", sql`${table.name} ~ '^[a-z][a-z0-9_-]{0,62}$'`),
    foreignKey({
      columns: [table.guild_id],
      foreignColumns: [guilds.id],
      name: "guild_repositories_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connection_id],
      foreignColumns: [mcpConnections.id],
      name: "guild_repositories_connection_id_fkey",
    }).onDelete("cascade"),
    index("guild_repositories_by_connection").on(table.connection_id),
  ],
);
