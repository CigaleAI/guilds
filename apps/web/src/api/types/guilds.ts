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

export type RepositoryInput = {
  name: string;
  url: string;
  default_branch?: string;
  connection_id?: string;
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
  >
>;

/** A new guild; its creator becomes its admin, and a private one shows only to its operators. */
export type NewGuild = Pick<Guild, "name" | "about" | "description" | "visibility">;
