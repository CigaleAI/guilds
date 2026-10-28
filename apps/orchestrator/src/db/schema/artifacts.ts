/** Artifacts, their collections and access, task and memory revisions, and attachments. */
import {
  check,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamptz, tsvector } from "./columns.js";
import { guilds, orgs, users } from "./organisations.js";

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

/** The mode an org or guild row of an access list gives every agent in it. */
export const ACCESS_MODES = ["read", "write"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

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
