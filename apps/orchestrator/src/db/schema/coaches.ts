/** Studio and Builder sessions with their messages and drafts, recipes, and recipe applies. */
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
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { artifacts } from "./artifacts.js";
import { timestamptz } from "./columns.js";
import { guilds, orgs, users } from "./organisations.js";
import type { RecipeDocument } from "./recipe-document.js";

/** The source guild of a Studio session as the coach is shown it; `objective` when the guild has a description. */
export type StudioSourceGuild = { id: string; name: string; about: string; objective?: string };

/** The agent a Studio draft is for, as it was when the draft was made. */
export type StudioDraftTarget = { id: string; name: string; focus: string };

export const EVIDENCE_REF_KINDS = ["run_message", "group_message", "artifact", "task_revision", "memory_revision", "routine"] as const;
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];

/**
 * A reference the coach cites for a draft, checked against the tool result it names: the
 * coordinates the coach gave beside `kind` and `tool_message_seq`, with the hash and an excerpt
 * of what it cites.
 */
export type EvidenceRef = {
  kind: EvidenceRefKind;
  tool_message_seq: number;
  content_hash: string;
  excerpt: string;
  [coordinate: string]: unknown;
};

/** A reference the coach cited that did not check out, and why. */
export type EvidenceWarning =
  | { reason: "invalid_reference" }
  | { reason: "unknown_kind"; kind: string }
  | { reason: "missing_tool_message"; tool_message_seq: number }
  | { reason: "coordinates_not_in_tool_result"; kind: EvidenceRefKind; tool_message_seq: number };

export const studioSessions = pgTable(
  "studio_sessions",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    created_by_user_id: text("created_by_user_id"),
    created_by_name: text("created_by_name").notNull(),
    mode: text("mode", { enum: ["optimize", "create"] }).notNull(),
    source_guild_id: text("source_guild_id"),
    source_guild_snapshot: jsonb("source_guild_snapshot").$type<StudioSourceGuild>().notNull(),
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
    target_snapshot: jsonb("target_snapshot").$type<StudioDraftTarget>().notNull(),
    source_artifact_id: text("source_artifact_id"),
    source_display_path: text("source_display_path"),
    base_version: integer("base_version").notNull(),
    base_hash: text("base_hash").notNull(),
    base_content: text("base_content").notNull(),
    proposed_content: text("proposed_content").notNull(),
    rationale: text("rationale").notNull(),
    evidence_refs: jsonb("evidence_refs").$type<EvidenceRef[]>().notNull().default(sql`'[]'::jsonb`),
    evidence_warnings: jsonb("evidence_warnings").$type<EvidenceWarning[]>().notNull().default(sql`'[]'::jsonb`),
    risks: jsonb("risks").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
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
    body: jsonb("body").$type<RecipeDocument>().notNull(),
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

/** A page or database a recipe connection points its agents at. */
export type ConnectionResource = {
  kind: "database" | "page" | "other";
  id: string;
  title: string;
  url?: string;
  use?: string;
};

/** A role's agent as an apply names it; `agent_id` once the skeleton created it. */
export type PlannedAgent = { role: string; name: string; agent_id?: string | undefined };

/** What an apply does about one recipe connection: reuse a live connection, or have the operator create one. */
export type PlannedConnection = {
  server: string;
  auth: "oauth" | "token" | "none";
  recommended_scope: "guild" | "agent";
  reusable: Array<{ id: string; owner_scope: string; status: string }>;
  action: "reuse" | "create";
  connection_id: string | null;
  setup: string;
  resources: ConnectionResource[];
  /** The recipe's tool overlays are bound on the reused connection. */
  bound?: boolean;
};

/** What an apply does about one recipe secret: create it, reuse the organisation's of that name, rename, or skip it. */
export type PlannedSecret = {
  name: string;
  description: string;
  collision: boolean;
  action: "create" | "reuse" | "rename" | "skip";
  dest_name: string;
  recommended_scope: "guild" | "agent";
  roles: string[];
};

/** A recipe collection as the skeleton left it: created or reused, with its live id. */
export type PlannedCollection = {
  name: string;
  action: "create" | "reuse" | "conflict";
  collection_id: string | null;
  guild: "read" | "write";
  writers: string[];
};

/** What an apply created and decided, read back by its checklist and activation. */
export type ApplyPlan = {
  names: PlannedAgent[];
  connections: PlannedConnection[];
  secrets: PlannedSecret[];
  collections: PlannedCollection[];
  /** The routine keys activation unpauses. */
  activate_keys: string[];
};

export const APPLY_STEP_KINDS = ["connection", "overlays", "repository", "secret", "browser", "external", "activate"] as const;
export type ApplyStepKind = (typeof APPLY_STEP_KINDS)[number];

/**
 * One step of an apply's checklist. A `verified` step closes when the server checks it; a
 * `confirmed` one when the operator says so.
 */
export type ApplyStep = {
  id: string;
  kind: ApplyStepKind;
  title: string;
  setup?: string;
  closure: "verified" | "confirmed";
  status: "open" | "verified" | "confirmed" | "skipped";
  /** How a closed step ended: done, left for later, skipped, or the routines activated. */
  resolution?: "done" | "later" | "skipped" | "activated";
  closed_at?: string;
  /** A browser step's site and role, and that it may wait until after activation. */
  site?: string;
  role?: string;
  deferrable?: boolean;
  phase?: "post_apply";
};

/** A finding of the apply's preview, or a step the operator skipped. */
export type ApplyWarning = {
  code: string;
  severity?: "error" | "warning" | "info";
  path: string;
  message: string;
};

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
    /** The preview the apply was made from, kept as the operator saw it; never read back. */
    preview: jsonb("preview").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    plan: jsonb("plan").$type<ApplyPlan>().notNull().default(sql`'{}'::jsonb`),
    checklist: jsonb("checklist").$type<ApplyStep[]>().notNull().default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings").$type<ApplyWarning[]>().notNull().default(sql`'[]'::jsonb`),
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
