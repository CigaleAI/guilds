/** Shapes of the orchestrator's JSON API, as the app reads them. Timestamps are ISO-8601 in UTC. */

export type AuthMode = "compat-cookie" | "trusted-header" | "session";

/** How the server identifies a request. An edition that signs people in adds its methods to this. */
export type AuthConfig = {
  mode: AuthMode;
};

/** How far an integration is set up: `incomplete` has some of its required fields and lacks others. */
export type IntegrationState = "on" | "off" | "incomplete";

/** Where an integration's values come from: entered under Admin → Platform keys, or the server's environment. */
export type IntegrationSource = "store" | "env";

/** One value an integration takes, and whether the server holds it; never the value itself. */
export type IntegrationField = {
  name: string;
  label: string;
  optional: boolean;
  secret: boolean;
  multiline: boolean;
  set: boolean;
};

/** An optional integration of this server: what it switches on, where its values come from, and which are set. */
export type InstanceIntegration = {
  id: string;
  label: string;
  /** What the server gains while the integration is on. */
  enables: string;
  source: IntegrationSource;
  state: IntegrationState;
  fields: IntegrationField[];
  /** A guided setup the integration offers beside its form. */
  setup: "github-app-manifest" | null;
  /** When and by whom its values were last entered; null for everyone but a platform admin. */
  updated_at: string | null;
  set_by: string | null;
  /** The native tools and connector slugs it switches on. */
  provides: { native_tools: string[]; connectors: string[] };
};

/** `PUT`/`DELETE /api/admin/instance/keys/:integration`: the integration after the change, and the logins it dropped. */
export type InstanceKeysResult = { integration: InstanceIntegration; disconnected: number };

/** `POST /api/admin/instance/keys/github-app/manifest`: where the browser posts the manifest, and the manifest. */
export type GithubAppManifestStart = {
  action: string;
  manifest: Record<string, unknown>;
  state: string;
};

/** What this server is: how it identifies a request and which integrations it has. */
export type Instance = {
  auth_mode: AuthMode;
  integrations: InstanceIntegration[];
};

export type User = {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
  timezone: string | null;
  /** Identity colour, a 6-digit hex; null until they choose one. */
  color: string | null;
  created_at: string;
  updated_at: string;
  /** An owner of the platform organisation: the Admin page and the platform routes answer them. */
  platform_admin: boolean;
};

export type OrgRole = "owner" | "admin" | "member";

export type Org = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  role: OrgRole;
};

export type GuildOperator = {
  user_id: string;
  name: string;
  role: "admin" | "operator";
};

export type Guild = {
  id: string;
  name: string;
  /** Short description, up to 200 characters. */
  about: string;
  /** Markdown, up to 8000 characters. */
  description: string;
  max_agents: number;
  /** Verified GitHub email for coding-agent commits; empty uses `<agent id>@agents.guilds.run`. */
  git_author_email: string;
  archived_at: string | null;
  visibility: "org" | "private";
  operators: GuildOperator[];
  routines_enabled: boolean;
};

export type Agent = {
  id: string;
  guild_id: string;
  name: string;
  focus: string;
  /** `<style>:<seed>` for generated art, or a bare seed for the clay style. */
  avatar_shape: string;
  /** `#rrggbb`. */
  avatar_color: string;
  browser: boolean;
  /** Code tools, with Node.js, build tools and git on its machine. */
  coding: boolean;
  /** The organisation's machine it runs on. */
  machine_id: string;
  machine: MachineRef;
  archived_at: string | null;
  /** A run is generating for this agent right now. */
  generating: boolean;
};

export type ThinkingLevel = "none" | "low" | "medium" | "high";

/**
 * A machine's tier: `standard` hosts agents without coding, `code` is the larger machine coding
 * agents need, and `custom` is sized by an owner or admin and hosts any agent.
 */
export type MachineBox = "standard" | "code" | "custom";

/** A machine as an agent payload names it. */
export type MachineRef = { id: string; name: string; box: MachineBox };

/** An agent on a machine, with what it runs there. */
export type MachineAgent = {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  browser: boolean;
  coding: boolean;
};

/** `GET /api/orgs/:id/machines`: one of the organisation's machines, its agents, and what they use. */
export type Machine = MachineRef & {
  cpu: number;
  memory_mib: number;
  /** The disk cap in MiB, over every agent home on the machine. */
  max_workspace_mib: number;
  /** Every agent home on it, measured after a generation; null before one. */
  workspace_mib: number | null;
  /** The memory its agents plan to use when they all work at once. */
  planned_mib: number;
  /** Its agents in guilds the viewer can see. */
  agents: MachineAgent[];
  /** How many of its agents sit in guilds the viewer cannot see; `planned_mib` counts them too. */
  hidden_agents: number;
};

/** A machine to create, or the fields to change; `cpu` and `memory_mib` only on custom. */
export type MachineInput = {
  name: string;
  box: MachineBox;
  cpu?: number;
  memory_mib?: number;
  max_workspace_mib?: number;
};

export type AgentConfig = {
  model: string;
  temperature: number;
  max_tokens: number;
  max_steps: number;
  max_tool_calls: number;
  max_input_tokens: number;
  /** User turns, including the current one, whose tool results stay in the model prompt. */
  keep_tool_result_generations: number;
  max_scripts: number;
  /** The agent home's cap in MiB. A generation will not start while the home is over this. */
  max_workspace_mib: number;
  cli: boolean;
  browser: boolean;
  /** Chrome UI and Accept-Language. Default `en-US`. */
  browser_language: string;
  coding: boolean;
  scripting: boolean;
  memory: boolean;
  thinking_level: ThinkingLevel;
};

/** One agent with its model settings; `access` is its resolved tools, secrets and grants. */
export type AgentDetail = Agent & {
  /** The untagged group-chat messages it wakes for; empty means its focus stands in. */
  wake_triggers: string;
  config: AgentConfig;
  /** The agent's home, measured after its last generation; null before one. */
  workspace_mib: number | null;
  access: Record<string, unknown>;
};

export type DeliveryError = {
  at: string;
  agent_id: string;
  operation: "group.delivery";
  error_type: string;
  message: string;
};

export type GroupChatState = {
  guild_id: string;
  chat_seq: number;
  agent_message_count: number;
  agent_message_limit: number;
  dispatching: boolean;
  pending_agent_count: number;
  active_agent_id: string | null;
  active_agent_name: string | null;
  limit_reached: boolean;
  errors: DeliveryError[];
  /** The last message this operator has seen; null when they never opened the chat. */
  seen_through_seq?: number | null;
};

export type GroupMessage = {
  id: number;
  seq: number;
  author_type: "user" | "agent";
  author_name: string;
  author_agent_id: string | null;
  /** The run that produced an agent's post. */
  source_run_id: string | null;
  /** Markdown. Tags are written inline as `@name`. */
  content: string;
  tagged: string[];
  tagged_agent_ids: string[];
  tagged_user_ids: string[];
  created_at: string;
};

export type AgentBrief = {
  id: string;
  name: string;
  avatar_shape: string;
  avatar_color: string;
};

export type IssueKind = "tool_failure" | "truncated" | "api" | "other";
export type IssueSeverity = "low" | "medium" | "high";
export type IssueStatus = "open" | "resolved";

export type Issue = {
  id: string;
  guild_id: string;
  agent_id: string | null;
  agent_name: string;
  run_id: string | null;
  kind: IssueKind;
  severity: IssueSeverity;
  status: IssueStatus;
  summary: string;
  detail: string;
  tool_name: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  agent: AgentBrief | null;
};

export type MentionNotice = {
  id: number;
  guild_id: string;
  guild_name: string;
  seq: number;
  author_type: "user" | "agent";
  author_name: string;
  content: string;
  created_at: string;
  agent: AgentBrief | null;
};

export type Notifications = {
  issues: (Issue & { guild_name: string })[];
  mentions: MentionNotice[];
};

export type RunKind = "direct" | "group" | "schedule";

export type RunError = {
  at: string;
  generation: number;
  /** Where it failed: "llm.complete", "generation.max_steps", "generation.cancelled"… */
  operation: string;
  error_type: string;
  message: string;
};

/** A tool as offered to the model: its OpenAI function schema. */
export type OfferedTool = {
  type?: string;
  name?: string;
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
};

export type RunConfigSnapshot = AgentConfig & {
  projection_policy_version?: number;
  tools: OfferedTool[];
  mcp: {
    connection_id: string;
    server_id: string;
    slug: string;
    tools: { name: string; remote_name: string }[];
  }[];
  secrets: { id: string; name: string; description: string }[];
};

export type Run = {
  id: string;
  agent_id: string;
  /** "completed" runs take no more messages until resumed. */
  status: "active" | "completed";
  kind: RunKind;
  config_snapshot: RunConfigSnapshot;
  errors: RunError[];
  generating: boolean;
  memory_skipped: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  group_chat_through_seq: number | null;
  schedule_id?: string;
  /** A coding run's exploration before its first edit. */
  exploration?: RunExploration;
  /** What a coding run changed in each repository, between its checkpoints. */
  repos?: RunRepositoryChange[];
  /** A coding run's place in a run chain, when it continues an earlier run. */
  chain?: { root_run_id: string; index: number; previous_run_id: string };
  /** The run that continued this one after its hand-off. */
  continued_by_run_id?: string;
};

export type RunExploration = {
  calls_before_first_edit: number | null;
  read_bytes_unedited: number;
};

/** One repository's change over a run: its start and end checkpoints and their diffstat. */
export type RunRepositoryChange = {
  name: string;
  branch: string | null;
  head_sha: string | null;
  start_sha: string | null;
  end_sha: string;
  files_changed: number;
  insertions: number;
  deletions: number;
};

/** A git repository of a guild, cloned into each coding agent's workspace. */
export type GuildRepository = {
  id: string;
  guild_id: string;
  name: string;
  url: string;
  default_branch: string;
  connection_id: string | null;
  connection: { id: string; status: McpConnectionStatus | null; account_hint: string } | null;
  created_at: string;
  updated_at: string;
};

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

/** A daily random wake window, in local time of its time zone. */
export type WakeWindow = { timezone: string; start: string; end: string; max_wakes: number };

/** A routine: wakes its agent on a UTC cron expression or within a daily window. */
export type Schedule = {
  id: string;
  agent_id: string;
  cron: string | null;
  window: WakeWindow | null;
  /** The timing in words, such as "Every hour at :35". */
  label: string;
  /** The routine's description, or the first line of its instruction. */
  description: string;
  instruction: string;
  instruction_hash: string;
  paused: boolean;
  /** False while the guild's routines are off: the routine is held and does not fire. */
  guild_routines_enabled?: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A new routine: exactly one of `cron` (UTC) or `window`. */
export type ScheduleInput =
  | { cron: string; description: string; instruction: string }
  | { window: WakeWindow; description: string; instruction: string };

/** One row of a run: system prompt, user turn, assistant turn (with tool calls) or tool result. */
export type RunMessage = {
  id: number;
  seq: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
};

/** A Task version the save replaced; kept so it can be restored. */
export type TaskRevision = {
  version: number;
  content: string;
  replaced_at: string;
  replaced_by_name: string | null;
};

/**
 * An agent's Task (`task.md`), the operator's part of its system prompt. Without the artifact
 * store it carries only `path` and `content`, and has no versions.
 */
export type TaskFile = {
  path: string;
  content: string;
  display_path?: string;
  version?: number;
  /** Newest first. */
  revisions?: TaskRevision[];
};

export type NoteLevel = "org" | "guild" | "agent";

/** A note a Task can embed as `![[display_path]]`. */
export type EmbeddableNote = {
  display_path: string;
  kind: "note";
  level: NoteLevel;
  /** The note's file name, such as `process.md`. */
  key: string;
  title: string | null;
  author: string | null;
  version: number;
  updated_at: string;
  content: string;
};

export type ColumnType = "text" | "number" | "boolean" | "datetime" | "array";

/** One column of a database: its type, whether it is required or unique, and its allowed values. */
export type Column = {
  name: string;
  type: ColumnType;
  description: string;
  required: boolean;
  unique: boolean;
  /** Allowed values, for text and array columns. */
  values?: string[];
};

/**
 * A database: records with typed columns. An organisation database is reached through grants; a
 * guild's own database is written by that guild's agents only. A Task embeds one as
 * `![[org/<org_id>/collections/<name>]]`.
 */
export type Collection = {
  id: string;
  name: string;
  purpose: string;
  columns: Column[];
  display_path: string;
  scope: "org" | "guild";
  guild: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
  /** Live records. */
  count?: number;
};

export type AccessMode = "read" | "write";

/** Who reaches a database, as its detail lists them. */
export type CollectionAccessList = {
  guilds: { id: string; name: string; mode: AccessMode }[];
  agents: {
    id: string;
    name: string;
    guild_id: string;
    guild_name: string;
    guild_mode: AccessMode | null;
    agent_mode: AccessMode | "none" | null;
    effective: AccessMode | null;
  }[];
};

/** A record: its id, its column values, and who last wrote it. */
export type CollectionRecord = {
  id: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  version: number;
  display_path: string;
  [column: string]: unknown;
};

export type RecordsPage = { total: number; records: CollectionRecord[]; columns: Column[] };

/** A database as a guild reaches it: its own are always written; organisation ones by grant. */
export type GuildCollectionAccess = {
  collection_id: string;
  name: string;
  purpose: string;
  scope: "org" | "guild";
  mode: AccessMode | null;
};

/** A database as an agent reaches it: the guild's grant, the agent's own choice, and the result. */
export type AgentCollectionAccess = {
  collection_id: string;
  name: string;
  purpose: string;
  scope: "org" | "guild";
  guild_mode: AccessMode | null;
  agent_mode: AccessMode | "none" | null;
  effective: AccessMode | null;
};

/** A column as a database definition sends it; `rename_from` renames a current column. */
export type ColumnInput = Column & { rename_from?: string };

/** Per agent, the Task embeds that no longer resolve; a run cannot start until they do. */
export type EmbedStatus = { agents: { id: string; broken_embeds: string[] }[] };

/** One recorded write to a file: who made it, and the run and tool call when an agent did. */
export type FileChange = {
  id: string;
  display_path: string;
  operation: string;
  version: number;
  actor: { type: "user" | "agent" | "run" | "unknown"; id: string | null; name: string | null };
  run: { id: string; agent_id: string; guild_id?: string; kind: RunKind } | null;
  tool: { name: string; call_id: string | null } | null;
  created_at: string;
  /** False for a file saved before the change log started. */
  recorded?: boolean;
};

/** Where a binding is set, from the widest to the narrowest; the narrowest set one wins. */
export type BindingScope = "platform" | "org" | "guild" | "agent";

export type CatalogKind = "native_tool" | "mcp" | "mcp_tool" | "artifact_grant";

/**
 * A tool, grant or server as one agent gets it: the effective state, the scope whose binding
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

/** A GitHub login a guild may use when adding repositories. */
export type GithubLogin = {
  id: string;
  owner_scope: BindingScope;
  owner_id: string | null;
  account_hint: string;
  status: McpConnectionStatus;
};

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
  grants: AccessBinding[];
  mcp: McpServerAccess[];
};

/**
 * One guild or agent a secret is granted to. A grant in a guild the viewer cannot see keeps its
 * kind and shows no id or name.
 */
export type SecretGrant = { kind: "guild" | "agent"; id: string | null; name: string | null };

/**
 * An organisation's secret: its name is the environment variable agents' commands get, its
 * description tells agents how to use it. The value is never returned.
 */
export type Secret = {
  id: string;
  name: string;
  description: string;
  /** Every agent of the organisation gets it; `grants` is then empty. */
  org_wide: boolean;
  grants: SecretGrant[];
  /** The operator who added it, or the agent that stored it with secret_store. */
  created_by: { kind: "user" | "agent"; id: string | null; name: string | null } | null;
  created_at: string;
  updated_at: string;
  rotated_at: string;
  /** The viewer may edit, rotate and delete it. */
  can_manage: boolean;
};

/** Who gets a secret; neither organisation-wide nor granted leaves it unassigned. */
export type SecretAccessChoice = { org_wide: boolean; guild_ids: string[]; agent_ids: string[] };

export type NewSecret = SecretAccessChoice & { name: string; value: string; description: string };

/** A secret's edit: any of a new name, description or value. */
export type SecretChanges = { name?: string; description?: string; value?: string };

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

/** A key-based login's values, by the connector's field names; empty for OAuth. */
export type McpCredentials = Record<string, unknown>;

/** An agent's lifetime model usage; cost is what providers reported, or catalog rates without it. */
export type AgentUsage = {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** Input plus output; cache reads are counted apart. */
  total_tokens: number;
  cost_usd: number;
  calls: number;
  updated_at: string | null;
  /** The agent's home, measured after the last generation; null before one. */
  workspace_mib: number | null;
  /** The agent's home cap in MiB. */
  max_workspace_mib: number;
  /** The agent's machine: every agent home on it against the machine's disk cap. */
  machine: { id: string; name: string; workspace_mib: number | null; max_workspace_mib: number };
};

/** A model the organisation offers, with what it takes and costs as the catalog says. */
export type CatalogModel = {
  id: string;
  model: string;
  provider: ModelProvider;
  label: string;
  thinking: boolean;
  temperature: boolean;
  attachments: boolean;
  /** The context window in tokens; null when the catalog does not say. */
  context: number | null;
  /** USD per million tokens; null for an unbilled provider or a row without a price. */
  price: { input: number; output: number; cache_read: number } | null;
  kind: "marketplace" | "coding";
  coding_only: boolean;
};

/** An uploaded chat image the operator attached to a direct-chat message. */
export type ChatAttachment = {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  kind: "image" | "file";
  url: string;
  created_at: string;
};

/** The reference stored on a user message after upload. */
export type MessageAttachment = {
  id: string;
  filename: string;
  mime: string;
  kind: "image" | "file";
};

export type ModelProvider = "openai" | "openrouter" | "xai" | "deepinfra" | "local" | "kimi";

/** A provider as the organisation sees it: connected or not, and the last characters of its key. */
export type OrgModelProvider = {
  id: ModelProvider;
  label: string;
  kind: "marketplace" | "coding";
  connected: boolean;
  key_hint: string | null;
  /** The local endpoint's URL once saved; null for every other provider. */
  base_url: string | null;
};

/** `GET /api/orgs/:id/models`: the default, each provider's state, and the chosen models every picker lists. */
export type OrgModels = {
  default: string | null;
  providers: OrgModelProvider[];
  models: CatalogModel[];
};

export function marketplaceModels(models?: OrgModels): CatalogModel[] {
  return (models?.models ?? []).filter((item) => item.kind !== "coding");
}

export function isCodingOnlyModel(modelId: string, models?: OrgModels): boolean {
  const entry = models?.models.find((item) => item.id === modelId);
  if (entry) {
    return entry.coding_only;
  }
  return modelId.startsWith("kimi/");
}

/** Whether any provider is connected; null while the organisation's models are still loading. */
export function hasConnectedProvider(models?: OrgModels): boolean | null {
  if (!models) return null;
  return models.providers.some((item) => item.connected);
}

/** A settings save: the whole model config, and the name, machine, focus, wake triggers and look when they change. */
export type AgentSettingsInput = {
  name?: string;
  config: AgentConfig;
  /** The machine to move the agent to; absent keeps it where it is. */
  machine_id?: string;
  focus?: string;
  wake_triggers?: string;
  avatar_shape?: string;
  avatar_color?: string;
};

/** A routine with the agent it wakes, as a guild lists them. */
export type GuildSchedule = Schedule & { agent: AgentBrief };

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  calls: number;
  updated_at: string | null;
};

/** A guild's lifetime model usage, with each agent's share. */
export type GuildUsage = UsageTotals & {
  id: string;
  name: string;
  agents: (UsageTotals & AgentBrief)[];
};

/** What a guild settings save may change; left-out fields keep their value. */
export type GuildInput = Partial<
  Pick<
    Guild,
    | "name"
    | "about"
    | "description"
    | "max_agents"
    | "git_author_email"
    | "routines_enabled"
    | "visibility"
  >
>;

export type OrgMember = {
  user_id: string;
  name: string;
  image: string | null;
  /** Identity colour, a 6-digit hex; null until they choose one. */
  color: string | null;
  role: OrgRole;
  created_at: string;
};

/** A note in a notes scope; `path` is its file name, such as `process.md`. */
export type FileItem = {
  path: string;
  display_path: string;
  kind: "note";
  title: string | null;
  version: number;
};

export type FileContent = { path: string; content: string; display_path: string; version?: number };

/** A Python script in the agent's home. One with parameters is also a tool named after it. */
export type Script = {
  name: string;
  description: string;
  /** A JSON Schema object for the tool's arguments, or null for a plain script. */
  parameters: Record<string, unknown> | null;
  source: string;
  display_path?: string;
};

/** One organisation's usage by guild and agent, with the coach and deleted guilds as rows of their own. */
export type OrgUsage = UsageTotals & {
  id: string;
  name: string;
  slug: string;
  studio: UsageTotals | null;
  archived: UsageTotals | null;
  guilds: (UsageTotals & { id: string; name: string; agents: (UsageTotals & AgentBrief)[] })[];
};

/** A tool of a catalog connector: from its manifest, or one an admin edited after a login listed it. */
export type CatalogTool = {
  remote_name: string;
  namespaced_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  mutating: boolean;
  /** Whether a new login's tool starts On. */
  default_enabled: boolean;
  /** The admin's default, or null when the manifest decides. */
  default_override: boolean | null;
  overridden: boolean;
};

/** A copy field an admin may override on a connector the box did not write. */
export type CatalogCopyField = "display_name" | "description" | "limitations" | "setup_hint";

/** An installed connector, as the instance admin sees and edits it. */
export type CatalogServer = ConnectorFacts & {
  id: string;
  slug: string;
  display_name: string;
  auth: "none" | "token" | "oauth";
  oauth_strategy: "none" | "dynamic" | "configured";
  oauth_setup_state: string;
  description: string;
  limitations: string | null;
  setup_hint: string | null;
  url: string | null;
  enabled: boolean;
  tool_prefix: string;
  version: string;
  /** `fields`: a server made on this box, edited in place. `overrides`: edits sit over its manifest. */
  editable: "fields" | "overrides";
  upstream: {
    display_name: string;
    description: string;
    limitations: string | null;
    setup_hint: string | null;
  };
  overridden: CatalogCopyField[];
  tools: CatalogTool[];
};

/** What a registry index lists for one package: its newest version, beside every version it offers. */
type RegistryEntry = {
  version: string;
  versions: string[];
  path: string;
  sha256: string;
  size: number;
  publisher: string;
  verified: boolean;
  display_name: string;
  description: string;
};

/** A connector in `GET /api/admin/registry`, with what the box has installed under its slug. */
export type RegistryConnector = RegistryEntry & {
  slug: string;
  /** Whether the connector is still being tried out; installing or updating it needs `experimental`. */
  experimental?: boolean;
  installed: { source: string; version: string } | null;
};

/** `GET /api/admin/registry`: the registry's connectors; `offline` when `REGISTRY_URL` is set empty. */
export type RegistryConnectors = {
  offline: boolean;
  url: string | null;
  connectors: RegistryConnector[];
};

/** `POST /api/admin/registry/reload`: the slugs the running server loaded, dropped, or failed to load. */
export type RegistryReload = { loaded: string[]; removed: string[]; failed: string[] };

/** A recipe in `GET /api/recipes/registry`. */
export type RegistryRecipe = RegistryEntry & { name: string };

/** `GET /api/recipes/registry`: the registry's recipes; `offline` when `REGISTRY_URL` is set empty. */
export type RegistryRecipes = { offline: boolean; url: string | null; recipes: RegistryRecipe[] };

/** What the Admin form sends: a new server's fields, or a patch; null clears an override. */
export type CatalogServerInput = {
  slug?: string;
  display_name?: string | null;
  url?: string;
  auth?: "none" | "token" | "oauth";
  oauth_strategy?: "none" | "dynamic" | "configured";
  description?: string | null;
  limitations?: string | null;
  setup_hint?: string | null;
  enabled?: boolean;
};

/** An edit to one tool; null clears that part of the edit. */
export type CatalogToolInput = {
  description?: string | null;
  input_schema?: Record<string, unknown> | null;
  default?: boolean | null;
};

/**
 * A Studio session: a coach conversation about one live guild. The coach proposes Task drafts
 * and edits; the operator applies or publishes them.
 */
export type StudioSession = {
  id: string;
  org_id: string;
  mode: "optimize";
  status: "active" | "blocked" | "archived";
  blocked_reason: "input_token_limit" | "source_deleted" | null;
  generation_state: "idle" | "generating" | "cancelling";
  generation_number: number;
  source_guild_id: string;
  /** The guild as the session sees it: its name, short about text and longer description. */
  source_guild: { id: string; name: string; about: string; objective?: string } | null;
  selected_target_agent_id: string | null;
  parent_session_id: string | null;
  granted_connection_ids: string[];
  coach: {
    model: string;
    temperature: number;
    max_tokens: number;
    max_steps: number;
    max_tool_calls: number;
    max_input_tokens: number;
  };
  created_by_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

/** One row of the coach conversation, shaped like a run's rows. */
export type StudioMessage = {
  id: number;
  session_id: string;
  seq: number;
  generation: number;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  cost_usd: number | null;
  created_at: string;
};

/** An agent of the guild as Studio lists it: its Task version, latest run and pending draft. */
export type StudioAgent = {
  id: string;
  name: string;
  focus: string;
  avatar_shape: string;
  avatar_color: string;
  archived: boolean;
  task_version: number | null;
  task_excerpt: string;
  has_embeds: boolean;
  routine_count: number;
  latest_run: { id: string; kind: RunKind; status: string; at: string } | null;
  draft_id: string | null;
  draft_status: StudioDraft["status"] | null;
  warnings: ("empty_task" | "memory_skipped" | "generation_errors" | "stale_draft")[];
  publishable: boolean;
  /** Script tools and the Scripts tab; missing means on. */
  scripting: boolean;
};

/** One agent's prompt as Studio inspects it: its Task and the system prompt a run would get. */
export type StudioInspector = {
  agent: { id: string; name: string; focus: string; archived: boolean };
  task: {
    display_path: string | null;
    version: number | null;
    content: string;
    /** Hash of the Task a run receives now, with its embeds resolved. */
    effective_hash: string;
    effective_matches_source: boolean;
    has_embeds: boolean;
    embed_warning: string | null;
  };
  /** The guild guidelines every run receives. */
  guidelines: { content: string; content_hash: string };
  /** The agent's memory as a run receives it. */
  memory: { content: string; prompt_hash: string };
  effective_prompt: {
    content: string;
    task_content: string;
    latest_run: {
      id: string;
      kind: RunKind;
      created_at: string;
      guidelines_match: boolean;
      task_match: boolean;
      memory_match: boolean;
    } | null;
  };
  generating: boolean;
};

/** A proposed Task change for one agent, against the version it started from. */
export type StudioDraft = {
  id: string;
  session_id: string;
  target_agent_id: string;
  target_snapshot: { name?: string } | null;
  base_version: number;
  base_content: string;
  proposed_content: string;
  rationale: string;
  risks: unknown;
  status: "draft" | "conflicted" | "superseded" | "discarded" | "published" | "unchanged";
  draft_number: number;
  created_at: string;
  published_resource_version: number | null;
  size_delta_bytes: number;
  large_deletion: boolean;
};

/** An edit the coach asked to make to a memory, note, the guild or a table, waiting for the operator. */
export type StudioEdit = {
  status: "pending" | "applied" | "declined";
  stale: boolean;
  /**
   * The live text now: a note or memory, the guild's about and description, or a table's
   * definition and access written out line by line (empty for a table not created yet).
   */
  live: string | { about: string; description: string } | null;
  /** The text the edit writes, in the same shape as `live`; empty for a table it deletes. */
  proposed: string | { about: string; description: string } | null;
  /** What applying a table edit does to its records and readers. */
  effects?: string[];
  error?: string;
  applied_version?: number;
};

/** A login the coach may read through, once the operator grants it. */
export type StudioConnection = {
  id: string;
  server: { id: string; slug: string; display_name: string };
  owner_scope: BindingScope;
  owner_id: string | null;
  account_hint: string;
  status: McpConnectionStatus;
  granted: boolean;
  readable_tools: string[];
  tool_count: number;
};

/** A run as Studio's inspector lists it, without its transcript. */
export type StudioRun = {
  id: string;
  kind: RunKind;
  status: "active" | "completed";
  generating: boolean;
  task_prompt_hash: string | null;
  system_prompt_hash: string | null;
  memory_prompt_hash: string | null;
  schedule_id: string | null;
  /** Hash of the routine instruction the run fired with. */
  instruction_hash: string | null;
  group_chat_through_seq: number | null;
  created_at: string;
  updated_at: string;
  memory_skipped: boolean;
  error_count: number;
  last_error: RunError | null;
};

/** A routine as Studio lists it: the routine, how often it fired, and its latest run. */
export type StudioRoutine = Schedule & {
  run_count: number;
  latest_run: StudioRun | null;
};

/** Who wrote a memory version. */
export type MemoryActor = {
  type: "run" | "user" | "agent" | "unknown";
  id: string | null;
  name: string | null;
  detail: string | null;
};

/** One version of an agent's memory, newest first, with the change from the one before. */
export type MemoryVersion = {
  index: number;
  /** Null for the live version. */
  revision_id: string | null;
  archive_display_path: string | null;
  written_at: string | null;
  actor: MemoryActor;
  run_id: string | null;
  content: string;
  content_hash: string;
  /** Null for the oldest version on record. */
  previous_content: string | null;
  stats: { added: number; removed: number };
  run: {
    id: string;
    exists: boolean;
    kind?: RunKind;
    status?: string;
    schedule_id?: string | null;
    created_at?: string;
    memory_write?: { call_id: string | null; name: string } | null;
  } | null;
};

/** An agent's memory versions, as the agent's and Studio's Memory tabs read them. */
export type MemoryTimeline = {
  agent: { id: string; name: string };
  display_path: string;
  live: { version: number | string; content_hash: string } | null;
  entries: MemoryVersion[];
};

/**
 * Studio's activity ledger for one window of the session's guild: one entry per wake (a run of any
 * kind) with what started it and what it produced. The window runs `hours` back from `until`.
 * Timestamps are ISO-8601 in UTC.
 */

/** A member of the source guild; archived members stay listed so older wakes resolve. */
export type ActivityAgent = {
  id: string;
  name: string;
  avatar_color: string;
  avatar_shape: string;
  archived: boolean;
};

/**
 * A routine of the guild: the schedule a `schedule` wake fired from. `label` is its timing in
 * words; `instruction` is what each firing tells the agent.
 */
export type ActivityRoutine = {
  id: string;
  agent_id: string;
  description: string;
  label: string;
  instruction: string;
};

/**
 * A public row of the group chat. Rows the window's wakes answered can predate `since`.
 * `preview` holds the first 400 characters; `length` counts the full text.
 */
export type ActivityMessage = {
  seq: number;
  created_at: string;
  author_type: "user" | "agent";
  author_name: string;
  author_agent_id: string | null;
  /** The wake that posted the row; null for the operator's rows. */
  source_run_id: string | null;
  /** Names the row tags. */
  tagged: string[];
  preview: string;
  length: number;
};

/** The routing model's pick for an untagged row. */
export type ActivityRouting = {
  source: string;
  choice: string | null;
  confidence: number | null;
};

/**
 * Why a group wake started: the agent was tagged, the routing model chose it,
 * routing fell back, or the delivery rules picked it.
 */
export type ActivityTriggerReason = "tag" | "jev" | "rules" | "fallback";

/** What started a wake: a public row, a routine firing, or a direct chat. */
export type ActivityTrigger =
  | {
      type: "message";
      /** The row that woke the agent; null when the snapshot names none. */
      seq: number | null;
      /** The latest row in the wake's snapshot. */
      through_seq: number | null;
      reason: ActivityTriggerReason;
      routing: ActivityRouting | null;
    }
  | { type: "routine"; schedule_id: string | null }
  | { type: "direct" };

/** What a write touched: a collection record, a note, a script, the agent's memory, or a repository. */
export type ActivityWriteKind = "record" | "note" | "script" | "memory" | "code";

/** One file change a wake made inside the window. */
export type ActivityWrite = {
  kind: ActivityWriteKind;
  /** The collection for a record, `memory.md` for memory, otherwise the file name. */
  target: string;
  display_path: string;
  operation: string;
  tool_name: string | null;
  call_id: string | null;
  at: string;
  /** For `code`: what the wake changed in the repository. */
  code?: { branch: string | null; files_changed: number; insertions: number; deletions: number };
};

/** An error a wake recorded inside the window. */
export type ActivityError = { operation: string | null; message: string | null; at: string | null };

/**
 * A tool call a wake made inside the window, with its result's error and duration. `arguments`
 * holds the first 160 characters.
 */
export type ActivityToolCall = {
  call_id: string | null;
  name: string;
  arguments: string;
  error: string | null;
  duration_ms: number | null;
  at: string;
};

/** A public row a wake posted inside the window. */
export type ActivityPost = { seq: number; call_id: string | null; at: string };

/** One wake. The ledger lists wakes by `started_at`. */
export type ActivityWake = {
  run_id: string;
  agent_id: string;
  kind: "group" | "schedule" | "direct";
  /** When the run started; for a direct chat, its first message inside the window. */
  started_at: string;
  /** Its last message, or the time of the request while it runs. */
  ended_at: string;
  running: boolean;
  trigger: ActivityTrigger;
  /** `posted` when it posted a public row, `wrote` when it wrote anything but memory, else `silent`. */
  outcome: "posted" | "wrote" | "silent";
  /** True when it recorded an error inside the window. */
  failed: boolean;
  errors: ActivityError[];
  posts: ActivityPost[];
  writes: ActivityWrite[];
  /** Its tool calls in order, at most 200; `tool_call_count` counts them all. */
  tool_calls: ActivityToolCall[];
  tool_call_count: number;
  /** The last text it wrote inside the window, shortened to 400 characters. */
  reply: string | null;
  /** For a direct chat, the operator's first message inside the window. */
  opening: string | null;
  memory_skipped: boolean;
  /** Sequence of the run's last stored message; null when it has none. */
  last_seq: number | null;
  /** Spend inside the window, 0 when none was recorded. */
  cost_usd: number;
};

/** The whole ledger for one window. */
export type ActivityView = {
  guild_id: string;
  since: string;
  until: string;
  agents: ActivityAgent[];
  routines: ActivityRoutine[];
  messages: ActivityMessage[];
  wakes: ActivityWake[];
};

/**
 * Recipe documents (`guilds.recipe` version 2) and the recipe API's responses. File references
 * point at `apps/orchestrator/src`.
 */

/** Who last wrote a recipe field and whether an operator has confirmed it (recipes/schema.ts). */
export type FieldAuthor = { by: "operator" | "builder"; reviewed: boolean };

/** A recipe's title, description, creation time, and where it came from (recipes/schema.ts). */
export type RecipeMeta = {
  name: string;
  description: string;
  created_at: string;
  source: { kind: "guild" | "builder" | "file"; guild_id?: string; session_id?: string };
};

/** The guild a recipe creates: its suggested slug, about text, objective, and group message cap (recipes/schema.ts). */
export type RecipeGuild = {
  name_suggestion: string;
  about: string;
  objective: string;
  group_agent_message_limit: number;
};

/** A script a role ships with, and who wrote it (recipes/schema.ts). */
export type RecipeScript = {
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
  source: string;
  secrets: string[];
  author: FieldAuthor;
};

/** A routine of a role; exactly one of `cron` (UTC) or `window` is set (recipes/schema.ts). */
export type RecipeSchedule = {
  key: string;
  cron?: string;
  window?: WakeWindow;
  description: string;
  instruction: string;
  author: FieldAuthor;
};

/** The artifact grants a role's agent receives (recipes/schema.ts). */
export type RecipeGrants = {
  read_guild: boolean;
  write_guild: boolean;
  read_org: boolean;
  write_org: boolean;
};

/** One agent of the recipe, keyed by its `role` handle (recipes/schema.ts). */
export type RecipeRole = {
  role: string;
  name_suggestion: string;
  focus: string;
  avatar_shape: string;
  avatar_color: string;
  config: Record<string, unknown>;
  task: { body: string; embeds: string[]; author: FieldAuthor };
  scripts: RecipeScript[];
  schedules: RecipeSchedule[];
  grants: RecipeGrants;
  native_tools: Record<string, boolean>;
  browser: { required: boolean; instructions: string; author: FieldAuthor };
};

/** A git repository a recipe needs, by name and purpose; apply asks the operator to add it (recipes/schema.ts). */
export type RecipeRepository = { name: string; purpose: string };

/**
 * A typed table: owned by the applied guild (`scope: "guild"`) or held by the organisation, where
 * `guild` is the guild's grant and `writers` lists the roles granted write (recipes/schema.ts).
 */
export type RecipeCollection = {
  name: string;
  purpose: string;
  columns: Column[];
  scope: "guild" | "org";
  guild: AccessMode;
  writers: string[];
};

/** A seed note apply writes at the organisation, guild, or one role's agent (recipes/schema.ts). */
export type RecipeNote = {
  id: string;
  level: "org" | "guild" | "agent";
  role?: string;
  /** A `.md` file name with no `/`: notes are flat at their level. */
  key: string;
  body: string;
  kind: "seed";
  author: FieldAuthor;
};

/** A resource inside a connector that the recipe's agents use (recipes/schema.ts). */
export type RecipeConnectionResource = {
  kind: "database" | "page" | "other";
  id: string;
  title: string;
  url?: string;
  use?: string;
};

/** A per-role overlay on a connector: whether the role uses it and which tools are on or off (recipes/schema.ts). */
export type RecipeConnectionRole = { enabled: boolean; tools: Record<string, boolean> };

/** A connector the guild needs; an empty `roles` map means every role uses it (recipes/schema.ts). */
export type RecipeConnection = {
  server: string;
  auth: "oauth" | "token" | "none";
  recommended_scope: "org" | "guild" | "agent";
  recommended_role?: string;
  hint: string;
  setup: string;
  resources?: RecipeConnectionResource[];
  author: FieldAuthor;
  roles: Record<string, RecipeConnectionRole>;
};

/** A secret the guild needs (recipes/schema.ts). */
export type RecipeSecret = {
  name: string;
  description: string;
  recommended_scope: "org" | "guild" | "agent";
  recommended_role?: string;
  roles: string[];
};

/** A setup step outside the platform the operator performs (recipes/schema.ts). */
export type RecipeExternal = {
  kind: string;
  title: string;
  setup: string;
  author: FieldAuthor;
};

/** Who proposed a design entry and whether it is accepted (recipes/schema.ts). */
export type DesignDecision = { proposed_by: "operator" | "builder"; accepted: boolean };

/** How the design reaches an outside system (recipes/schema.ts). */
export type DesignSystem = DesignDecision & {
  name: string;
  resolution: "catalog" | "native" | "browser" | "script" | "composition" | "decision" | "refused";
  server?: string;
  reason: string;
};

/** Why a role is split out from the others (recipes/schema.ts). */
export type DesignSpecialization = DesignDecision & {
  role: string;
  reason: "narrower_tools" | "narrower_access" | "narrower_context" | "volume" | "other";
  detail: string;
};

/** A routine the design calls for, with its cadence as written (recipes/schema.ts). */
export type DesignRoutine = DesignDecision & {
  key: string;
  role: string;
  cadence: string;
  dedupe_collection?: string;
  dedupe_key?: string;
};

/** Work passing from one role to another, through a collection queue or a tagged message (recipes/schema.ts). */
export type DesignHandoff = DesignDecision & {
  from: string;
  to: string;
  kind: "collection" | "tagged";
  collection?: string;
  budget?: number;
};

/** A role that works a site through its browser (recipes/schema.ts). */
export type DesignBrowser = DesignDecision & {
  role: string;
  site: string;
  viable: boolean;
  login_failure_policy: string;
};

/** The builder's design notes behind the recipe (recipes/schema.ts). */
export type RecipeDesign = {
  systems: DesignSystem[];
  specialization: DesignSpecialization[];
  routines: DesignRoutine[];
  handoffs: DesignHandoff[];
  browser: DesignBrowser[];
};

/** A parsed recipe document, every list present (recipes/schema.ts, filled by parseRecipe). */
export type RecipeDocument = {
  format: "guilds.recipe";
  version: number;
  meta: RecipeMeta;
  guild: RecipeGuild;
  roles: RecipeRole[];
  collections: RecipeCollection[];
  notes: RecipeNote[];
  connections: RecipeConnection[];
  secrets: RecipeSecret[];
  external: RecipeExternal[];
  repositories: RecipeRepository[];
  design: RecipeDesign;
};

/** `ready` once the recipe is approved; any body write returns it to `draft` (recipes/store.ts, http/recipe-routes.ts). */
export type RecipeStatus = "draft" | "ready";

/** A stored recipe as `GET /api/recipes/:id` returns it (recipes/store.ts). */
export type RecipeRow = {
  id: string;
  org_id: string;
  created_by_user_id: string | null;
  name: string;
  description: string;
  visibility: string;
  status: RecipeStatus;
  body: RecipeDocument;
  body_version: number;
  source_kind: "guild" | "builder" | "file";
  source_guild_id: string | null;
  source_builder_session_id: string | null;
  created_at: string;
  updated_at: string;
};

/** How serious a validation finding is (recipes/validate.ts). */
export type FindingSeverity = "error" | "warning" | "info";

/** One validation finding, anchored to a dotted recipe path such as `roles.writer.task` (recipes/validate.ts). */
export type RecipeFinding = {
  code: string;
  severity: FindingSeverity;
  path: string;
  message: string;
};

/** A tool or connector the operator removed from the recipe (recipes/schema.ts). */
export type AccessCut = {
  kind: "tool" | "connector";
  server: string;
  role?: string;
  tool?: string;
};

/** One access change the operator sends: a tool switched for a role, or a connector removed (recipes/schema.ts). */
export type AccessEdit =
  | { action: "set_tool"; server: string; role: string; tool: string; enabled: boolean }
  | { action: "remove_connection"; server: string };

/** `POST /api/recipes/:id/access`: the rewritten recipe with every operator cut (http/recipe-routes.ts). */
export type AccessEditResult = RecipeRow & { access_cuts: AccessCut[] };

/** `POST /api/recipes/:id/validate`: all findings, the blocking ones, unconfirmed field paths, and operator cuts (http/recipe-routes.ts). */
export type RecipeValidation = {
  findings: RecipeFinding[];
  errors: RecipeFinding[];
  unreviewed: string[];
  access_cuts: AccessCut[];
  body_version: number;
  status: RecipeStatus;
};

/** What apply does with one recipe collection: create it, reuse the live table, or stop on a conflict (recipes/apply.ts). */
export type CollectionPlan = RecipeCollection & {
  action: "create" | "reuse" | "conflict";
  collection_id: string | null;
  differences: string[];
};

/** A live organisation connection apply can reuse for a connector (recipes/apply.ts). */
export type ReusableConnection = { id: string; owner_scope: string; status: string };

/** What apply does with one connector: reuse a live login or create one (recipes/apply.ts). */
export type PlannedConnection = {
  server: string;
  auth: RecipeConnection["auth"];
  recommended_scope: "guild" | "agent";
  reusable: ReusableConnection[];
  action: "reuse" | "create";
  connection_id: string | null;
  setup: string;
  resources: RecipeConnectionResource[];
};

/** What apply does with one secret: create it, reuse a same-named one, rename it, or skip it (recipes/apply.ts). */
export type PlannedSecret = {
  name: string;
  description: string;
  collision: boolean;
  action: "create" | "reuse" | "rename" | "skip";
  dest_name: string;
  recommended_scope: "guild" | "agent";
};

/** One agent apply creates (recipes/apply.ts). */
export type CreatedAgent = {
  role: string;
  name: string;
  focus: string;
  model: string;
  browser: boolean;
  coding: boolean;
  task: string;
  native_tools: string[];
};

/** One routine apply creates; exactly one of `cron` or `window` is set (recipes/apply.ts). */
export type CreatedRoutine = {
  role: string;
  key: string;
  cron: string | null;
  window: WakeWindow | null;
  description: string;
  instruction: string;
};

/** Everything apply creates, as the preview lists it (recipes/apply.ts). */
export type ApplyCreates = {
  guild: { name: string; about: string; objective: string };
  agents: CreatedAgent[];
  collections: CollectionPlan[];
  notes: Array<{ key: string; level: RecipeNote["level"]; role: string | null }>;
  scripts: Array<{ role: string; name: string; description: string }>;
  routines: CreatedRoutine[];
  connections: PlannedConnection[];
  secrets: PlannedSecret[];
  repositories: RecipeRepository[];
};

/**
 * A connector to install before apply: one the registry offers, or the recipe's own remote server
 * that the organisation adds as its server.
 */
export type ApplyInstall =
  | { server: string; from: "registry"; version: string; verified: boolean }
  | {
      server: string;
      from: "recipe";
      display_name: string;
      description: string;
      url: string;
      auth: "none" | "token" | "oauth";
    };

/**
 * A connector the recipe needs that the box has but no platform admin has set up; `integration`
 * is the platform key that sets it up, null when none on this box does.
 */
export type ApplySetup = { server: string; integration: string | null; label: string };

/** A machine the apply preview offers: its size, the memory its agents plan to use, and how many it holds. */
export type ApplyMachine = MachineRef & { memory_mib: number; planned_mib: number; agents: number };

/** `POST /api/recipes/:id/preview`: the apply plan, its findings, and what it creates (recipes/apply.ts). */
export type ApplyPreview = {
  recipe_id: string;
  recipe_name: string;
  guild_name: string;
  guild_id: string | null;
  names: Array<{ role: string; name: string }>;
  /** Each role's recommended model, and the one apply creates it with unless the operator picks another. */
  models: RoleModel[];
  /** The organisation's machines the roles may go on. */
  machines: ApplyMachine[];
  /** The machine the roles go on: the one chosen, or the only one; null while several wait for a choice. */
  machine_id: string | null;
  /** The memory the recipe's roles plan to use on it. */
  adds_mib: number;
  collisions: string[];
  connections: PlannedConnection[];
  /** Connectors the recipe names that the box lacks; each blocks apply until it is installed. */
  installs: ApplyInstall[];
  /** Connectors the box has that no platform admin has set up; the guild cannot connect them until one does. */
  setups: ApplySetup[];
  secrets: PlannedSecret[];
  collections: CollectionPlan[];
  findings: RecipeFinding[];
  errors: RecipeFinding[];
  unreviewed: string[];
  /** How many more agents the organisation may hold, by kind; null where nothing caps it. */
  remaining: { agents: number | null; browser_agents: number | null; coding_agents: number | null };
  creates: ApplyCreates;
};

/** A published connector's tool (capabilities/index.ts). */
export type CapabilityTool = { namespaced_name: string; default_enabled: boolean };

/** A published connector in `GET /api/builder/capabilities` `catalog` (capabilities/index.ts). */
export type CapabilityServer = Partial<ConnectorFacts> & {
  slug: string;
  display_name: string;
  auth: "none" | "token" | "oauth";
  oauth_strategy: "none" | "dynamic" | "configured";
  oauth_setup_state: "not_applicable" | "dynamic" | "configured" | "unsupported";
  description: string;
  limitations: string | null;
  setup_hint: string | null;
  enabled: boolean;
  tool_prefix: string;
  transport: "stdio" | "http";
  connection_state: "connected" | "registered_not_connected";
  reusable_scopes: string[];
  tools: CapabilityTool[];
  searchable: boolean;
  search_via: string | null;
};

/** What the Builder and the recipe pages can use: the connector catalog, models and plan room. */
export type BuilderCapabilities = {
  catalog: CapabilityServer[];
  models: OrgModels;
  /** How many more agents the organisation may hold, by kind; null where nothing caps it. */
  remaining: { agents: number | null; browser_agents: number | null; coding_agents: number | null };
};

/** One step of an apply's checklist: a login, a secret, a browser login, an outside setup, or activation. */
export type ApplyStep = {
  id: string;
  kind: "connection" | "overlays" | "secret" | "repository" | "browser" | "external" | "activate";
  title: string;
  setup?: string;
  site?: string;
  role?: string;
  deferrable?: boolean;
  phase?: string;
  /** Checked by the server, or confirmed by the operator. */
  closure: "verified" | "confirmed";
  status: "open" | "verified" | "confirmed" | "skipped";
  resolution?: "later" | "done" | "skipped" | "activated";
  closed_at?: string;
};

/** Which login apply gives a connector: a live one to reuse, or one to connect afterwards. */
export type ApplyConnectionChoice = {
  server: string;
  action: "reuse" | "create";
  scope: "guild" | "agent";
  connection_id?: string;
};

/** A role's model on the apply preview: what the recipe recommends, and what apply will create it with. */
export type RoleModel = { role: string; recommended: string | null; model: string | null };

/** What the operator decides before apply: the guild's name, each agent's name and model, and each login. */
export type ApplyChoices = {
  guild_name: string;
  names: Array<{ role: string; name: string }>;
  models: Array<{ role: string; model: string }>;
  connections: ApplyConnectionChoice[];
  /** The machine every role goes on; the organisation's only one when absent. */
  machine_id?: string;
};

/** `GET /api/guilds/:id/apply`: the open checklist, and agents that still need a post-apply browser login. */
export type GuildApplyState = {
  apply: ApplyRow | null;
  browser_logins: string[];
};

/** A recipe applied to a new guild: what it created, and the checklist left before its routines start. */
export type ApplyRow = {
  id: string;
  org_id: string;
  recipe_id: string;
  guild_id: string;
  created_guild: boolean;
  status: "skeleton" | "checklist" | "ready" | "aborted";
  recipe_body_version: number;
  preview: ApplyPreview;
  checklist: ApplyStep[];
  warnings: Array<{ code: string; path: string; message: string }>;
  created_at: string;
  updated_at: string;
};

/** A Builder session: the coach conversation that writes one draft recipe. */
export type BuilderSession = {
  id: string;
  org_id: string;
  recipe_id: string | null;
  status: "active" | "blocked" | "archived";
  blocked_reason: "input_token_limit" | null;
  generation_state: "idle" | "generating" | "cancelling";
  generation_number: number;
  created_at: string;
  updated_at: string;
  /** The recipe being written; sessions listed together carry only its name, status and version. */
  recipe: RecipeRow;
};

/** A Builder session as its list shows it. */
export type BuilderSessionSummary = Omit<BuilderSession, "recipe"> & {
  recipe: Pick<RecipeRow, "name" | "status" | "body_version"> | null;
};
