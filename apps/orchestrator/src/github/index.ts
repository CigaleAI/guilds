import { createSign } from "node:crypto";
import {
  GITHUB_APP,
  integrationValues,
  missingFields,
  type IntegrationSources,
} from "../instance/integrations.js";
import { proxyFetch, readJson, type FetchFn } from "../net/http.js";

/**
 * The deployment's GitHub App: the `github` connection installs it on an account and the
 * orchestrator mints installation tokens from it. The private key never leaves this process.
 */
export const GITHUB_SLUG = "github";
export const GITHUB_SERVER_ID = "mcp_github";
export const GITHUB_API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const API_VERSION = "2022-11-28";
/** An App token lives at most 10 minutes; this leaves room for clock skew. */
const APP_TOKEN_SECONDS = 9 * 60;

export type GithubAppConfig = {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
};

export class GithubError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

/** GitHub refused the installation: it was removed or suspended. */
export class GithubInstallationGoneError extends GithubError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "GithubInstallationGoneError";
  }
}

/** The App from the instance keys, or null while any of its five fields is missing. */
export function githubAppConfig(sources?: IntegrationSources): GithubAppConfig | null {
  const values = integrationValues(GITHUB_APP, sources);
  if (values === null) {
    return null;
  }
  return {
    appId: values.app_id,
    slug: values.slug,
    // A key pasted from a one-line form often carries literal \n sequences.
    privateKey: values.private_key.replace(/\\n/g, "\n"),
    clientId: values.client_id,
    clientSecret: values.client_secret,
  };
}

export function requireGithubApp(sources?: IntegrationSources): GithubAppConfig {
  const config = githubAppConfig(sources);
  if (config === null) {
    const missing = missingFields(GITHUB_APP, sources).map((field) => field.label);
    throw new GithubError(
      `the GitHub App is not configured: ${missing.join(", ")} missing; a platform admin sets it under Admin, Platform keys`,
    );
  }
  return config;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** An RS256 JSON Web Token that authenticates as the App itself. */
export function appJwt(config: GithubAppConfig, now = new Date()): string {
  const issued = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issued, exp: issued + APP_TOKEN_SECONDS, iss: config.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(config.privateKey).toString("base64url")}`;
}

/** The App's install page, for a user who reaches no installation yet; it returns `state` to the callback. */
export function installUrl(config: GithubAppConfig, state: string): string {
  return `${GITHUB_WEB}/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * User authorization, where Connect sends the operator, and again after a setup redirect that has
 * an installation but no `code`. GitHub's "OAuth during installation" hop does not take
 * `redirect_uri` or `state`; this one does.
 */
export function userAuthorizationUrl(config: GithubAppConfig, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${GITHUB_WEB}/login/oauth/authorize?${params.toString()}`;
}

export const GITHUB_OAUTH_STATE_COOKIE = "guilds_github_oauth";

/** Short-lived cookie so the callback still finds the pending login when GitHub drops `state`. */
export function githubOauthStateCookie(state: string, secure: boolean): string {
  const parts = [
    `${GITHUB_OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`,
    "Path=/api/mcp/oauth/callback",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${20 * 60}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearGithubOauthStateCookie(secure: boolean): string {
  const parts = [
    `${GITHUB_OAUTH_STATE_COOKIE}=`,
    "Path=/api/mcp/oauth/callback",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

type Options = { fetch?: FetchFn | undefined; proxyUrl?: string | undefined };

function fetcher(options: Options): FetchFn {
  return options.fetch ?? proxyFetch(options.proxyUrl ?? "");
}

function apiHeaders(authorization: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: authorization,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "guilds.run",
  };
}

async function apiError(response: Response, what: string): Promise<GithubError> {
  let message: string;
  try {
    const body = (await readJson(response)) as { message?: unknown };
    message = typeof body.message === "string" ? body.message : "";
  } catch {
    message = "";
  }
  return new GithubError(`${what}: ${response.status}${message ? ` ${message}` : ""}`, response.status);
}

/** Exchanges the callback's `code` for the authorizing user's token. */
export async function exchangeUserCode(
  config: GithubAppConfig,
  code: string,
  options: Options & { redirectUri?: string } = {},
): Promise<string> {
  const payload: Record<string, string> = { client_id: config.clientId, client_secret: config.clientSecret, code };
  if (options.redirectUri) {
    payload.redirect_uri = options.redirectUri;
  }
  const response = await fetcher(options)(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "guilds.run" },
    body: JSON.stringify(payload),
  });
  if (response.status >= 400) {
    throw await apiError(response, "GitHub code exchange failed");
  }
  const body = (await readJson(response)) as { access_token?: unknown; error?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new GithubError(`GitHub code exchange failed: ${typeof body.error === "string" ? body.error : "no token"}`);
  }
  return body.access_token;
}

export type GithubInstallation = { id: number; account: string; appId: number | null; updatedAt: string };

function installationFrom(row: Record<string, unknown>): GithubInstallation {
  const account = row.account && typeof row.account === "object" ? (row.account as Record<string, unknown>) : {};
  return {
    id: Number(row.id),
    account: String(account.login ?? ""),
    appId: typeof row.app_id === "number" ? row.app_id : typeof row.app_id === "string" ? Number(row.app_id) : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

function ofThisApp(item: GithubInstallation, appId: string): boolean {
  return item.appId === null || Number.isNaN(item.appId) || String(item.appId) === String(appId);
}

function parseInstallationId(raw: string | number | undefined): number | null {
  const id = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** This App's installations on `userToken`, newest first when they have several. */
export async function appInstallationsForUser(
  config: GithubAppConfig,
  userToken: string,
  options: Options = {},
): Promise<GithubInstallation[]> {
  return (await userInstallations(userToken, options)).filter((item) => ofThisApp(item, config.appId));
}

export type GithubInstallationChoice =
  | { action: "use"; installation: GithubInstallation }
  | { action: "install" }
  | { action: "pick"; installations: GithubInstallation[] };

/**
 * Which installation the callback should keep. A query id still has to be one the user can
 * reach. With no id: this App's only installation, a picker when they have several, or install
 * when they have none.
 */
export async function resolveGithubInstallation(
  config: GithubAppConfig,
  userToken: string,
  rawInstallationId?: string | number,
  options: Options & { retryDelayMs?: number } = {},
): Promise<GithubInstallationChoice> {
  const wanted = parseInstallationId(rawInstallationId);
  if (wanted !== null) {
    return { action: "use", installation: await installationForUser(config, userToken, wanted, options) };
  }
  const pick = async (rows: GithubInstallation[]): Promise<GithubInstallationChoice | null> => {
    if (rows.length === 1) {
      return { action: "use", installation: rows[0]! };
    }
    if (rows.length > 1) {
      return { action: "pick", installations: rows };
    }
    return null;
  };
  const first = await pick(await appInstallationsForUser(config, userToken, options));
  if (first) {
    return first;
  }
  const delay = options.retryDelayMs ?? 400;
  if (delay > 0) {
    await wait(delay);
  }
  return (await pick(await appInstallationsForUser(config, userToken, options))) ?? { action: "install" };
}

/** The installations of this App that the user behind `userToken` can reach. */
export async function userInstallations(userToken: string, options: Options = {}): Promise<GithubInstallation[]> {
  const fetchFn = fetcher(options);
  const installations: GithubInstallation[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchFn(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
      headers: apiHeaders(`Bearer ${userToken}`),
    });
    if (response.status >= 400) {
      throw await apiError(response, "listing GitHub installations failed");
    }
    const body = (await readJson(response)) as { installations?: unknown };
    const rows = Array.isArray(body.installations) ? body.installations : [];
    for (const row of rows as Array<Record<string, unknown>>) {
      installations.push(installationFrom(row));
    }
    if (rows.length < 100) {
      break;
    }
  }
  return installations;
}

/** The installation as the App sees it, or null when it is not this App's. */
export async function appInstallation(
  config: GithubAppConfig,
  installationId: number,
  options: Options & { now?: Date } = {},
): Promise<GithubInstallation | null> {
  const response = await fetcher(options)(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: apiHeaders(`Bearer ${appJwt(config, options.now)}`),
  });
  if (response.status === 404) {
    return null;
  }
  if (response.status >= 400) {
    throw await apiError(response, "reading the GitHub installation failed");
  }
  return installationFrom((await readJson(response)) as Record<string, unknown>);
}

/** Whether the user token can see this installation (SEC-11). */
export async function userReachesInstallation(
  userToken: string,
  installationId: number,
  options: Options = {},
): Promise<boolean> {
  const response = await fetcher(options)(
    `${GITHUB_API}/user/installations/${installationId}/repositories?per_page=1`,
    { headers: apiHeaders(`Bearer ${userToken}`) },
  );
  if (response.status === 404 || response.status === 403) {
    return false;
  }
  if (response.status >= 400) {
    throw await apiError(response, "checking the GitHub installation failed");
  }
  return true;
}

/**
 * The installation the callback may keep: the query id when the user can reach it, otherwise
 * this App's installation on the user token (newest when they have several). An id in the URL
 * alone proves nothing.
 */
export async function installationForUser(
  config: GithubAppConfig,
  userToken: string,
  rawInstallationId?: string | number,
  options: Options & { retryDelayMs?: number } = {},
): Promise<GithubInstallation> {
  const wanted = parseInstallationId(rawInstallationId);
  const listed = await userInstallations(userToken, options);
  const ours = listed.filter((item) => ofThisApp(item, config.appId));
  if (wanted !== null) {
    const found = ours.find((item) => item.id === wanted);
    if (found) {
      return found;
    }
    if (await userReachesInstallation(userToken, wanted, options)) {
      const fromApp = await appInstallation(config, wanted, options);
      if (fromApp && ofThisApp(fromApp, config.appId)) {
        return fromApp;
      }
    }
    throw new GithubError("that installation is not one the authorizing user can reach");
  }
  const pick = (rows: GithubInstallation[]): GithubInstallation | undefined =>
    [...rows].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
  const first = pick(ours);
  if (first) {
    return first;
  }
  const delay = options.retryDelayMs ?? 400;
  if (delay > 0) {
    await wait(delay);
  }
  const again = (await userInstallations(userToken, options)).filter((item) => ofThisApp(item, config.appId));
  const retry = pick(again);
  if (retry) {
    return retry;
  }
  throw new GithubError("the authorizing user has no installation of this App");
}

/** A repository a scoped installation token reaches, as GitHub names it now. */
export type TokenRepository = { id: number; full_name: string };

export type InstallationToken = { token: string; expiresAt: string; repositories: TokenRepository[] };

/**
 * An installation access token, valid one hour. With `repositoryIds` it reaches only those
 * repositories, with contents and pull requests write, and lists them under their current
 * names: an id survives a rename of the repository or its owner, a name does not.
 */
export async function installationToken(
  config: GithubAppConfig,
  installationId: number,
  options: Options & { repositoryIds?: number[]; now?: Date } = {},
): Promise<InstallationToken> {
  const body: Record<string, unknown> = {};
  if (options.repositoryIds) {
    body.repository_ids = options.repositoryIds;
    body.permissions = { contents: "write", pull_requests: "write" };
  }
  const response = await fetcher(options)(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...apiHeaders(`Bearer ${appJwt(config, options.now)}`), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 404 || response.status === 403) {
    const error = await apiError(response, "GitHub refused the installation");
    throw new GithubInstallationGoneError(error.message, response.status);
  }
  if (response.status >= 400) {
    throw await apiError(response, "minting a GitHub token failed");
  }
  const parsed = (await readJson(response)) as { token?: unknown; expires_at?: unknown; repositories?: unknown };
  if (typeof parsed.token !== "string" || typeof parsed.expires_at !== "string") {
    throw new GithubError("GitHub returned no installation token");
  }
  const listed = Array.isArray(parsed.repositories) ? (parsed.repositories as Array<Record<string, unknown>>) : [];
  return {
    token: parsed.token,
    expiresAt: parsed.expires_at,
    repositories: listed
      .filter((row) => Number.isInteger(row.id) && typeof row.full_name === "string")
      .map((row) => ({ id: Number(row.id), full_name: String(row.full_name) })),
  };
}

export type GithubRepository = {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  url: string;
};

/** Every repository the installation reaches. */
export async function installationRepositories(
  config: GithubAppConfig,
  installationId: number,
  options: Options = {},
): Promise<GithubRepository[]> {
  const { token } = await installationToken(config, installationId, options);
  const fetchFn = fetcher(options);
  const repositories: GithubRepository[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetchFn(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, {
      headers: apiHeaders(`Bearer ${token}`),
    });
    if (response.status >= 400) {
      throw await apiError(response, "listing GitHub repositories failed");
    }
    const body = (await readJson(response)) as { repositories?: unknown };
    const rows = Array.isArray(body.repositories) ? body.repositories : [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const owner = row.owner && typeof row.owner === "object" ? (row.owner as Record<string, unknown>) : {};
      repositories.push({
        id: Number(row.id),
        name: String(row.name ?? ""),
        full_name: String(row.full_name ?? ""),
        owner: String(owner.login ?? ""),
        private: row.private === true,
        default_branch: String(row.default_branch ?? "main"),
        url: `${GITHUB_WEB}/${String(row.full_name ?? "")}`,
      });
    }
    if (rows.length < 100) {
      break;
    }
  }
  return repositories;
}

/**
 * The repository at `path` (`owner/name`) as an installation token sees it, or null when the
 * installation does not reach it. GitHub redirects a renamed repository, or one whose owner was
 * renamed, so an old path finds it under its current name.
 */
export async function installationRepository(
  token: string,
  path: string,
  options: Options = {},
): Promise<TokenRepository | null> {
  const response = await fetcher(options)(`${GITHUB_API}/repos/${path}`, { headers: apiHeaders(`Bearer ${token}`) });
  if (response.status === 404 || response.status === 403) {
    return null;
  }
  if (response.status >= 400) {
    throw await apiError(response, "reading a GitHub repository failed");
  }
  const body = (await readJson(response)) as { id?: unknown; full_name?: unknown };
  return Number.isInteger(body.id) && typeof body.full_name === "string"
    ? { id: Number(body.id), full_name: body.full_name }
    : null;
}

/** `owner` and `repository` of an `https://github.com/<owner>/<repository>` URL, or null. */
export function parseGithubUrl(url: string): { owner: string; repository: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) {
    return null;
  }
  return { owner: match[1]!, repository: match[2]! };
}
