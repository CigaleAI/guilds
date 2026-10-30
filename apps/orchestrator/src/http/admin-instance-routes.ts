import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  removeInstanceKey,
  writeInstanceKey,
  type InstanceKeyServices,
} from "../connectors/instance-keys.js";
import {
  clearGithubManifestStateCookie,
  GITHUB_MANIFEST_STATE_COOKIE,
  githubManifestStateCookie,
  MANIFEST_CALLBACK_PATH,
} from "../github/manifest.js";
import { GITHUB_APP } from "../instance/integrations.js";
import { GithubManifestFlows, type ManifestAddresses } from "../mcp/github-app-manifest.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import type { InstanceKeys } from "../instance/keys.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";
import { instanceAdminOnly } from "./instance-admin.js";

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

function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader("set-cookie");
  if (!existing) {
    reply.header("set-cookie", value);
    return;
  }
  const list = (Array.isArray(existing) ? existing : [existing]).map(String);
  reply.header("set-cookie", [...list, value]);
}

function keysOf(deps: AppDeps): InstanceKeys {
  if (!deps.instanceKeys) {
    throw new Error("instance keys store is required");
  }
  return deps.instanceKeys;
}

/**
 * The instance admin's keys: writing and removing a store integration's values, and registering
 * the GitHub App from a manifest. Values go in and never come back out.
 */
export async function registerAdminInstanceRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const keys = keysOf(deps);
  const flows = new GithubManifestFlows();
  const secure = () => cookieSecure(deps.config?.publicBaseUrl ?? "");
  const adminPage = `/admin?tab=instance&integration=${GITHUB_APP.id}`;
  const preValidation = instanceAdminOnly(deps);
  const services = (): InstanceKeyServices => ({
    keys,
    integrations: deps.integrations,
    masterKey: deps.masterKey,
    mcp: deps.mcp,
  });

  /** The box's address for the manifest's URLs, and the one this request came in on. */
  function addresses(request: FastifyRequest): ManifestAddresses {
    const host = String(request.headers.host ?? "127.0.0.1");
    const origin = `${request.protocol}://${host}`;
    const configured = (deps.config?.publicBaseUrl ?? "").trim().replace(/\/+$/, "");
    return { baseUrl: configured || origin, requestOrigin: origin };
  }

  app.put(
    "/api/admin/instance/keys/:integration",
    { preValidation, schema: { params: IntegrationParams, body: KeyWriteSchema } },
    async (request) => {
      const user = await currentUser(db, request, deps);
      const body = request.body;
      const write = {
        integrationId: request.params.integration,
        values: body.values,
        confirmed: body.confirm_replace === true,
      };
      return writeInstanceKey(db, services(), write, user.id);
    },
  );

  app.delete(
    "/api/admin/instance/keys/:integration",
    { preValidation, schema: { params: IntegrationParams, querystring: KeyRemoveQuery } },
    async (request) => {
      const confirm = request.query.confirm_replace;
      const removal = {
        integrationId: request.params.integration,
        confirmed: confirm === "1" || confirm === "true",
      };
      return removeInstanceKey(db, services(), removal);
    },
  );

  /** Starts the manifest flow: what the browser posts to GitHub, and the state that ties the redirect back to this admin. */
  app.post(
    "/api/admin/instance/keys/github-app/manifest",
    { preValidation, schema: { body: ManifestStartSchema } },
    async (request, reply) => {
      const user = await currentUser(db, request, deps);
      const body = request.body;
      const asked = {
        name: body.name ?? "",
        owner: body.owner ?? "",
        returnTo: body.return_to,
        ...addresses(request),
      };
      const started = flows.start(asked, user.id);
      appendSetCookie(reply, githubManifestStateCookie(started.state, secure()));
      return started;
    },
  );

  /** GitHub's redirect after the admin confirmed the App: back where the admin asked, or to the admin page with the failure. */
  app.get(MANIFEST_CALLBACK_PATH, { schema: { querystring: ManifestCallbackQuery } }, async (request, reply) => {
    const callback = {
      code: request.query.code ?? "",
      state: request.query.state ?? "",
      cookieState: requestCookies(request)[GITHUB_MANIFEST_STATE_COOKIE] ?? "",
    };
    appendSetCookie(reply, clearGithubManifestStateCookie(secure()));
    const outcome = await flows.complete(db, services(), callback);
    if ("failure" in outcome) {
      return reply.redirect(`${adminPage}&setup_error=${outcome.failure}`);
    }
    return reply.redirect(outcome.returnTo ?? adminPage);
  });
}
