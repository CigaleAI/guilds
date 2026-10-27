/** The logs of changes to files and to configuration, with who made each. */
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents, runs } from "./agents.js";
import { artifacts } from "./artifacts.js";
import { studioSessions } from "./coaches.js";
import { timestamptz } from "./columns.js";
import { guilds, orgs } from "./organisations.js";

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
