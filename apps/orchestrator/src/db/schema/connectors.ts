/** Secrets, connectors and their manifests, connections and their tools and calls, bindings, a guild's repositories, and the model and integration keys. */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { Type, type Static } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { bytea, timestamptz } from "./columns.js";
import { guilds, orgs, users } from "./organisations.js";

/** A connector slug: also the folder name, the server id after `mcp_`, and a folder connector's tool prefix. */
export const SLUG_PATTERN = "^[a-z][a-z0-9_]{0,62}$";

const JsonObject = Type.Record(Type.String(), Type.Unknown());

/** A header an endpoint's session sends beside its credential: a custom `X-` header, letters, digits, and dashes. */
const HEADER_NAME_PATTERN = "^[Xx]-[A-Za-z0-9-]+$";

const ManifestTool = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    input_schema: JsonObject,
    mutating: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const AuthField = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }),
    label: Type.String({ minLength: 1 }),
    secret: Type.Optional(Type.Boolean()),
    optional: Type.Optional(Type.Boolean()),
    multiline: Type.Optional(Type.Boolean()),
    placeholder: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const Auth = Type.Object(
  {
    kind: Type.Union([Type.Literal("token"), Type.Literal("oauth"), Type.Literal("none")]),
    fields: Type.Optional(Type.Array(AuthField, { minItems: 1 })),
    header: Type.Optional(Type.Object({ name: Type.String({ minLength: 1 }), prefix: Type.String() }, { additionalProperties: false })),
    oauth: Type.Optional(
      Type.Object(
        {
          strategy: Type.Union([Type.Literal("dynamic"), Type.Literal("configured"), Type.Literal("github_app")]),
          provider: Type.Optional(Type.String({ minLength: 1 })),
          scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    ),
    instance: Type.Optional(
      Type.Union([
        Type.Object(
          { integration: Type.String({ minLength: 1 }), field: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }) },
          { additionalProperties: false },
        ),
        Type.Object({ own: Type.Literal(true) }, { additionalProperties: false }),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const ManifestSchema = Type.Object(
  {
    slug: Type.String({ pattern: SLUG_PATTERN }),
    display_name: Type.String({ minLength: 1 }),
    endpoint: Type.Optional(
      Type.Object(
        {
          url: Type.String({ minLength: 1 }),
          headers: Type.Optional(
            Type.Record(Type.String({ pattern: HEADER_NAME_PATTERN }), Type.String(), { additionalProperties: false }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    auth: Auth,
    requires: Type.Optional(Type.Object({ integration: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
    description: Type.String(),
    limitations: Type.Optional(Type.String()),
    setup_hint: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(ManifestTool)),
    policy: Type.Optional(
      Type.Object(
        {
          default_off: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
    ),
    settings_schema: Type.Optional(JsonObject),
    state: Type.Optional(
      Type.Object({ key: Type.String({ pattern: "^[a-z][a-z0-9_]*$" }), intro: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ),
    builder: Type.Optional(
      Type.Object(
        {
          searchable: Type.Optional(Type.Boolean()),
          role: Type.Optional(Type.String({ minLength: 1 })),
          guidance: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    prompt: Type.Optional(Type.Object({ guidance: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

export type Manifest = Static<typeof ManifestSchema>;
export type ManifestTool = Static<typeof ManifestTool>;
export type AuthField = Static<typeof AuthField>;

/** An admin's edit to one tool, by name: its copy, its schema, and whether it starts On. */
export type ToolOverride = {
  description?: string;
  input_schema?: Record<string, unknown>;
  default?: boolean;
};

/** An admin's edits to a connector the box did not write: copy fields and tools, applied on read. */
export type Overrides = {
  display_name?: string;
  description?: string;
  limitations?: string;
  setup_hint?: string;
  tools?: Record<string, ToolOverride>;
};

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
