import type { OrgRole, Secret, SecretAccessChoice } from "../../api/types";

/** The server's rules for a secret: an environment variable name and a description the agent reads. */
export const secretNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const secretDescriptionMax = 400;

/** Org owners and admins write every secret and are the only ones who change who gets one. */
export function managesSecrets(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/** One entry of a secret's Available to column. */
export type Reach =
  | { kind: "organisation" }
  | { kind: "unassigned" }
  | { kind: "guild" | "agent"; id: string; name: string }
  | { kind: "private" };

/** Who gets the secret, as the viewer may know it: grants in guilds they cannot see read Private guild. */
export function availableTo(secret: Pick<Secret, "org_wide" | "grants">): Reach[] {
  if (secret.org_wide) return [{ kind: "organisation" }];
  if (!secret.grants.length) return [{ kind: "unassigned" }];
  return secret.grants.map((grant) =>
    grant.id === null
      ? { kind: "private" }
      : { kind: grant.kind, id: grant.id, name: grant.name ?? "" },
  );
}

export function reachLabel(reach: Reach): string {
  switch (reach.kind) {
    case "organisation":
      return "Organisation";
    case "unassigned":
      return "Unassigned";
    case "private":
      return "Private guild";
    default:
      return reach.name;
  }
}

/** "Added by ada" for an operator, "Stored by scout" for an agent's secret_store. */
export function secretOrigin(secret: Pick<Secret, "created_by">): string | null {
  const by = secret.created_by;
  if (!by) return null;
  const name = by.name ?? "an agent in a private guild";
  return by.kind === "user" ? `Added by ${name}` : `Stored by ${name}`;
}

/** The grants the viewer can name, as the access dialog starts from them. */
export function visibleAccess(secret: Pick<Secret, "org_wide" | "grants">): SecretAccessChoice {
  const ids = (kind: "guild" | "agent") =>
    secret.grants.flatMap((grant) => (grant.kind === kind && grant.id ? [grant.id] : []));
  return { org_wide: secret.org_wide, guild_ids: ids("guild"), agent_ids: ids("agent") };
}

/** The secret's access with one more agent granted; grants the viewer cannot name stay on the server. */
export function withAgent(
  secret: Pick<Secret, "org_wide" | "grants">,
  agentId: string,
): SecretAccessChoice {
  const access = visibleAccess(secret);
  return {
    org_wide: false,
    guild_ids: access.guild_ids,
    agent_ids: access.agent_ids.includes(agentId)
      ? access.agent_ids
      : [...access.agent_ids, agentId],
  };
}

/** Where a requested name stands: not in the organisation, there but not for this agent, or set. */
export type RequestState =
  { kind: "missing" } | { kind: "elsewhere"; secret: Secret } | { kind: "set" };

export function requestState(
  name: string,
  orgSecrets: readonly Secret[],
  environment: readonly Secret[],
): RequestState {
  if (environment.some((secret) => secret.name === name)) return { kind: "set" };
  const secret = orgSecrets.find((item) => item.name === name);
  return secret ? { kind: "elsewhere", secret } : { kind: "missing" };
}

/** A secret_request call's arguments, as the agent wrote them. */
export type SecretRequest = { name: string; description: string; reason: string };

/**
 * The request a secret_request call carries, when its result asked the operator; null for a call
 * that failed, is still running, or found the name already set.
 */
export function askedRequest(argumentsText: unknown, resultText: unknown): SecretRequest | null {
  if (typeof resultText !== "string") return null;
  try {
    const result = JSON.parse(resultText.split("\n")[0] ?? "") as Record<string, unknown>;
    if (result.widget !== "secret_request" || result.status !== "asked") return null;
    const args = (
      typeof argumentsText === "string" ? JSON.parse(argumentsText) : argumentsText
    ) as Record<string, unknown> | null;
    return {
      name: String(result.name ?? args?.name ?? ""),
      description: typeof args?.description === "string" ? args.description : "",
      reason: typeof args?.reason === "string" ? args.reason : "",
    };
  } catch {
    return null;
  }
}
