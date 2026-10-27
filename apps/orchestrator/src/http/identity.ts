import type { IncomingHttpHeaders } from "node:http";
import { ORG_COOKIE, ORG_HEADER, resolveOrg } from "../organisations/index.js";
import { USER_COOKIE, USER_HEADER, resolveUser } from "../users/index.js";
import type { AppDeps } from "./deps.js";
import { requestCookies } from "./cookies.js";
import { HttpError } from "./errors.js";
import { getUserByEmail, listUsers } from "../db/users.js";
import { listOrgsForUser } from "../db/orgs.js";
import { bindQuery, type Queryable } from "../db/pg.js";

export type IdentityRequest = {
  headers: IncomingHttpHeaders;
};

export type IdentityReply = {
  header: (name: string, value: string) => unknown;
};

/** How an extension identifies a request's user, in place of core's modes. */
export type IdentityProvider = {
  /** The request's user, or a 401. */
  currentUser(request: IdentityRequest): Promise<Record<string, unknown>>;
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

/** The db/ functions core's sign-in modes resolve a request's user and organisation through, on `db`. */
export function identityDatabase(db: Queryable) {
  return {
    listUsers: bindQuery(db, listUsers),
    listOrgsForUser: bindQuery(db, listOrgsForUser),
    getUserByEmail: bindQuery(db, getUserByEmail),
  };
}

export type IdentityDatabase = ReturnType<typeof identityDatabase>;

export async function currentUser(
  db: IdentityDatabase,
  request: IdentityRequest,
  deps: Pick<AppDeps, "config" | "identity"> = {},
): Promise<Record<string, unknown>> {
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
  const users = await db.listUsers();
  try {
    return resolveUser(users as Array<{ id: string }>, token) as Record<string, unknown>;
  } catch (error) {
    throw identityHttp(error);
  }
}

export async function currentOrg(
  db: IdentityDatabase,
  request: IdentityRequest,
  user: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = headerOrCookie(request, ORG_HEADER, ORG_COOKIE);
  const memberships = await db.listOrgsForUser(String(user.id));
  try {
    return resolveOrg(memberships as Array<{ id: string }>, token) as Record<string, unknown>;
  } catch (error) {
    throw identityHttp(error);
  }
}

async function trustedHeaderUser(
  db: IdentityDatabase,
  request: IdentityRequest,
  deps: Pick<AppDeps, "config">,
): Promise<Record<string, unknown>> {
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
  const user = await db.getUserByEmail(email);
  if (!user) {
    throw new HttpError(401, "user not found");
  }
  return user;
}

function identityHttp(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error && typeof error === "object" && "status" in error) {
    const typed = error as { status: number; detail: string };
    return new HttpError(typed.status, typed.detail);
  }
  throw error;
}
