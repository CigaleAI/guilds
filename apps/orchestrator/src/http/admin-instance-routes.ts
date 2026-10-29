import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
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
import { applyKeyChange } from "../connectors/instance.js";
import { installedManifests } from "../connectors/servers.js";
import { assertKeyChangeConfirmed } from "../instance/changes.js";
import {
  GITHUB_APP,
  installedIntegrations,
  integrationStatuses,
  type Integration,
  type IntegrationStatus,
} from "../instance/integrations.js";
import { validateKeyValues } from "../instance/keys.js";
import { newState } from "../oauth/index.js";
import { writeLog } from "../observability/log.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import type { InstanceKeys } from "../instance/keys.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { HttpError } from "./errors.js";
import { currentUser } from "./identity.js";
import { instanceAdminOnly } from "./instance-admin.js";

/** How long a started manifest flow waits for GitHub's redirect. */
const PENDING_MS = 20 * 60 * 1000;
const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

type PendingManifest = { userId: string; returnTo: string | null; expiresAt: number };

/** The path of one integration's keys. */
const IntegrationParams = Type.Object({ integration: Type.String() });

/** An integration's values to store, which its own fields check, and whether a change in use is confirmed. */
const KeyWriteSchema = Type.Object({
  values: Type.Optional(Type.Unknown()),
  confirm_replace: Type.Optional(Type.Boolean()),
});

/** Whether removing values in use is confirmed: `1` or `true`. */
const KeyRemoveQuery = Type.Object({ confirm_replace: Type.Optional(Type.String()) });

/** A GitHub App to register from a manifest: its name, the organisation it belongs to, and where to come back to. */
const ManifestStartSchema = Type.Object({
  name: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  return_to: Type.Optional(Type.String()),
});

/** What GitHub sends the browser back with once the admin confirmed the App. */
const ManifestCallbackQuery = Type.Object({
  code: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
});

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

export async function registerAdminInstanceRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const keys = keysOf(deps);
  const pending = new Map<string, PendingManifest>();
  const integrations = () => deps.integrations ?? installedIntegrations();
  const secure = () => cookieSecure(deps.config?.publicBaseUrl ?? "");
  const adminPage = `/admin?tab=instance&integration=${GITHUB_APP.id}`;
  const preValidation = instanceAdminOnly(deps);

  function integrationOf(id: string): Integration {
    const integration = integrations().find((item) => item.id === id);
    if (!integration) {
      throw new HttpError(404, "Not Found");
    }
    return integration;
  }

  function statusOf(id: string): IntegrationStatus {
    const status = integrationStatuses(integrations(), installedManifests(), undefined, { audit: true }).find((item) => item.id === id);
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

  app.put(
    "/api/admin/instance/keys/:integration",
    { preValidation, schema: { params: IntegrationParams, body: KeyWriteSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const integration = integrationOf(request.params.integration);
      const body = request.body;
      const values = validateKeyValues(integration, body.values ?? {});
      if (body.confirm_replace !== true) {
        await assertKeyChangeConfirmed(db, integration, keys.current(integration.id), values);
      }
      const { previous } = await keys.put(integration, values, user.id);
      const { disconnected } = await applyKeyChange(
        { db, masterKey: deps.masterKey, mcp: deps.mcp },
        integration.id,
        previous,
        values,
      );
      return { integration: statusOf(integration.id), disconnected };
    },
  );

  app.delete(
    "/api/admin/instance/keys/:integration",
    { preValidation, schema: { params: IntegrationParams, querystring: KeyRemoveQuery } },
    async (request) => {
      const integration = integrationOf(request.params.integration);
      if (integration.source !== "store") {
        throw new HttpError(400, `${integration.label} is read from the environment`);
      }
      const confirm = request.query.confirm_replace;
      if (confirm !== "1" && confirm !== "true") {
        await assertKeyChangeConfirmed(db, integration, keys.current(integration.id), null);
      }
      const { previous } = await keys.remove(integration.id);
      const { disconnected } = await applyKeyChange(
        { db, masterKey: deps.masterKey, mcp: deps.mcp },
        integration.id,
        previous,
        null,
      );
      return { integration: statusOf(integration.id), disconnected };
    },
  );

  /** Starts the manifest flow: what the browser posts to GitHub, and the state that ties the redirect back to this admin. */
  app.post(
    "/api/admin/instance/keys/github-app/manifest",
    { preValidation, schema: { body: ManifestStartSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const body = request.body;
      const name = (body.name ?? "").trim();
      if (name.length > APP_NAME_MAX) {
        throw new HttpError(400, `the App name is at most ${APP_NAME_MAX} characters`);
      }
      const owner = (body.owner ?? "").trim();
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
      pending.set(state, { userId: user.id, returnTo, expiresAt: now + PENDING_MS });
      appendSetCookie(reply, githubManifestStateCookie(state, secure()));
      return {
        action: manifestAction(owner || null, state),
        manifest: githubAppManifest({ baseUrl: base, requestOrigin: origin, ...(name ? { name } : {}) }),
        state,
      };
    },
  );

  /**
   * GitHub's redirect after the admin confirmed the App. The state proves this browser started
   * the flow here; the code is traded for the App and stored for the admin who started it.
   */
  app.get(MANIFEST_CALLBACK_PATH, { schema: { querystring: ManifestCallbackQuery } }, async (request, reply) => {
    const code = request.query.code ?? "";
    const state = request.query.state ?? "";
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
      await applyKeyChange({ db, masterKey: deps.masterKey, mcp: deps.mcp }, GITHUB_APP.id, previous, values);
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
