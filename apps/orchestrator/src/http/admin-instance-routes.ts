import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GITHUB_SERVER_ID } from "../github/index.js";
import {
  APP_NAME_MAX,
  clearGithubManifestStateCookie,
  convertManifestCode,
  GITHUB_MANIFEST_STATE_COOKIE,
  githubAppManifest,
  githubManifestStateCookie,
  MANIFEST_CALLBACK_PATH,
  manifestAction,
} from "../github/manifest.js";
import { applyKeyChange, replacesGithubApp } from "../instance/changes.js";
import {
  GITHUB_APP,
  installedIntegrations,
  integrationStatuses,
  type Integration,
  type IntegrationStatus,
} from "../instance/integrations.js";
import { InstanceKeyError, validateKeyValues } from "../instance/keys.js";
import { newState } from "../oauth/index.js";
import { writeLog } from "../observability/log.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import type { InstanceKeys } from "../instance/keys.js";
import type { AppDeps } from "./deps.js";
import { HttpError } from "./errors.js";
import { requireInstanceAdmin } from "./instance-admin.js";

/** How long a started manifest flow waits for GitHub's redirect. */
const PENDING_MS = 20 * 60 * 1000;
const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

type PendingManifest = { userId: string; returnTo: string | null; expiresAt: number };

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function queryOf(request: FastifyRequest): Record<string, unknown> {
  const query = request.query;
  return query && typeof query === "object" ? (query as Record<string, unknown>) : {};
}

/** A path on this app the callback may send the admin back to; never another origin. */
export function sameOriginPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path)) {
    return null;
  }
  return path;
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader("set-cookie");
  if (!existing) {
    reply.header("set-cookie", value);
    return;
  }
  const list = (Array.isArray(existing) ? existing : [existing]).map(String);
  reply.header("set-cookie", [...list, value]);
}

/**
 * The instance admin's keys: writing and removing a store integration's values, and registering
 * the GitHub App from a manifest. Values go in and never come back out.
 */
function keysOf(deps: AppDeps): InstanceKeys {
  if (!deps.instanceKeys) {
    throw new Error("instance keys store is required");
  }
  return deps.instanceKeys;
}

export async function registerAdminInstanceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { repo } = deps;
  const keys = keysOf(deps);
  const pending = new Map<string, PendingManifest>();
  const integrations = () => deps.integrations ?? installedIntegrations();
  const secure = () => cookieSecure(deps.config?.publicBaseUrl ?? "");
  const adminPage = `/admin?tab=instance&integration=${GITHUB_APP.id}`;

  function integrationOf(request: FastifyRequest): Integration {
    const id = (request.params as Record<string, string>).integration;
    const integration = integrations().find((item) => item.id === id);
    if (!integration) {
      throw new HttpError(404, "Not Found");
    }
    return integration;
  }

  function statusOf(id: string): IntegrationStatus {
    const status = integrationStatuses(integrations(), undefined, undefined, { audit: true }).find((item) => item.id === id);
    if (!status) {
      throw new HttpError(404, "Not Found");
    }
    return status;
  }

  /** The box's address for the manifest's URLs, and the one this request came in on. */
  function addresses(request: FastifyRequest): { base: string; origin: string } {
    const host = String(request.headers.host ?? "127.0.0.1");
    const origin = `${request.protocol}://${host}`;
    const configured = (deps.config?.publicBaseUrl ?? "").trim().replace(/\/+$/, "");
    return { base: configured || origin, origin };
  }

  /**
   * A GitHub App write that puts another App in place, or takes it away, strands every login
   * installed with the old one. The admin confirms that, with the count, before it happens.
   */
  async function confirmGithubReplace(integration: Integration, next: Record<string, string> | null, confirmed: boolean): Promise<void> {
    if (integration.id !== GITHUB_APP.id || confirmed) {
      return;
    }
    if (!replacesGithubApp(keys.current(integration.id), next)) {
      return;
    }
    const connections = await repo.countServerConnections(GITHUB_SERVER_ID);
    if (connections === 0) {
      return;
    }
    throw new HttpError(409, {
      message: `Replacing the GitHub App disconnects ${connections} GitHub login${connections === 1 ? "" : "s"}.`,
      replaces_app: true,
      connections,
    });
  }

  app.put("/api/admin/instance/keys/:integration", async (request) => {
    const user = await requireInstanceAdmin(deps, request);
    const integration = integrationOf(request);
    const body = bodyOf(request);
    let values: Record<string, string>;
    try {
      values = validateKeyValues(integration, body.values ?? {});
    } catch (error) {
      if (error instanceof InstanceKeyError) {
        throw new HttpError(error.status, error.message);
      }
      throw error;
    }
    await confirmGithubReplace(integration, values, body.confirm_replace === true);
    const { previous } = await keys.put(integration, values, String(user.id));
    const { disconnected } = await applyKeyChange(
      { repo, masterKey: deps.masterKey, mcp: deps.mcp },
      integration.id,
      previous,
      values,
    );
    return { integration: statusOf(integration.id), disconnected };
  });

  app.delete("/api/admin/instance/keys/:integration", async (request) => {
    await requireInstanceAdmin(deps, request);
    const integration = integrationOf(request);
    if (integration.source !== "store") {
      throw new HttpError(400, `${integration.label} is read from the environment`);
    }
    const confirm = queryOf(request).confirm_replace;
    await confirmGithubReplace(integration, null, confirm === "1" || confirm === "true");
    const { previous } = await keys.remove(integration.id);
    const { disconnected } = await applyKeyChange(
      { repo, masterKey: deps.masterKey, mcp: deps.mcp },
      integration.id,
      previous,
      null,
    );
    return { integration: statusOf(integration.id), disconnected };
  });

  /** Starts the manifest flow: what the browser posts to GitHub, and the state that ties the redirect back to this admin. */
  app.post("/api/admin/instance/keys/github-app/manifest", async (request, reply) => {
    const user = await requireInstanceAdmin(deps, request);
    const body = bodyOf(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length > APP_NAME_MAX) {
      throw new HttpError(400, `the App name is at most ${APP_NAME_MAX} characters`);
    }
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    if (owner && !OWNER_PATTERN.test(owner)) {
      throw new HttpError(400, "owner must be a GitHub organisation login");
    }
    const returnTo = sameOriginPath(body.return_to);
    const { base, origin } = addresses(request);
    const now = Date.now();
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(key);
      }
    }
    const state = newState();
    pending.set(state, { userId: String(user.id), returnTo, expiresAt: now + PENDING_MS });
    appendSetCookie(reply, githubManifestStateCookie(state, secure()));
    return {
      action: manifestAction(owner || null, state),
      manifest: githubAppManifest({ baseUrl: base, requestOrigin: origin, ...(name ? { name } : {}) }),
      state,
    };
  });

  /**
   * GitHub's redirect after the admin confirmed the App. The state proves this browser started
   * the flow here; the code is traded for the App and stored for the admin who started it.
   */
  app.get(MANIFEST_CALLBACK_PATH, async (request, reply) => {
    const query = queryOf(request);
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    const cookie = requestCookies(request)[GITHUB_MANIFEST_STATE_COOKIE] ?? "";
    appendSetCookie(reply, clearGithubManifestStateCookie(secure()));
    const fail = (reason: "state" | "conversion" | "store") => reply.redirect(`${adminPage}&setup_error=${reason}`);
    const entry = state ? pending.get(state) : undefined;
    if (entry) {
      pending.delete(state);
    }
    if (!entry || !cookie || cookie !== state || entry.expiresAt <= Date.now() || !code) {
      return fail("state");
    }
    let converted;
    try {
      converted = await convertManifestCode(code, { proxyUrl: process.env.ADAPTER_PROXY_URL ?? "" });
    } catch (error) {
      writeLog("warn", `github app manifest conversion failed: ${error instanceof Error ? error.message : String(error)}`, {
        operation: "instance_keys.github_manifest",
        error_type: error instanceof Error ? error.name : "Error",
      });
      return fail("conversion");
    }
    const values = {
      app_id: converted.app_id,
      slug: converted.slug,
      private_key: converted.private_key,
      client_id: converted.client_id,
      client_secret: converted.client_secret,
    };
    try {
      const { previous } = await keys.put(GITHUB_APP, values, entry.userId);
      await applyKeyChange({ repo, masterKey: deps.masterKey, mcp: deps.mcp }, GITHUB_APP.id, previous, values);
    } catch (error) {
      writeLog("error", `github app could not be stored: ${error instanceof Error ? error.message : String(error)}`, {
        operation: "instance_keys.github_manifest",
        error_type: error instanceof Error ? error.name : "Error",
      });
      return fail("store");
    }
    return reply.redirect(entry.returnTo ?? adminPage);
  });
}
