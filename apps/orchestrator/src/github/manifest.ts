import { proxyFetch, readJson, type FetchFn } from "../net/http.js";
import { GITHUB_API, GithubError } from "./index.js";

/**
 * Registering the box's GitHub App from a manifest: the operator app posts the manifest to GitHub,
 * the admin confirms there, GitHub sends a one-use code back to the box, and the box trades it
 * for the App's credentials. Nothing here holds a credential; the route stores what comes back.
 */
const GITHUB_WEB = "https://github.com";
const API_VERSION = "2022-11-28";
const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

export const MANIFEST_CALLBACK_PATH = "/api/admin/instance/keys/github-app/manifest/callback";
export const GITHUB_MANIFEST_STATE_COOKIE = "guilds_github_manifest";
/** GitHub caps an App name at 34 characters. */
export const APP_NAME_MAX = 34;

/**
 * The repository permissions the App asks for: what coding runs push and open pull requests with,
 * and what the connector's toolsets read and write.
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  actions: "read",
  checks: "read",
  statuses: "read",
  metadata: "read",
} as const;

export type GithubAppManifest = {
  name: string;
  url: string;
  hook_attributes?: { url: string; active: false };
  redirect_url: string;
  callback_urls: string[];
  description: string;
  public: false;
  default_permissions: typeof GITHUB_APP_PERMISSIONS;
  request_oauth_on_install: true;
  setup_on_update: true;
};

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The manifest for this box: the App installs with OAuth and redirects on update, asks for
 * `GITHUB_APP_PERMISSIONS`, and delivers no webhook. Its callbacks are the box's
 * public address and, when the admin reached the box another way, that address too. An inactive
 * webhook is named only when that address is on the public internet: GitHub refuses a hook URL
 * it cannot reach, such as localhost.
 */
export function githubAppManifest(options: { baseUrl: string; requestOrigin: string; name?: string }): GithubAppManifest {
  const base = trimBase(options.baseUrl);
  const origin = trimBase(options.requestOrigin);
  const callbacks = [`${base}${OAUTH_CALLBACK_PATH}`];
  if (origin && origin !== base) {
    callbacks.push(`${origin}${OAUTH_CALLBACK_PATH}`);
  }
  const name = (options.name ?? "").trim();
  const hook = publicHook(base);
  return {
    name: name || `Guilds (${hostOf(base)})`,
    url: base,
    ...(hook ? { hook_attributes: hook } : {}),
    redirect_url: `${base}${MANIFEST_CALLBACK_PATH}`,
    callback_urls: callbacks,
    description: "Lets this Guilds box's agents work with the issues, pull requests, and CI runs of the repositories each login picks, and its coding agents clone and push them.",
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    request_oauth_on_install: true,
    setup_on_update: true,
  };
}

/** An inactive hook GitHub will accept, or none when the host is loopback or on a private network. */
function publicHook(base: string): { url: string; active: false } | undefined {
  return reachableFromInternet(base) ? { url: `${base}/api/github/webhook`, active: false } : undefined;
}

function reachableFromInternet(base: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
  if (hostname.includes(":")) return publicIpv6(hostname);
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return true;
  const a = Number(octets[0]);
  const b = Number(octets[1]);
  const c = Number(octets[2]);
  const d = Number(octets[3]);
  if ([a, b, c, d].some((part) => part > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function publicIpv6(hostname: string): boolean {
  if (hostname === "::" || hostname === "::1") return false;
  const head = hostname.split(":").find((part) => part.length > 0) ?? "";
  if (/^fe[89ab]/.test(head) || /^f[cd]/.test(head)) return false;
  return true;
}

/** Where the browser posts the manifest: the admin's own account, or an organisation they administer. */
export function manifestAction(owner: string | null, state: string): string {
  const query = `?state=${encodeURIComponent(state)}`;
  return owner
    ? `${GITHUB_WEB}/organizations/${encodeURIComponent(owner)}/settings/apps/new${query}`
    : `${GITHUB_WEB}/settings/apps/new${query}`;
}

/** Short-lived cookie that ties the callback to the flow the admin started here. */
export function githubManifestStateCookie(state: string, secure: boolean): string {
  const parts = [
    `${GITHUB_MANIFEST_STATE_COOKIE}=${encodeURIComponent(state)}`,
    `Path=${MANIFEST_CALLBACK_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${20 * 60}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearGithubManifestStateCookie(secure: boolean): string {
  const parts = [`${GITHUB_MANIFEST_STATE_COOKIE}=`, `Path=${MANIFEST_CALLBACK_PATH}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/** What GitHub returns for a manifest code, in the GitHub App integration's fields plus the App's page. */
export type ConvertedGithubApp = {
  app_id: string;
  slug: string;
  private_key: string;
  client_id: string;
  client_secret: string;
  html_url: string;
};

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new GithubError(`GitHub App creation returned no ${name}`);
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await readJson(response)) as { message?: unknown };
    return typeof body.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

/**
 * Trades the callback's code for the new App. GitHub answers this once per code, within an hour
 * of the confirmation, and needs no token for it.
 */
export async function convertManifestCode(
  code: string,
  options: { fetch?: FetchFn | undefined; proxyUrl?: string | undefined } = {},
): Promise<ConvertedGithubApp> {
  const fetchFn = options.fetch ?? proxyFetch(options.proxyUrl ?? "");
  const response = await fetchFn(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "guilds.run",
    },
  });
  if (response.status !== 201) {
    const message = await errorMessage(response);
    throw new GithubError(`GitHub App creation failed: ${response.status}${message ? ` ${message}` : ""}`, response.status);
  }
  const body = (await readJson(response)) as Record<string, unknown>;
  return {
    app_id: stringField(body, "id"),
    slug: stringField(body, "slug"),
    private_key: stringField(body, "pem"),
    client_id: stringField(body, "client_id"),
    client_secret: stringField(body, "client_secret"),
    html_url: typeof body.html_url === "string" ? body.html_url : "",
  };
}
