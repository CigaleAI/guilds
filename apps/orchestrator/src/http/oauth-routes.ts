import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  githubInstallationPickerHtml,
  oauthCallbackHtml,
  oauthCallbackUrl,
} from "../oauth/index.js";
import { completeOAuthCallback, type CallbackPage } from "../oauth/connect-callback.js";
import type { ConnectFlowServices } from "../oauth/connect-flow.js";
import { startConnection } from "../oauth/connect-start.js";
import {
  chooseGithubInstallation,
  listGithubInstallations,
  loadGithubPickerSession,
} from "../oauth/github-install.js";
import {
  clearGithubOauthStateCookie,
  GITHUB_OAUTH_STATE_COOKIE,
  githubOauthStateCookie,
} from "../github/index.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import type { AppDeps } from "./deps.js";
import { missingBodyFields } from "./errors.js";
import { currentUser, identityDatabase } from "./identity.js";
import { bodyOf, queryOf } from "./request.js";

function sendPage(reply: FastifyReply, page: CallbackPage): FastifyReply {
  const { status, ...content } = page;
  return reply.code(status).type("text/html; charset=utf-8").send(oauthCallbackHtml(content));
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
 * A login started by an operator, the provider's callback that completes it, and the picker a
 * GitHub sign-in opens when its user has several installations.
 */
export async function registerOAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const services: ConnectFlowServices = { db, mcp: deps.mcp ?? null, masterKey: deps.masterKey };
  const secureCookie = () => cookieSecure(deps.config?.publicBaseUrl ?? "");
  const redirectUriOf = (request: FastifyRequest) =>
    oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);

  app.post("/api/mcp/connections", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const missing = missingBodyFields(request.body, ["mcp_server_id", "owner_scope"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    const started = await startConnection(services, String(user.id), {
      serverId: String(body.mcp_server_id ?? ""),
      ownerScope: String(body.owner_scope ?? ""),
      ownerId: body.owner_id,
      form: body,
      redirectUri: redirectUriOf(request),
    });
    if (started.githubState !== null) {
      appendSetCookie(reply, githubOauthStateCookie(started.githubState, secureCookie()));
    }
    return reply.code(201).send(started.connection);
  });

  app.get("/api/mcp/oauth/callback", async (request, reply) => {
    const query = queryOf(request);
    const callback = {
      code: query.code || undefined,
      state: query.state || undefined,
      cookieState: requestCookies(request)[GITHUB_OAUTH_STATE_COOKIE] || undefined,
      error: query.error || undefined,
      errorDescription: query.error_description || undefined,
      installationId: query.installation_id || undefined,
      setupAction: query.setup_action || undefined,
    };
    const signedInUserId = async () => {
      try {
        return String((await currentUser(identityDb, request, deps)).id);
      } catch {
        return null;
      }
    };
    const outcome = await completeOAuthCallback(services, callback, {
      redirectUri: redirectUriOf(request),
      signedInUserId,
    });
    if (outcome.clearsGithubCookie) {
      appendSetCookie(reply, clearGithubOauthStateCookie(secureCookie()));
    }
    return "redirect" in outcome ? reply.redirect(outcome.redirect) : sendPage(reply, outcome.page);
  });

  app.get("/api/mcp/oauth/github-installation", async (request, reply) => {
    if ((await loadGithubPickerSession(services, queryOf(request).state)) === null) {
      return sendPage(reply, {
        status: 404,
        success: false,
        title: "Session Expired",
        message:
          "This authorization request has expired or was already completed. Please try connecting again.",
      });
    }
    return reply.code(200).type("text/html; charset=utf-8").send(githubInstallationPickerHtml());
  });

  app.get("/api/mcp/oauth/github-installations", async (request) =>
    listGithubInstallations(services, queryOf(request).state),
  );

  app.post("/api/mcp/oauth/github-installation", async (request) => {
    const body = bodyOf(request);
    const state = typeof body.state === "string" ? body.state : "";
    return chooseGithubInstallation(services, state, body.installation_id);
  });
}
