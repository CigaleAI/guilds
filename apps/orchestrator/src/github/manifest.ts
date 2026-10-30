import { Value } from "@sinclair/typebox/value";
import { decode } from "../lib/decode.js";
import { proxyFetch, readJson } from "../net/http.js";
import { GITHUB_API, GithubError, unexpectedGithubReply, type GithubServices } from "./index.js";
import { ErrorReply, ManifestConversionReply } from "./responses.js";

/**
 * Registering the box's GitHub App from a manifest: the operator app posts the manifest to GitHub,
 * the admin confirms there, GitHub sends a one-use code back to the box, and the box trades it
 * for the App's credentials. Nothing here holds a credential; `GithubManifestFlows` stores what comes back.
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
export function githubAppManifest(baseUrl: string, requestOrigin: string, name = ""): GithubAppManifest {
  const base = trimBase(baseUrl);
  const origin = trimBase(requestOrigin);
  const callbacks = [`${base}${OAUTH_CALLBACK_PATH}`];
  if (origin && origin !== base) {
    callbacks.push(`${origin}${OAUTH_CALLBACK_PATH}`);
  }
  const hook = publicHook(base);
  return {
    name: name.trim() || `Guilds (${hostOf(base)})`,
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

/** A credential GitHub sent as a non-blank string or a number, as a string. */
function credentialField(value: unknown, name: string): string {
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
    const body = await readJson(response);
    return Value.Check(ErrorReply, body) ? body.message : "";
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
  services: GithubServices = {},
): Promise<ConvertedGithubApp> {
  const fetchFn = services.fetch ?? proxyFetch(services.proxyUrl ?? "");
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
  const body = decode(ManifestConversionReply, await readJson(response), unexpectedGithubReply);
  return {
    app_id: credentialField(body.id, "id"),
    slug: credentialField(body.slug, "slug"),
    private_key: credentialField(body.pem, "pem"),
    client_id: credentialField(body.client_id, "client_id"),
    client_secret: credentialField(body.client_secret, "client_secret"),
    html_url: typeof body.html_url === "string" ? body.html_url : "",
  };
}
