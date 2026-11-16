import type { UsageTotals } from "./org";
import type { AgentBrief } from "./agents";
import type { BindingScope, McpConnectionStatus } from "./access";

/**
 * Shapes of the orchestrator's JSON API for guilds, as the app reads them. Timestamps are ISO-8601
 * in UTC.
 */

export type GuildOperator = {
  user_id: string;
  name: string;
  role: "admin" | "operator";
};

/** The role a user is to hold among a guild's operators. */
export type GuildOperatorRole = { userId: string; role: GuildOperator["role"] };

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
  visibility: "org" | "private";
  operators: GuildOperator[];
  routines_enabled: boolean;
  /** User turns, including the current one, whose tool results stay in the prompt of each agent that sets none. */
  keep_tool_result_generations: number;
};

/**
 * How a repository's token is minted: through its GitHub login, or from the secret that holds its
 * access token; null clones it without credentials.
 */
export type RepositoryProvider = "github" | "access_token" | null;

/** A git repository of a guild, cloned into the workspace of each coding agent that picks it. */
export type GuildRepository = {
  id: string;
  guild_id: string;
  name: string;
  url: string;
  default_branch: string;
  provider: RepositoryProvider;
  connection_id: string | null;
  connection: { id: string; status: McpConnectionStatus | null; account_hint: string } | null;
  /** The secret holding an access-token repository's token, and the username git sends with it. */
  secret_id: string | null;
  username: string | null;
  secret: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
};

/**
 * `GET /api/guilds/:id/repositories`: the guild's repositories, the GitHub logins they may be added
 * with, and the names of the repositories a new coding agent of the guild can use.
 */
export type GuildRepositoryView = {
  repositories: GuildRepository[];
  github_connections: GithubLogin[];
  usable: string[];
};

/** A repository to add: its URL and at most one credential, a GitHub login or an access token's secret and username. */
export type RepositoryInput = {
  name: string;
  url: string;
  default_branch?: string;
  connection_id?: string;
  secret_id?: string;
  username?: string;
};

/** A GitHub login a guild may use when adding repositories. */
export type GithubLogin = {
  id: string;
  owner_scope: BindingScope;
  owner_id: string | null;
  account_hint: string;
  status: McpConnectionStatus;
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
    | "keep_tool_result_generations"
  >
>;

/** A new guild; its creator becomes its admin, and a private one shows only to its operators. */
export type NewGuild = Pick<Guild, "name" | "about" | "description" | "visibility">;
