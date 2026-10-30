import { ORG_COOKIE, ORG_HEADER, OrgIdentityError } from "../organisations/index.js";
import { USER_COOKIE, USER_HEADER, UserIdentityError } from "../users/index.js";
import type { AppDeps } from "./deps.js";
import { requestCookies, type RequestWithHeaders } from "./cookies.js";
import { HttpError } from "./errors.js";
import type { OrgMembershipRow } from "../db/orgs.js";
import type { Queryable } from "../db/pg.js";
import type { UserRow } from "../db/users.js";
import { resolveEmailUser, resolveTokenOrg, resolveTokenUser } from "../users/identity.js";

/** The request an identity provider reads: its headers. */
export type IdentityRequest = RequestWithHeaders;

export type IdentityReply = {
  header: (name: string, value: string) => unknown;
};

/** How an extension identifies a request's user, in place of core's modes. */
export type IdentityProvider = {
  /** The request's user, or a 401. */
  currentUser(request: IdentityRequest): Promise<UserRow>;
  /** Runs as each response is sent, for a provider that renews a credential. */
  onSend?(request: IdentityRequest, reply: IdentityReply): void;
  /** What its sign-in page needs to know, answered with the mode at `GET /api/auth/config`. */
  describe?(): Record<string, unknown>;
};

function headerOrCookie(request: IdentityRequest, headerName: string, cookieName: string): string | null {
  const header = request.headers[headerName.toLowerCase()];
  if (typeof header === "string" && header) {
    return header;
  }
  return requestCookies(request)[cookieName] ?? null;
}

export async function currentUser(
  db: Queryable,
  request: IdentityRequest,
  deps: Pick<AppDeps, "config" | "identity"> = {},
): Promise<UserRow> {
  if (deps.identity) {
    return deps.identity.currentUser(request);
  }
  const mode = deps.config?.authMode ?? "compat-cookie";
  if (mode === "trusted-header") {
    return trustedHeaderUser(db, request, deps);
  }
  if (mode !== "compat-cookie") {
    // A mode core does not implement, with no provider for it: nobody is signed in.
    throw new HttpError(401, "not signed in");
  }
  const token = headerOrCookie(request, USER_HEADER, USER_COOKIE);
  try {
    return await resolveTokenUser(db, token);
  } catch (error) {
    throw identityHttp(error);
  }
}

export async function currentOrg(
  db: Queryable,
  request: IdentityRequest,
  user: UserRow,
): Promise<OrgMembershipRow> {
  const token = headerOrCookie(request, ORG_HEADER, ORG_COOKIE);
  try {
    return await resolveTokenOrg(db, user.id, token);
  } catch (error) {
    throw identityHttp(error);
  }
}

async function trustedHeaderUser(
  db: Queryable,
  request: IdentityRequest,
  deps: Pick<AppDeps, "config">,
): Promise<UserRow> {
  const expected = deps.config?.trustedProxySecret ?? "";
  const provided = String(request.headers["x-guilds-proxy-secret"] ?? "");
  if (!expected || provided !== expected) {
    throw new HttpError(401, "untrusted proxy");
  }
  const headerName = (deps.config?.trustedHeaderName ?? "X-Forwarded-Email").toLowerCase();
  const email = String(request.headers[headerName] ?? "").trim().toLowerCase();
  if (!email) {
    throw new HttpError(401, "missing trusted email");
  }
  try {
    return await resolveEmailUser(db, email);
  } catch (error) {
    throw identityHttp(error);
  }
}

function identityHttp(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof UserIdentityError || error instanceof OrgIdentityError) {
    return new HttpError(error.status, error.detail);
  }
  throw error;
}
