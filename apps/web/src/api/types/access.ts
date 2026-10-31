/**
 * Shapes of the orchestrator's JSON API for tools, logins and access lists, as the app reads them.
 * Timestamps are ISO-8601 in UTC.
 */

/** A repository a GitHub connection's installation reaches. */
export type GithubRepository = {
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  url: string;
};

/** A repository this GitHub login's coding agents clone. */
export type GithubSelectedRepository = {
  name: string;
  url: string;
  default_branch: string;
};

export type AccessMode = "read" | "write";

/** What carries an access list: a note or a table. */
export type AccessTarget = { kind: "note" | "collection" | "file"; id: string };

/** Who an access row names: the organisation, a guild, or one agent. */
export type AccessSubjectType = "org" | "guild" | "agent";

/** An access row's mode; `none` is for an agent row only and shuts that agent out. */
export type AccessListMode = AccessMode | "none";

/** One row of an access list as it is sent: the subject and its mode. */
export type AccessRow = { type: AccessSubjectType; id: string; mode: AccessListMode };

/**
 * One row of an access list as it is read, with the subject's name and guild: an agent's guild, a
 * guild itself, or null for the organisation.
 */
export type AccessEntry = AccessRow & {
  name: string;
  guild_id: string | null;
  guild_name: string | null;
};

/**
 * An item's access list: the organisation's row, then guilds', then agents'. `owner_agent_id` is
 * the agent that owns an agent-level note: it always writes its own note, so no row names it. It
 * is null for tables and for guild and organisation notes.
 */
export type AccessList = { subjects: AccessEntry[]; owner_agent_id: string | null };

/** A note a guild's or an agent's rows reach, with the mode it ends up with. */
export type ReachedNote = {
  id: string;
  display_path: string;
  title: string;
  level: "agent" | "guild" | "org";
  owner_id: string;
  /** The name of the organisation, guild or agent that owns the note. */
  owner_name: string;
  /** The guild of a guild or agent note; null for an organisation note. */
  guild_id: string | null;
  mode: AccessMode;
};

/** A table a guild's or an agent's rows reach, with the mode it ends up with. */
export type ReachedTable = {
  id: string;
  name: string;
  purpose: string;
  display_path: string;
  scope: "guild" | "org";
  guild: { id: string; name: string } | null;
  mode: AccessMode;
};

/** What a guild's agents, or one agent, reach. */
export type Reach = { notes: ReachedNote[]; tables: ReachedTable[] };

/** A guild, whose rows its agents share, or one agent. */
export type ReachSubject = { type: "guild" | "agent"; id: string };

/** Where a binding is set, from the widest to the narrowest; the narrowest set one wins. */
export type BindingScope = "platform" | "org" | "guild" | "agent";

export type CatalogKind = "native_tool" | "mcp" | "mcp_tool";

/**
 * A tool or server as one agent gets it: the effective state, the scope whose binding
 * decided it (null when nothing is bound), and the agent's own binding when it has one.
 */
export type AccessBinding = {
  name: string;
  enabled: boolean;
  source_scope: BindingScope | null;
  overlay: { enabled: boolean; connection_id?: string | null } | null;
};

export type McpToolAccess = AccessBinding & {
  remote_name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** The result of an operator test call on a connected login. */
export type McpToolCallResult = {
  remote_name: string;
  name: string;
  content: string;
  truncated: boolean;
};

export type McpConnectionStatus = "connected" | "pending" | "disconnected";

/** A connected-tools server (MCP) and the login the agent uses, if any. */
/** One credential input a key-based connector asks for. */
export type ConnectorAuthField = {
  name: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
};

/** What a server says about itself beside its row: sign-in inputs, origin, and mark. */
export type ConnectorFacts = {
  auth_fields: ConnectorAuthField[];
  /** The JSON Schema of what a login stores beside its credentials, or null when it stores nothing. */
  settings_schema: Record<string, unknown> | null;
  source: "core" | "registry" | "local";
  verified: boolean;
  /** Whether the connector is still being tried out and may change or break. */
  experimental: boolean;
  publisher: string;
  logo_url: string | null;
};

export type McpServerAccess = Omit<AccessBinding, "name"> &
  ConnectorFacts & {
    id: string;
    slug: string;
    name: string;
    auth: "token" | "oauth";
    description: string;
    limitations?: string;
    setup_hint?: string;
    oauth_strategy: string;
    /** Whether this server can start the connector's sign-in; `unsupported` when it holds no client for it. */
    oauth_setup_state: "not_applicable" | "dynamic" | "configured" | "unsupported";
    /** Whether the connector is on for this box. */
    catalog_enabled: boolean;
    /** A remote server this organisation added of its own. */
    org_owned: boolean;
    connection_id: string | null;
    status: McpConnectionStatus | null;
    account_hint: string;
    /** Which scope's login the agent uses: its own, or one inherited from its guild or organisation. */
    connection_owner_scope: BindingScope | null;
    tools: McpToolAccess[];
    /** What the login stores beside its credentials, as its connector's `settings_schema` describes it. */
    settings: Record<string, unknown>;
    /** The login is signed in and connects once its settings are saved. */
    needs_settings: boolean;
  };

/** One value a connector setting may take: what it stores, and how the search box shows it. */
export type LookupOption = { value: unknown; label: string; detail?: string; image?: string };

export type AgentAccess = {
  tools: AccessBinding[];
  mcp: McpServerAccess[];
};

/** Whose tools and logins a view edits, or whose secrets it lists: one agent, one guild, or the organisation. */
export type AccessOwner = { scope: "agent" | "guild" | "org"; id: string };

/** A catalog item a binding switches: a native tool, a connector, or one of a connector's tools. */
export type BindingTarget = { kind: CatalogKind; id: string };

/**
 * One item switched for an owner; `resetFirst` when the owner's own binding holds no login, so it
 * is dropped first and nothing more is written when what the owner then inherits matches.
 */
export type BindingSwitch = { target: BindingTarget; enabled: boolean; resetFirst: boolean };

/** Many items set for an owner at once, or returned to what the owner inherits. */
export type BindingsChange = { targets: BindingTarget[]; enabled: boolean | "inherit" };

/** A login to a connected-tools server; OAuth logins start with a URL to sign in at. */
export type McpConnection = {
  id: string;
  status: McpConnectionStatus;
  settings?: Record<string, unknown>;
  /** Signed in, and connects once its settings are saved. */
  needs_settings?: boolean;
  authorization_url?: string;
  /** The host the sign-in sends the operator to. */
  authorization_host?: string;
  bindings?: unknown[];
};

/**
 * A key-based login's values, by the connector's field names, with the login's settings when its
 * connector stores some; empty for OAuth.
 */
export type McpCredentials = {
  [field: string]: string | McpServerAccess["settings"];
  settings?: McpServerAccess["settings"];
};

/** A login to start: the server signed in to, and the values a key-based login needs. */
export type McpConnectionInput = { serverId: string; credentials: McpCredentials };

/** What adding an organisation's own remote MCP server sends. */
export type OrgServerInput = {
  slug: string;
  display_name: string;
  url: string;
  auth: "none" | "token" | "oauth";
  oauth_strategy?: "dynamic";
  description: string;
};
