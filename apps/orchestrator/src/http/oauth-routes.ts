import { Type } from "@sinclair/typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import { githubInstallationPickerHtml, oauthCallbackHtml } from "../oauth/html.js";
import { oauthCallbackUrl } from "../oauth/index.js";
import { completeOAuthCallback, type CallbackPage } from "../mcp/connect-callback.js";
import type { ConnectFlowServices } from "../mcp/connect-flow.js";
import { startConnection } from "../mcp/connect-start.js";
import {
  chooseGithubInstallation,
  listGithubInstallations,
  loadGithubPickerSession,
} from "../mcp/github-install.js";
import {
  clearGithubOauthStateCookie,
  GITHUB_OAUTH_STATE_COOKIE,
  githubOauthStateCookie,
} from "../github/index.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import type { AppDeps, RouteApp } from "./deps.js";
import { currentUser } from "./identity.js";

/**
 * A Connect: the connector, the owner, and the form's other fields (a token login's credentials
 * and settings), which the connector's own credential rules check.
 */
const ConnectSchema = Type.Object({
  mcp_server_id: Type.String(),
  owner_scope: Type.String(),
  owner_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** What a provider sends the browser back with. */
const OAuthCallbackQuery = Type.Object({
  code: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  error_description: Type.Optional(Type.String()),
  installation_id: Type.Optional(Type.String()),
  setup_action: Type.Optional(Type.String()),
});

/** The GitHub sign-in a picker belongs to. */
const PickerQuery = Type.Object({ state: Type.Optional(Type.String()) });

/** The installation a GitHub sign-in picks. */
const InstallationChoiceSchema = Type.Object({
  state: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  installation_id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
});

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
export async function registerOAuthRoutes(app: RouteApp, deps: AppDeps): Promise<void> {
  const { db } = deps;
  const services: ConnectFlowServices = { db, mcp: deps.mcp ?? null, masterKey: deps.masterKey };
  const secureCookie = () => cookieSecure(deps.config?.publicBaseUrl ?? "");
  const redirectUriOf = (request: FastifyRequest) =>
    oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);

  app.post("/api/mcp/connections", { schema: { body: ConnectSchema } }, async (request, reply) => {
    const user = await currentUser(db, request, deps);
    const body = request.body;
    const started = await startConnection(services, user.id, {
      serverId: body.mcp_server_id,
      ownerScope: body.owner_scope,
      ownerId: body.owner_id,
      form: body,
      redirectUri: redirectUriOf(request),
    });
    if (started.githubState !== null) {
      appendSetCookie(reply, githubOauthStateCookie(started.githubState, secureCookie()));
    }
    return reply.code(201).send(started.connection);
  });

  app.get(
    "/api/mcp/oauth/callback",
    { schema: { querystring: OAuthCallbackQuery } },
    async (request, reply) => {
      const { query } = request;
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
          return String((await currentUser(db, request, deps)).id);
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
      return "redirect" in outcome
        ? reply.redirect(outcome.redirect)
        : sendPage(reply, outcome.page);
    },
  );

  app.get(
    "/api/mcp/oauth/github-installation",
    { schema: { querystring: PickerQuery } },
    async (request, reply) => {
      if ((await loadGithubPickerSession(services, request.query.state)) === null) {
        return sendPage(reply, {
          status: 404,
          success: false,
          title: "Session Expired",
          message:
            "This authorization request has expired or was already completed. Please try connecting again.",
        });
      }
      return reply
        .code(200)
        .type("text/html; charset=utf-8")
        .send(githubInstallationPickerHtml());
    },
  );

  app.get(
    "/api/mcp/oauth/github-installations",
    { schema: { querystring: PickerQuery } },
    async (request) => listGithubInstallations(services, request.query.state),
  );

  app.post(
    "/api/mcp/oauth/github-installation",
    { schema: { body: InstallationChoiceSchema } },
    async (request) =>
      chooseGithubInstallation(
        services,
        request.body.state ?? "",
        request.body.installation_id,
      ),
  );
}
