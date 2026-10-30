import { api } from "./client";
import { rememberOrg, rememberUser, setAuthMode, storedOrgId, storedUserId } from "./session";
import type { AuthConfig, AuthMode } from "./types/admin";
import type { Org, User } from "./types/org";

export type Identity = { mode: AuthMode; user: User; org: Org; orgs: Org[] };

/**
 * Resolves the operator and organisation the app acts as. Compat-cookie mode (local development)
 * picks the stored user, or the first; other modes ask the server who is signed in. The stored
 * organisation wins while the operator still belongs to it.
 */
export async function loadIdentity(): Promise<Identity> {
  const config = await api<AuthConfig>("/api/auth/config");
  setAuthMode(config.mode);

  if (config.mode === "compat-cookie") {
    const users = await api<User[]>("/api/users");
    const stored = storedUserId();
    const chosen = users.find((candidate) => candidate.id === stored) ?? users[0];
    if (!chosen) throw new Error("No users exist yet. Seed one with pnpm seed:operator.");
    rememberUser(chosen.id);
  }
  const user = await api<User>("/api/auth/me");

  const orgs = await api<Org[]>("/api/orgs");
  const stored = storedOrgId();
  const org = orgs.find((candidate) => candidate.id === stored) ?? orgs[0];
  if (!org) throw new Error("This account does not belong to an organisation yet.");
  rememberOrg(org.id);
  return { mode: config.mode, user, org, orgs };
}

/** Works in another organisation from its home page: the current page belongs to this one. */
export function switchOrg(orgId: string): void {
  rememberOrg(orgId);
  window.location.assign(import.meta.env.BASE_URL);
}
