import type { AuthMode } from "./types";

/**
 * Who the app acts as: the stored user and organisation, in localStorage for the page and in
 * cookies for EventSource streams, which cannot send headers.
 */
const userKey = "guilds-user-id";
const orgKey = "guilds-org-id";
const userCookie = "guilds_user";
const orgCookie = "guilds_org";

const current: { mode: AuthMode | null; userId: string | null; orgId: string | null } = {
  mode: null,
  userId: null,
  orgId: null,
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, cookie: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable; the cookie still carries the choice.
  }
  document.cookie = value
    ? `${cookie}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`
    : `${cookie}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function storedUserId(): string | null {
  return read(userKey);
}

export function storedOrgId(): string | null {
  return read(orgKey);
}

export function setAuthMode(mode: AuthMode): void {
  current.mode = mode;
}

export function authMode(): AuthMode | null {
  return current.mode;
}

export function rememberUser(id: string): void {
  current.userId = id;
  write(userKey, userCookie, id);
}

export function rememberOrg(id: string | null): void {
  current.orgId = id;
  write(orgKey, orgCookie, id);
}

/** Identity headers for API requests: the user only in compat-cookie mode, the org always. */
export function identityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (current.mode === "compat-cookie" && current.userId) headers["X-Guilds-User"] = current.userId;
  if (current.orgId) headers["X-Guilds-Org"] = current.orgId;
  return headers;
}

let signInPath: string | null = null;

/** Names the edition's sign-in page, as a path under the app's root; null when it has none. */
export function setSignInPath(path: string | null): void {
  signInPath = path;
}

/** The sign-in page, returning to where the operator was; null when the edition has none. */
export function signInUrl(): string | null {
  if (signInPath === null) return null;
  return `${import.meta.env.BASE_URL}${signInPath}?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}
