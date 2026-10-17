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
  smallint,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
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
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    /** The organisation's default model, `{provider}/{model}`, or null while none is named. */
    defaultModel: text("default_model"),
  },
  (table) => [unique("orgs_slug_key").on(table.slug)],
);

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    check(
      "org_members_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member')`,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "org_members_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "org_members_user_id_fkey",
    }).onDelete("cascade"),
    index("org_members_by_user").on(table.userId),
  ],
);

export const guilds = pgTable(
  "guilds",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
    groupChatSeq: bigint("group_chat_seq", { mode: "number" }).notNull().default(0),
    groupAgentMessageCount: integer("group_agent_message_count").notNull().default(0),
    groupAgentMessageLimit: integer("group_agent_message_limit").notNull().default(20),
    groupChatErrors: jsonb("group_chat_errors").notNull().default(sql`'[]'::jsonb`),
    groupChatClearedAt: timestamptz("group_chat_cleared_at"),
    about: text("about").notNull().default(""),
    orgId: text("org_id").notNull(),
    visibility: text("visibility").notNull().default("org"),
    routinesEnabled: boolean("routines_enabled").notNull().default(true),
    description: text("description").notNull().default(""),
    maxAgents: integer("max_agents").notNull().default(15),
    gitAuthorEmail: text("git_author_email").notNull().default(""),
  },
  (table) => [
    unique("guilds_org_name_unique").on(table.orgId, table.name),
    unique("guilds_org_id_id_unique").on(table.orgId, table.id),
    check("group_agent_message_limit_positive", sql`${table.groupAgentMessageLimit} > 0`),
    check("guilds_max_agents_positive", sql`${table.maxAgents} > 0`),
    check("guilds_visibility_check", sql`${table.visibility} IN ('org', 'private')`),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "guilds_org_id_fkey",
    }),
    index("guilds_by_org").on(table.orgId),
  ],
);

export const guildOperators = pgTable(
  "guild_operators",
  {
    orgId: text("org_id").notNull(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    check("guild_operators_role_check", sql`${table.role} IN ('admin', 'operator')`),
    foreignKey({
      columns: [table.orgId, table.guildId],
      foreignColumns: [guilds.orgId, guilds.id],
      name: "guild_operators_guild_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.userId],
      foreignColumns: [orgMembers.orgId, orgMembers.userId],
      name: "guild_operators_member_fkey",
    }).onDelete("cascade"),
    index("guild_operators_by_user").on(table.userId),
  ],
);

export const machines = pgTable(
  "machines",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    box: text("box").notNull(),
    cpu: numeric("cpu"),
    memoryMib: integer("memory_mib"),
    maxWorkspaceMib: integer("max_workspace_mib").notNull().default(10240),
    workspaceMib: integer("workspace_mib"),
    harnesses: text("harnesses").array(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    unique("machines_org_id_name_key").on(table.orgId, table.name),
    unique("machines_org_id_id_unique").on(table.orgId, table.id),
    check("machines_box_check", sql`${table.box} IN ('standard', 'code', 'custom')`),
    check(
      "machines_size_check",
      sql`(${table.box} = 'custom' AND ${table.cpu} IS NOT NULL AND ${table.memoryMib} IS NOT NULL) OR (${table.box} <> 'custom' AND ${table.cpu} IS NULL AND ${table.memoryMib} IS NULL)`,
    ),
    check("machines_max_workspace_mib_positive", sql`${table.maxWorkspaceMib} > 0`),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "machines_org_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
    groupChatDeliveredThrough: bigint("group_chat_delivered_through", {
      mode: "number",
    })
      .notNull()
      .default(0),
    focus: text("focus").notNull().default(""),
    wakeTriggers: text("wake_triggers").notNull().default(""),
    avatarShape: text("avatar_shape").notNull().default("teardrop"),
    avatarColor: text("avatar_color").notNull().default("#7c5cff"),
    orgId: text("org_id").notNull(),
    task: text("task").notNull(),
    taskVersion: integer("task_version").notNull().default(1),
    taskHash: text("task_hash").notNull(),
    taskUpdatedAt: timestamptz("task_updated_at").notNull(),
    workspaceMib: integer("workspace_mib"),
    machineId: text("machine_id").notNull(),
    machineSlot: smallint("machine_slot").notNull(),
    harnessLogins: jsonb("harness_logins").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    unique("agents_name_key").on(table.name),
    unique("agents_org_id_id_unique").on(table.orgId, table.id),
    unique("agents_machine_slot_key").on(table.machineId, table.machineSlot),
    check("agents_machine_slot_range", sql`${table.machineSlot} >= 0 AND ${table.machineSlot} < 32`),
    foreignKey({
      columns: [table.orgId, table.machineId],
      foreignColumns: [machines.orgId, machines.id],
      name: "agents_machine_fkey",
    }).onDelete("restrict"),
    index("agents_by_machine").on(table.machineId),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "agents_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "agents_org_id_fkey",
    }),
    index("agents_by_group_delivery").on(
      table.guildId,
      table.groupChatDeliveredThrough,
      table.createdAt,
    ),
    index("agents_by_guild").on(table.guildId, table.updatedAt),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull(),
    configSnapshot: jsonb("config_snapshot").notNull(),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
    systemPromptHash: text("system_prompt_hash"),
    taskPromptHash: text("task_prompt_hash"),
    kind: text("kind").notNull().default("direct"),
    groupChatThroughSeq: bigint("group_chat_through_seq", { mode: "number" }),
    memoryPromptHash: text("memory_prompt_hash"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    orgId: text("org_id").notNull(),
    scheduleId: text("schedule_id"),
  },
  (table) => [
    check("runs_kind_valid", sql`${table.kind} IN ('direct', 'group', 'schedule')`),
    check("runs_status_valid", sql`${table.status} IN ('active', 'completed')`),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "runs_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "runs_org_id_fkey",
    }),
    index("runs_by_agent").on(table.agentId, table.updatedAt),
    index("runs_by_org").on(table.orgId),
    index("runs_by_agent_task_hash").on(table.agentId, table.taskPromptHash),
    index("runs_by_schedule").on(table.scheduleId, table.createdAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    payload: jsonb("payload").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamptz("created_at").notNull(),
    costUsd: numeric("cost_usd"),
  },
  (table) => [
    unique("messages_run_id_seq_key").on(table.runId, table.seq),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runs.id],
      name: "messages_run_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const groupMessages = pgTable(
  "group_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    guildId: text("guild_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    authorType: text("author_type").notNull(),
    authorName: text("author_name").notNull(),
    authorAgentId: text("author_agent_id"),
    sourceRunId: text("source_run_id"),
    content: text("content").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    taggedNames: jsonb("tagged_names").notNull().default(sql`'[]'::jsonb`),
    taggedAgentIds: jsonb("tagged_agent_ids").notNull().default(sql`'[]'::jsonb`),
    taggedUserIds: jsonb("tagged_user_ids").notNull().default(sql`'[]'::jsonb`),
  },
  (table) => [
    unique("group_messages_guild_id_seq_key").on(table.guildId, table.seq),
    check("group_messages_author_type_check", sql`${table.authorType} IN ('user', 'agent')`),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "group_messages_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.authorAgentId],
      foreignColumns: [agents.id],
      name: "group_messages_author_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.sourceRunId],
      foreignColumns: [runs.id],
      name: "group_messages_source_run_id_fkey",
    }).onDelete("set null"),
  ],
);

export const groupChatReads = pgTable(
  "group_chat_reads",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    seenThroughSeq: bigint("seen_through_seq", { mode: "number" }).notNull().default(0),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "group_chat_reads_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "group_chat_reads_user_id_fkey",
    }).onDelete("cascade"),
    index("group_chat_reads_by_user").on(table.userId),
  ],
);

export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    instruction: text("instruction").notNull(),
    nextRunAt: timestamptz("next_run_at").notNull(),
    lastRunAt: timestamptz("last_run_at"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    cron: text("cron"),
    paused: boolean("paused").notNull().default(false),
    description: text("description").notNull().default(""),
    wakeWindow: jsonb("wake_window"),
    windowFires: integer("window_fires").notNull().default(0),
  },
  (table) => [
    check("schedules_timing_check", sql`(${table.cron} IS NULL) <> (${table.wakeWindow} IS NULL)`),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "schedules_agent_id_fkey",
    }).onDelete("cascade"),
    index("schedules_by_agent").on(table.agentId, table.createdAt),
    index("schedules_due").on(table.nextRunAt),
  ],
);

export const guildIssues = pgTable(
  "guild_issues",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: text("agent_id"),
    agentName: text("agent_name").notNull(),
    runId: text("run_id"),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    summary: text("summary").notNull(),
    detail: text("detail").notNull(),
    toolName: text("tool_name"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    resolvedAt: timestamptz("resolved_at"),
    resolvedBy: text("resolved_by"),
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
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "guild_issues_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "guild_issues_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "guild_issues_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runs.id],
      name: "guild_issues_run_id_fkey",
    }).onDelete("set null"),
    index("guild_issues_by_guild").on(table.guildId, table.status, table.createdAt),
  ],
);

export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    rotatedAt: timestamptz("rotated_at").notNull(),
    description: text("description").notNull(),
    orgId: text("org_id").notNull(),
    orgWide: boolean("org_wide").notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: text("created_by_agent_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "secrets_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "secrets_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.createdByAgentId],
      foreignColumns: [agents.id],
      name: "secrets_created_by_agent_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("secrets_org_name_unique").on(table.orgId, table.name),
  ],
);

export const secretGrants = pgTable(
  "secret_grants",
  {
    secretId: text("secret_id").notNull(),
    guildId: text("guild_id"),
    agentId: text("agent_id"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "secret_grants_one_target",
      sql`(${table.guildId} IS NULL) <> (${table.agentId} IS NULL)`,
    ),
    foreignKey({
      columns: [table.secretId],
      foreignColumns: [secrets.id],
      name: "secret_grants_secret_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "secret_grants_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "secret_grants_agent_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("secret_grants_guild_unique")
      .on(table.secretId, table.guildId)
      .where(sql`${table.guildId} IS NOT NULL`),
    uniqueIndex("secret_grants_agent_unique")
      .on(table.secretId, table.agentId)
      .where(sql`${table.agentId} IS NOT NULL`),
    index("secret_grants_by_guild").on(table.guildId),
    index("secret_grants_by_agent").on(table.agentId),
  ],
);

export const connectors = pgTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    toolPrefix: text("tool_prefix").notNull(),
    ownerOrgId: text("owner_org_id"),
    manifest: jsonb("manifest").notNull(),
    source: text("source").notNull(),
    version: text("version").notNull().default(""),
    verified: boolean("verified").notNull().default(false),
    experimental: boolean("experimental").notNull().default(false),
    publisher: text("publisher").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    oauthClient: jsonb("oauth_client"),
    overrides: jsonb("overrides").notNull().default(sql`'{}'::jsonb`),
    installedAt: timestamptz("installed_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check("connectors_source_check", sql`${table.source} IN ('core', 'registry', 'local')`),
    foreignKey({
      columns: [table.ownerOrgId],
      foreignColumns: [orgs.id],
      name: "connectors_owner_org_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("connectors_tool_prefix_key").on(table.toolPrefix),
    uniqueIndex("connectors_platform_slug_key")
      .on(table.slug)
      .where(sql`${table.ownerOrgId} IS NULL`),
    uniqueIndex("connectors_org_slug_key")
      .on(table.ownerOrgId, table.slug)
      .where(sql`${table.ownerOrgId} IS NOT NULL`),
  ],
);

export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    mcpServerId: text("mcp_server_id").notNull(),
    ownerScope: text("owner_scope").notNull(),
    ownerId: text("owner_id"),
    guildId: text("guild_id"),
    agentId: text("agent_id"),
    accountHint: text("account_hint").notNull().default(""),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    rotatedAt: timestamptz("rotated_at").notNull(),
    status: text("status").notNull().default("pending"),
    oauthState: text("oauth_state"),
    orgId: text("org_id"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    check(
      "mcp_connections_owner_scope_check",
      sql`${table.ownerScope} IN ('platform', 'org', 'guild', 'agent')`,
    ),
    check(
      "mcp_connections_status_check",
      sql`${table.status} IN ('pending', 'connected', 'disconnected')`,
    ),
    foreignKey({
      columns: [table.mcpServerId],
      foreignColumns: [connectors.id],
      name: "mcp_connections_mcp_server_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "mcp_connections_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "mcp_connections_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "mcp_connections_guild_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("mcp_connections_oauth_state")
      .on(table.oauthState)
      .where(sql`${table.oauthState} IS NOT NULL`),
    uniqueIndex("mcp_connections_platform_unique")
      .on(table.mcpServerId)
      .where(sql`${table.ownerScope} = 'platform'`),
    uniqueIndex("mcp_connections_scoped_unique")
      .on(table.mcpServerId, table.ownerScope, table.ownerId)
      .where(sql`${table.ownerId} IS NOT NULL`),
    unique("mcp_connections_id_server_key").on(table.id, table.mcpServerId),
  ],
);

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    mcpServerId: text("mcp_server_id").notNull(),
    remoteName: text("remote_name").notNull(),
    namespacedName: text("namespaced_name").notNull(),
    description: text("description").notNull().default(""),
    inputSchema: jsonb("input_schema").notNull(),
    listedAt: timestamptz("listed_at").notNull(),
    readOnlyHint: boolean("read_only_hint"),
    destructiveHint: boolean("destructive_hint"),
  },
  (table) => [
    unique("mcp_tools_connection_id_namespaced_name_key").on(
      table.connectionId,
      table.namespacedName,
    ),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnections.id],
      name: "mcp_tools_connection_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connectionId, table.mcpServerId],
      foreignColumns: [mcpConnections.id, mcpConnections.mcpServerId],
      name: "mcp_tools_connection_server_fkey",
    }).onDelete("cascade"),
    index("mcp_tools_by_connection").on(table.connectionId),
  ],
);

export const connectorCalls = pgTable(
  "connector_calls",
  {
    orgId: text("org_id").notNull(),
    connectorId: text("connector_id").notNull(),
    month: text("month").notNull(),
    calls: integer("calls").notNull().default(0),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.connectorId, table.month], name: "connector_calls_pkey" }),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "connector_calls_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connectorId],
      foreignColumns: [connectors.id],
      name: "connector_calls_connector_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const bindings = pgTable(
  "bindings",
  {
    id: text("id").primaryKey(),
    catalogKind: text("catalog_kind").notNull(),
    catalogId: text("catalog_id").notNull(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id"),
    guildId: text("guild_id"),
    agentId: text("agent_id"),
    enabled: boolean("enabled").notNull(),
    connectionId: text("connection_id"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    orgId: text("org_id"),
  },
  (table) => [
    check(
      "bindings_catalog_kind_check",
      sql`${table.catalogKind} IN ('native_tool', 'mcp', 'mcp_tool', 'artifact_grant')`,
    ),
    check("bindings_scope_check", sql`${table.scope} IN ('platform', 'org', 'guild', 'agent')`),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      name: "bindings_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnections.id],
      name: "bindings_connection_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "bindings_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "bindings_guild_id_fkey",
    }).onDelete("cascade"),
    uniqueIndex("bindings_platform_unique")
      .on(table.catalogKind, table.catalogId)
      .where(sql`${table.scope} = 'platform'`),
    uniqueIndex("bindings_scoped_unique")
      .on(table.catalogKind, table.catalogId, table.scope, table.scopeId)
      .where(sql`${table.scopeId} IS NOT NULL`),
  ],
);

export const usageCounters = pgTable(
  "usage_counters",
  {
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd").notNull().default("0"),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.scopeId] }),
    check("usage_counters_scope_check", sql`${table.scope} IN ('global', 'org', 'guild', 'agent')`),
  ],
);

export const orgModelProviders = pgTable(
  "org_model_providers",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    ciphertext: bytea("ciphertext"),
    nonce: bytea("nonce"),
    keyHint: text("key_hint"),
    /** The chosen model ids, `{provider}/{model}`, the pickers offer. */
    models: text("models").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "org_model_providers_org_id_fkey",
    }).onDelete("cascade"),
    unique("org_model_providers_org_provider_unique").on(table.orgId, table.provider),
  ],
);

/** A store integration's values, encrypted under the master key; one row per integration id. */
export const instanceKeys = pgTable(
  "instance_keys",
  {
    integration: text("integration").primaryKey(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    setByUserId: text("set_by_user_id"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.setByUserId],
      foreignColumns: [users.id],
      name: "instance_keys_set_by_user_id_fkey",
    }).onDelete("set null"),
  ],
);

export const orgMonthlyUsage = pgTable(
  "org_monthly_usage",
  {
    orgId: text("org_id").notNull(),
    month: text("month").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd").notNull().default("0"),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    studioBuilderRuns: bigint("studio_builder_runs", { mode: "number" }).notNull().default(0),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.month] }),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "org_monthly_usage_org_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const artifactCollections = pgTable(
  "artifact_collections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    guildId: text("guild_id"),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    columns: json("columns").notNull().default(sql`'[]'::json`),
    nextId: integer("next_id").notNull().default(1),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [
    check("artifact_collections_columns_array", sql`json_typeof(${table.columns}) = 'array'`),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "artifact_collections_org_id_fkey",
    }),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "artifact_collections_guild_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("artifact_collections_org_name")
      .on(table.orgId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("artifact_collections_by_guild").on(table.guildId),
  ],
);

export const collectionAccess = pgTable(
  "collection_access",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    collectionId: text("collection_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    mode: text("mode").notNull(),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check("collection_access_subject_check", sql`${table.subjectType} IN ('guild', 'agent')`),
    check("collection_access_mode_check", sql`${table.mode} IN ('read', 'write', 'none')`),
    check(
      "collection_access_none_is_agent",
      sql`${table.mode} <> 'none' OR ${table.subjectType} = 'agent'`,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "collection_access_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.collectionId],
      foreignColumns: [artifactCollections.id],
      name: "collection_access_collection_id_fkey",
    }).onDelete("cascade"),
    unique("collection_access_subject_key").on(table.collectionId, table.subjectType, table.subjectId),
    index("collection_access_by_subject").on(table.subjectType, table.subjectId),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    level: text("level").notNull(),
    ownerId: text("owner_id").notNull(),
    guildId: text("guild_id"),
    agentId: text("agent_id"),
    originGuildId: text("origin_guild_id"),
    kind: text("kind").notNull(),
    collectionId: text("collection_id"),
    path: text("path").notNull().default(""),
    key: text("key").notNull(),
    title: text("title"),
    contentText: text("content_text"),
    contentJson: jsonb("content_json"),
    searchText: text("search_text"),
    searchBlob: text("search_blob"),
    identity: text("identity"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    contentHash: text("content_hash").notNull(),
    version: integer("version").notNull().default(1),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    updatedByType: text("updated_by_type").notNull(),
    updatedById: text("updated_by_id").notNull(),
    updatedByName: text("updated_by_name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [
    check("artifacts_level_check", sql`${table.level} IN ('agent', 'guild', 'org')`),
    check("artifacts_kind_check", sql`${table.kind} IN ('note', 'object', 'memory', 'script')`),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "artifacts_org_id_fkey",
    }),
    foreignKey({
      columns: [table.collectionId],
      foreignColumns: [artifactCollections.id],
      name: "artifacts_collection_fkey",
    }),
    uniqueIndex("artifacts_record_identity")
      .on(table.collectionId, table.identity)
      .where(sql`${table.deletedAt} IS NULL AND ${table.identity} IS NOT NULL`),
  ],
);

export const fileChanges = pgTable(
  "file_changes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    artifactId: text("artifact_id"),
    taskAgentId: text("task_agent_id"),
    displayPath: text("display_path").notNull(),
    operation: text("operation").notNull(),
    version: integer("version").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    runId: text("run_id"),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "file_changes_target_check",
      sql`(${table.artifactId} IS NOT NULL AND ${table.taskAgentId} IS NULL)
          OR (${table.artifactId} IS NULL AND ${table.taskAgentId} IS NOT NULL)`,
    ),
    check(
      "file_changes_operation_check",
      sql`${table.operation} IN ('create', 'update', 'delete')`,
    ),
    check(
      "file_changes_actor_type_check",
      sql`${table.actorType} IN ('user', 'agent', 'run')`,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "file_changes_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.artifactId],
      foreignColumns: [artifacts.id],
      name: "file_changes_artifact_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.taskAgentId],
      foreignColumns: [agents.id],
      name: "file_changes_task_agent_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runs.id],
      name: "file_changes_run_id_fkey",
    }).onDelete("set null"),
    index("file_changes_by_path").on(table.orgId, table.displayPath, table.createdAt),
    index("file_changes_by_artifact").on(table.artifactId, table.createdAt),
    index("file_changes_by_tool_call").on(table.runId, table.toolCallId),
  ],
);

export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    agentId: text("agent_id").notNull(),
    contentText: text("content_text").notNull(),
    replacedAt: timestamptz("replaced_at").notNull(),
    replacedByType: text("replaced_by_type").notNull(),
    replacedById: text("replaced_by_id").notNull(),
    replacedByName: text("replaced_by_name").notNull(),
    replacedByDetail: text("replaced_by_detail").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "memory_revisions_org_id_fkey",
    }),
    index("memory_revisions_by_agent").on(table.orgId, table.agentId, table.replacedAt),
  ],
);

export const taskRevisions = pgTable(
  "task_revisions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    agentId: text("agent_id").notNull(),
    version: integer("version").notNull(),
    contentText: text("content_text").notNull(),
    replacedAt: timestamptz("replaced_at").notNull(),
    replacedByType: text("replaced_by_type").notNull(),
    replacedById: text("replaced_by_id").notNull(),
    replacedByName: text("replaced_by_name").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "task_revisions_org_id_fkey",
    }),
    unique("task_revisions_agent_version_unique").on(table.orgId, table.agentId, table.version),
    index("task_revisions_by_agent").on(table.orgId, table.agentId, table.version),
  ],
);

export const studioSessions = pgTable(
  "studio_sessions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdByName: text("created_by_name").notNull(),
    mode: text("mode").notNull(),
    sourceGuildId: text("source_guild_id"),
    sourceGuildSnapshot: jsonb("source_guild_snapshot").notNull().default(sql`'{}'::jsonb`),
    coachAgentId: text("coach_agent_id"),
    coachSnapshot: jsonb("coach_snapshot"),
    configSnapshot: jsonb("config_snapshot").notNull(),
    selectedTargetAgentId: text("selected_target_agent_id"),
    parentSessionId: text("parent_session_id"),
    status: text("status").notNull(),
    blockedReason: text("blocked_reason"),
    generationState: text("generation_state").notNull(),
    generationNumber: integer("generation_number").notNull().default(0),
    generationToken: text("generation_token"),
    generationStartedAt: timestamptz("generation_started_at"),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    grantedConnectionIds: jsonb("granted_connection_ids").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    check("studio_sessions_mode_check", sql`${table.mode} IN ('optimize', 'create')`),
    check("studio_sessions_status_check", sql`${table.status} IN ('active', 'blocked', 'archived')`),
    check(
      "studio_sessions_generation_state_check",
      sql`${table.generationState} IN ('idle', 'generating', 'cancelling')`,
    ),
    check(
      "studio_sessions_blocked_reason_check",
      sql`${table.blockedReason} IS NULL OR ${table.blockedReason} IN ('source_deleted', 'input_token_limit')`,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "studio_sessions_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "studio_sessions_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.sourceGuildId],
      foreignColumns: [guilds.id],
      name: "studio_sessions_source_guild_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.coachAgentId],
      foreignColumns: [agents.id],
      name: "studio_sessions_coach_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.selectedTargetAgentId],
      foreignColumns: [agents.id],
      name: "studio_sessions_selected_target_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.parentSessionId],
      foreignColumns: [table.id],
      name: "studio_sessions_parent_session_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("studio_sessions_generation_token_unique")
      .on(table.generationToken)
      .where(sql`${table.generationToken} IS NOT NULL`),
    index("studio_sessions_by_owner").on(table.orgId, table.createdByUserId, table.updatedAt),
    index("studio_sessions_by_source_guild").on(table.sourceGuildId, table.updatedAt),
  ],
);

export const studioMessages = pgTable(
  "studio_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    generation: integer("generation").notNull(),
    payload: jsonb("payload").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    costUsd: numeric("cost_usd"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    unique("studio_messages_session_id_seq_key").on(table.sessionId, table.seq),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [studioSessions.id],
      name: "studio_messages_session_id_fkey",
    }).onDelete("cascade"),
    index("studio_messages_by_session").on(table.sessionId, table.seq),
  ],
);

export const studioDrafts = pgTable(
  "studio_drafts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    orgId: text("org_id").notNull(),
    sourceGuildId: text("source_guild_id"),
    resourceKind: text("resource_kind").notNull(),
    targetAgentId: text("target_agent_id"),
    targetSnapshot: jsonb("target_snapshot").notNull(),
    sourceArtifactId: text("source_artifact_id"),
    sourceDisplayPath: text("source_display_path"),
    baseVersion: integer("base_version").notNull(),
    baseHash: text("base_hash").notNull(),
    baseContent: text("base_content").notNull(),
    proposedContent: text("proposed_content").notNull(),
    rationale: text("rationale").notNull(),
    evidenceRefs: jsonb("evidence_refs").notNull().default(sql`'[]'::jsonb`),
    evidenceWarnings: jsonb("evidence_warnings").notNull().default(sql`'[]'::jsonb`),
    risks: jsonb("risks").notNull().default(sql`'[]'::jsonb`),
    status: text("status").notNull(),
    draftNumber: integer("draft_number").notNull(),
    supersedesDraftId: text("supersedes_draft_id"),
    createdGeneration: integer("created_generation").notNull(),
    createdMessageSeq: integer("created_message_seq").notNull(),
    createdAt: timestamptz("created_at").notNull(),
    resolvedAt: timestamptz("resolved_at"),
    publishedAt: timestamptz("published_at"),
    publishedByUserId: text("published_by_user_id"),
    publishedResourceVersion: integer("published_resource_version"),
  },
  (table) => [
    check("studio_drafts_resource_kind_check", sql`${table.resourceKind} = 'agent_task'`),
    check(
      "studio_drafts_status_check",
      sql`${table.status} IN ('draft', 'superseded', 'published', 'unchanged', 'discarded', 'conflicted')`,
    ),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [studioSessions.id],
      name: "studio_drafts_session_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "studio_drafts_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceGuildId],
      foreignColumns: [guilds.id],
      name: "studio_drafts_source_guild_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.targetAgentId],
      foreignColumns: [agents.id],
      name: "studio_drafts_target_agent_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.sourceArtifactId],
      foreignColumns: [artifacts.id],
      name: "studio_drafts_source_artifact_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.supersedesDraftId],
      foreignColumns: [table.id],
      name: "studio_drafts_supersedes_draft_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.publishedByUserId],
      foreignColumns: [users.id],
      name: "studio_drafts_published_by_user_id_fkey",
    }).onDelete("set null"),
    uniqueIndex("studio_drafts_head_unique")
      .on(table.sessionId, table.targetAgentId, table.resourceKind)
      .where(sql`${table.status} = 'draft'`),
    index("studio_drafts_by_session").on(table.sessionId, table.createdAt),
  ],
);

export const recipes = pgTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    visibility: text("visibility").notNull().default("private"),
    status: text("status").notNull().default("draft"),
    body: jsonb("body").notNull(),
    bodyVersion: integer("body_version").notNull().default(1),
    sourceKind: text("source_kind").notNull(),
    sourceGuildId: text("source_guild_id"),
    sourceBuilderSessionId: text("source_builder_session_id"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check("recipes_visibility_check", sql`${table.visibility} IN ('private', 'org')`),
    check("recipes_status_check", sql`${table.status} IN ('draft', 'ready')`),
    check("recipes_source_kind_check", sql`${table.sourceKind} IN ('guild', 'builder', 'file')`),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "recipes_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "recipes_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.sourceGuildId],
      foreignColumns: [guilds.id],
      name: "recipes_source_guild_id_fkey",
    }).onDelete("set null"),
    index("recipes_by_org").on(table.orgId, table.updatedAt),
  ],
);

export const builderSessions = pgTable(
  "builder_sessions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdByName: text("created_by_name").notNull(),
    recipeId: text("recipe_id").notNull(),
    configSnapshot: jsonb("config_snapshot").notNull(),
    status: text("status").notNull(),
    blockedReason: text("blocked_reason"),
    generationState: text("generation_state").notNull(),
    generationNumber: integer("generation_number").notNull().default(0),
    generationToken: text("generation_token"),
    generationStartedAt: timestamptz("generation_started_at"),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    check("builder_sessions_status_check", sql`${table.status} IN ('active', 'blocked', 'archived')`),
    check(
      "builder_sessions_generation_state_check",
      sql`${table.generationState} IN ('idle', 'generating', 'cancelling')`,
    ),
    check(
      "builder_sessions_blocked_reason_check",
      sql`${table.blockedReason} IS NULL OR ${table.blockedReason} IN ('input_token_limit')`,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "builder_sessions_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "builder_sessions_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.recipeId],
      foreignColumns: [recipes.id],
      name: "builder_sessions_recipe_id_fkey",
    }).onDelete("restrict"),
    uniqueIndex("builder_sessions_generation_token_unique")
      .on(table.generationToken)
      .where(sql`${table.generationToken} IS NOT NULL`),
    uniqueIndex("builder_sessions_recipe_unique").on(table.recipeId),
    index("builder_sessions_by_owner").on(table.orgId, table.createdByUserId, table.updatedAt),
  ],
);

export const builderMessages = pgTable(
  "builder_messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    generation: integer("generation").notNull(),
    payload: jsonb("payload").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    costUsd: numeric("cost_usd"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    unique("builder_messages_session_id_seq_key").on(table.sessionId, table.seq),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [builderSessions.id],
      name: "builder_messages_session_id_fkey",
    }).onDelete("cascade"),
    index("builder_messages_by_session").on(table.sessionId, table.seq),
  ],
);

export const recipeApplies = pgTable(
  "recipe_applies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    guildId: text("guild_id"),
    createdGuild: boolean("created_guild").notNull().default(false),
    status: text("status").notNull(),
    recipeBodyVersion: integer("recipe_body_version").notNull(),
    preview: jsonb("preview").notNull().default(sql`'{}'::jsonb`),
    plan: jsonb("plan").notNull().default(sql`'{}'::jsonb`),
    checklist: jsonb("checklist").notNull().default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    check(
      "recipe_applies_status_check",
      sql`${table.status} IN ('preview', 'skeleton', 'checklist', 'ready', 'aborted')`,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "recipe_applies_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.recipeId],
      foreignColumns: [recipes.id],
      name: "recipe_applies_recipe_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: "recipe_applies_created_by_user_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "recipe_applies_guild_id_fkey",
    }).onDelete("set null"),
    index("recipe_applies_by_org").on(table.orgId, table.updatedAt),
    index("recipe_applies_by_guild").on(table.guildId, table.updatedAt),
    uniqueIndex("recipe_applies_open_guild")
      .on(table.guildId)
      .where(sql`${table.guildId} IS NOT NULL AND ${table.status} IN ('skeleton', 'checklist')`),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check("attachments_kind_check", sql`${table.kind} IN ('image', 'file')`),
    check("attachments_bytes_check", sql`${table.bytes} > 0`),
    check(
      "attachments_mime_check",
      sql`${table.mime} IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')`,
    ),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "attachments_org_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.uploadedBy],
      foreignColumns: [users.id],
      name: "attachments_uploaded_by_fkey",
    }).onDelete("restrict"),
    index("attachments_by_org").on(table.orgId, table.createdAt),
  ],
);

export const guildRepositories = pgTable(
  "guild_repositories",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    connectionId: text("connection_id"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    githubId: bigint("github_id", { mode: "number" }),
  },
  (table) => [
    unique("guild_repositories_guild_name_key").on(table.guildId, table.name),
    check("guild_repositories_name_check", sql`${table.name} ~ '^[a-z][a-z0-9_-]{0,62}$'`),
    foreignKey({
      columns: [table.guildId],
      foreignColumns: [guilds.id],
      name: "guild_repositories_guild_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnections.id],
      name: "guild_repositories_connection_id_fkey",
    }).onDelete("cascade"),
    index("guild_repositories_by_connection").on(table.connectionId),
  ],
);
