/** Users, organisations and their members, guilds and their operators, and machines. */
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
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz } from "./columns.js";

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

/** How many agents a guild holds, and how many messages its agents post to its group chat, unless it says otherwise. */
export const DEFAULT_GUILD_AGENTS = 15;
export const DEFAULT_AGENT_MESSAGE_LIMIT = 200;

/** A group chat delivery that failed, as the guild's chat state lists it. */
export type GroupChatFailure = {
  at: string;
  agent_id: string;
  operation: string;
  error_type: string;
  message: string;
};

export const guilds = pgTable(
  "guilds",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    created_at: timestamptz("created_at").notNull(),
    updated_at: timestamptz("updated_at").notNull(),
    group_chat_seq: bigint("group_chat_seq", { mode: "number" }).notNull().default(0),
    group_agent_message_count: integer("group_agent_message_count").notNull().default(0),
    group_agent_message_limit: integer("group_agent_message_limit").notNull().default(DEFAULT_AGENT_MESSAGE_LIMIT),
    group_chat_errors: jsonb("group_chat_errors").$type<GroupChatFailure[]>().notNull().default(sql`'[]'::jsonb`),
    group_chat_cleared_at: timestamptz("group_chat_cleared_at"),
    about: text("about").notNull().default(""),
    org_id: text("org_id").notNull(),
    visibility: text("visibility", { enum: ["org", "private"] }).notNull().default("org"),
    routines_enabled: boolean("routines_enabled").notNull().default(true),
    description: text("description").notNull().default(""),
    max_agents: integer("max_agents").notNull().default(DEFAULT_GUILD_AGENTS),
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

/** The machine every new organisation starts with. */
export const DEFAULT_MACHINE_NAME = "default";
export const DEFAULT_MACHINE_BOX = "standard";
/** A machine's disk cap in MiB, over every agent home on it. */
export const DEFAULT_MACHINE_MAX_WORKSPACE_MIB = 10240;

export const machines = pgTable(
  "machines",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    name: text("name").notNull(),
    box: text("box", { enum: ["standard", "code", "custom"] }).notNull(),
    cpu: numeric("cpu"),
    memory_mib: integer("memory_mib"),
    max_workspace_mib: integer("max_workspace_mib").notNull().default(DEFAULT_MACHINE_MAX_WORKSPACE_MIB),
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
