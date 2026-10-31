import type { AgentBrief } from "./agents";

/**
 * Shapes of the orchestrator's JSON API for the operator, the organisation and its members, as the
 * app reads them. Timestamps are ISO-8601 in UTC.
 */

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

/** The signed-in operator's own settings to change; a field left out keeps its value. */
export type ProfileChanges = { name?: string; timezone?: string | null; color?: string | null };

export type OrgRole = "owner" | "admin" | "member";

export type Org = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  role: OrgRole;
};

/** An organisation's new name and slug. */
export type OrgInput = Pick<Org, "name" | "slug">;

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  calls: number;
  /** Tokens `browse` calls spent: the browsing service's and the model it drove the page with. */
  browser_input_tokens: number;
  browser_output_tokens: number;
  /** What `browse` calls cost; also counted in `cost_usd`. */
  browser_cost_usd: number;
  /** `browse` calls, counted apart from model calls. */
  browser_calls: number;
  updated_at: string | null;
};

export type OrgMember = {
  user_id: string;
  name: string;
  image: string | null;
  /** Identity colour, a 6-digit hex; null until they choose one. */
  color: string | null;
  role: OrgRole;
  created_at: string;
};

/** A user added to the organisation by their @name, with the role they get. */
export type NewMember = { name: string; role: OrgRole };

/** A member's new role. */
export type MemberRoleChange = { userId: string; role: OrgRole };

/** One organisation's usage by guild and agent, with the coach and deleted guilds as rows of their own. */
export type OrgUsage = UsageTotals & {
  id: string;
  name: string;
  slug: string;
  studio: UsageTotals | null;
  builder: UsageTotals | null;
  archived: UsageTotals | null;
  guilds: (UsageTotals & { id: string; name: string; agents: (UsageTotals & AgentBrief)[] })[];
};
