/**
 * Shapes of the orchestrator's JSON API for secrets, as the app reads them. Timestamps are ISO-8601
 * in UTC.
 */

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

/** An edit to one secret. */
export type SecretUpdate = { secretId: string; changes: SecretChanges };

/** Who gets one secret, replacing who got it. */
export type SecretAccessUpdate = { secretId: string; access: SecretAccessChoice };
