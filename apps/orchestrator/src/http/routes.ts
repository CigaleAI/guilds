import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireVisibleGuild } from "../guilds/access.js";
import { requireVisibleAgent } from "../agents/access.js";
import { asBuffer, decryptPayload, encryptPayload } from "../credentials/crypto.js";
import {
  connectionMetadata,
} from "../credentials/items.js";
import {
  CredentialError,
  type OwnerScope,
  validateOwner,
} from "../credentials/validate.js";
import { newId } from "../lib/ids.js";
import { markDisconnected, mcpDatabase } from "../mcp/index.js";
import {
  connect,
  connectDatabase,
  ConnectError,
} from "../connectors/connect.js";
import { settingsComplete } from "../connectors/settings.js";
import type { Manifest } from "../connectors/manifest.js";
import { DESCRIPTION_MAX } from "../mcp/catalog.js";
import { installedConnectors } from "../connectors/index.js";
import {
  accountHint,
  authorizationUrl,
  ensureClient,
  exchangeCode,
  githubInstallationPickerHtml,
  isGithubApp,
  newState,
  oauthCallbackHtml,
  oauthCallbackUrl,
  oauthDatabase,
  OAuthError,
  OAuthUnsupportedError,
  pendingOauth,
  pendingOauthPayload,
  pendingReplaces,
  pkcePair,
  startsBrowserOauth,
  tokenPayload,
} from "../oauth/index.js";
import { installedIntegrations, integrationStatuses } from "../instance/integrations.js";
import { registerAdminInstanceRoutes } from "./admin-instance-routes.js";
import { Notifications, notificationsDatabase } from "../notifications/index.js";
import { registerAccessRoutes } from "./access-routes.js";
import { registerAttachmentRoutes } from "./attachment-routes.js";
import { registerUsageRoutes } from "./usage-routes.js";
import { registerStudioRoutes } from "./studio-routes.js";
import { registerFileRoutes } from "./file-routes.js";
import type { RouteDeps } from "./deps.js";
import { HttpError, missingBodyFields } from "./errors.js";
import { registerCodingRoutes } from "./coding-routes.js";
import { registerMeRoutes } from "./me-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerArtifactAccessRoutes } from "./artifact-access-routes.js";
import { registerBindingRoutes } from "./binding-routes.js";
import { registerCollectionRoutes } from "./collection-routes.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import { registerGroupChatRoutes } from "./group-chat-routes.js";
import { registerGuildRoutes } from "./guild-routes.js";
import { registerIssueRoutes } from "./issue-routes.js";
import { registerNoteRoutes } from "./note-routes.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { registerOrgRoutes } from "./org-routes.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";
import { registerScheduleRoutes } from "./schedule-routes.js";
import { registerScriptRoutes } from "./script-routes.js";
import { registerSecretRoutes } from "./secret-routes.js";
import { registerUserRoutes } from "./user-routes.js";
import { registerModelProviderRoutes } from "./model-provider-routes.js";
import {
  clearGithubOauthStateCookie,
  exchangeUserCode,
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_SERVER_ID,
  GITHUB_SLUG,
  githubAppConfig,
  githubOauthStateCookie,
  GithubError,
  installUrl,
  requireGithubApp,
  resolveGithubInstallation,
  userAuthorizationUrl,
  type GithubInstallation,
} from "../github/index.js";
import { registerAdminMcpRoutes } from "./admin-mcp-routes.js";
import { registerAdminRegistryRoutes } from "./admin-registry-routes.js";
import { registerOrgConnectorRoutes } from "./org-connector-routes.js";
import { registerMachineRoutes } from "./machine-routes.js";
import { registerBuilderCapabilityRoutes } from "./builder-capability-routes.js";
import { registerBuilderSessionRoutes } from "./builder-routes.js";
import { registerRecipeRoutes } from "./recipe-routes.js";
import { cookieSecure, requestCookies } from "./cookies.js";
import { currentUser, identityDatabase } from "./identity.js";
import { isInstanceAdmin } from "./instance-admin.js";
import { bodyOf, queryOf } from "./request.js";
import {
  getMembership,
} from "../db/orgs.js";
import {
  getGuild,
} from "../db/guilds.js";
import { getAgent } from "../db/agents.js";
import {
  bindMcpConnection,
  connectMcp,
  deleteMcpConnection,
  getMcpConnectionByOauthState,
  getMcpConnectionForOwner,
  getPendingGithubConnectionForUser,
  saveMcpConnection,
} from "../db/mcp.js";
import { getMcpServer, updateConnector } from "../db/connectors.js";

/** Whether an organisation sees a server: the platform's, or one of its own. */
function serverVisible(server: Record<string, unknown>, orgId: string | null): boolean {
  return !server.owner_org_id || server.owner_org_id === orgId;
}

async function send(reply: FastifyReply, status: number, payload?: unknown): Promise<FastifyReply> {
  if (status === 204) {
    return reply.code(204).send();
  }
  return reply.code(status).send(payload);
}

export async function registerDomainRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const identityDb = identityDatabase(db);
  const notifications = new Notifications(notificationsDatabase(db));

  deps.generation?.group_chat.observe((guildId, event, data) => notifications.observe(guildId, event, data));
  await registerMeRoutes(app, deps);
  await registerCodingRoutes(app, deps);
  await registerModelProviderRoutes(app, deps);
  await registerStudioRoutes(app, deps);
  await registerFileRoutes(app, deps);
  await registerAdminMcpRoutes(app, deps);
  await registerAdminRegistryRoutes(app, deps);
  await registerAdminInstanceRoutes(app, deps);
  await registerOrgConnectorRoutes(app, deps);
  await registerMachineRoutes(app, deps);
  await registerBuilderCapabilityRoutes(app, deps);
  await registerBuilderSessionRoutes(app, deps);
  await registerRecipeRoutes(app, deps);

  app.addHook("onSend", async (request, reply, payload) => {
    deps.identity?.onSend?.(request, reply);
    return payload;
  });
  await registerUserRoutes(app, deps);
  await registerOrgRoutes(app, deps);
  await registerGuildRoutes(app, deps);
  await registerGroupChatRoutes(app, deps, notifications);
  await registerNotificationRoutes(app, deps, notifications);
  await registerScheduleRoutes(app, deps);
  await registerScriptRoutes(app, deps);
  await registerIssueRoutes(app, deps);
  await registerAgentRoutes(app, deps);
  await registerRunRoutes(app, deps);
  await registerSandboxRoutes(app, deps);
  await registerUsageRoutes(app, deps);
  await registerAccessRoutes(app, deps);
  await registerAttachmentRoutes(app, deps);
  await registerNoteRoutes(app, deps);
  await registerCollectionRoutes(app, deps);
  await registerArtifactAccessRoutes(app, deps);
  await registerSecretRoutes(app, deps);
  await registerBindingRoutes(app, deps);
  await registerConnectionRoutes(app, deps);

  /**
   * What this box is: how it identifies a request and which integrations it has, never a key.
   * An instance admin also sees when and by whom each store integration was written.
   */
  app.get("/api/instance", async (request) => {
    const user = await currentUser(identityDb, request, deps);
    const audit = await isInstanceAdmin(deps, String(user.id));
    return {
      auth_mode: deps.config?.authMode ?? "compat-cookie",
      integrations: integrationStatuses(deps.integrations ?? installedIntegrations(), undefined, undefined, { audit }),
    };
  });

  /** The organisation a login's owner belongs to; null for the platform. */
  async function ownerOrgId(ownerScope: string, ownerId: string | null): Promise<string | null> {
    if (ownerScope === "org") {
      return ownerId;
    }
    if (ownerScope === "guild") {
      const guild = await getGuild(db, ownerId ?? "");
      return guild === null ? null : String(guild.org_id);
    }
    if (ownerScope === "agent") {
      const agent = await getAgent(db, ownerId ?? "");
      return agent === null ? null : String(agent.org_id);
    }
    return null;
  }

  async function assertOwner(
    ownerScope: string,
    ownerId: string | null,
    user: Record<string, unknown>,
  ): Promise<string | null> {
    if (ownerScope === "platform") {
      throw new HttpError(400, "platform-owned credentials cannot be created here");
    }
    if (ownerScope === "org") {
      const membership = await getMembership(db, ownerId || "", String(user.id));
      if (membership === null) {
        throw new HttpError(404, "organisation not found");
      }
      return null;
    }
    if (ownerScope === "guild") {
      const row = await requireVisibleGuild(db, ownerId || "", String(user.id));
      return String(row.id);
    }
    const row = await requireVisibleAgent(db, ownerId || "", String(user.id));
    return String(row.guild_id);
  }

  function encrypt(payload: Record<string, unknown>): [Buffer, Buffer] {
    return deps.masterKey ? encryptPayload(payload, deps.masterKey) : encryptPayload(payload);
  }

  function decrypt(ciphertext: unknown, nonce: unknown): Record<string, unknown> {
    return decryptPayload(asBuffer(ciphertext), asBuffer(nonce), deps.masterKey);
  }

  async function sendHtml(
    reply: FastifyReply,
    status: number,
    options: { success: boolean; title: string; message: string },
  ): Promise<FastifyReply> {
    return reply
      .code(status)
      .type("text/html; charset=utf-8")
      .header("content-type", "text/html; charset=utf-8")
      .send(oauthCallbackHtml(options));
  }

  async function discardAttempt(
    row: Record<string, unknown>,
    replaces?: boolean | undefined,
  ): Promise<void> {
    let keep = replaces;
    if (keep === undefined) {
      try {
        keep = pendingReplaces(decrypt(row.ciphertext, row.nonce));
      } catch {
        keep = false;
      }
    }
    if (keep) {
      await markDisconnected(mcpDatabase(db), row);
    } else {
      await deleteMcpConnection(db, String(row.id));
    }
    deps.mcp?.forget(String(row.id));
  }

  async function abandonOauthAttempt(state: string | undefined): Promise<void> {
    if (!state) {
      return;
    }
    const row = await getMcpConnectionByOauthState(db, state);
    if (row !== null) {
      await discardAttempt(row);
    }
  }

  async function finishOauthConnection(
    row: Record<string, unknown>,
    server: Record<string, unknown>,
    stored: Record<string, unknown>,
    now: Date,
  ): Promise<Record<string, unknown> | null> {
    const [ciphertext, nonce] = encrypt(stored);
    const connected = await saveMcpConnection(db,
      String(row.id),
      {
        ciphertext,
        nonce,
        status: "connected",
        accountHint: accountHint(stored),
        oauthState: null,
      },
      now,
    );
    if (connected !== null) {
      await bindMcpConnection(db,
        {
          bindingId: newId("bind"),
          serverId: connected.mcp_server_id,
          ownerScope: connected.owner_scope,
          ownerId: connected.owner_id,
          connectionId: connected.id,
        },
        now,
      );
      try {
        await deps.mcp?.syncTools(mcpDatabase(db), connected, server, { force: true });
      } catch {
        // Remote catalog sync is best-effort after OAuth, matching Python.
      }
      await fillFromEndpoint(connected, server);
    }
    return connected;
  }

  /**
   * Fills an organisation server's blank display name (its slug) and blank description from
   * what its endpoint says at `initialize`, once a login to it connects. A server that says
   * nothing keeps what it has.
   */
  async function fillFromEndpoint(connection: Record<string, unknown>, server: Record<string, unknown>): Promise<void> {
    if (!server.owner_org_id || !deps.mcp || connection.status !== "connected") {
      return;
    }
    const manifest = server.manifest as Manifest;
    const blankName = manifest.display_name === manifest.slug;
    const blankDescription = !manifest.description.trim();
    if (!blankName && !blankDescription) {
      return;
    }
    try {
      const info = await deps.mcp.describeEndpoint(mcpDatabase(db), connection, server);
      const next: Manifest = {
        ...manifest,
        ...(blankName && info.name ? { display_name: info.name.slice(0, 120) } : {}),
        ...(blankDescription && info.instructions ? { description: info.instructions.slice(0, DESCRIPTION_MAX) } : {}),
      };
      if (next.display_name !== manifest.display_name || next.description !== manifest.description) {
        await updateConnector(db, String(server.id), { manifest: next }, new Date());
      }
    } catch {
      // The server keeps the name and description it was added with.
    }
  }

  /** Stores a signed-in login that still needs its settings: pending, bound, with no sign-in under way. */
  async function awaitSettings(row: Record<string, unknown>, stored: Record<string, unknown>, now: Date): Promise<void> {
    const [ciphertext, nonce] = encrypt(stored);
    const saved = await saveMcpConnection(db,
      String(row.id),
      { ciphertext, nonce, status: "pending", accountHint: accountHint(stored), oauthState: null },
      now,
    );
    if (saved !== null) {
      await bindMcpConnection(db,
        {
          bindingId: newId("bind"),
          serverId: saved.mcp_server_id,
          ownerScope: saved.owner_scope,
          ownerId: saved.owner_id,
          connectionId: saved.id,
        },
        now,
      );
    }
  }

  function githubOauthCookieSecure(): boolean {
    return cookieSecure(deps.config?.publicBaseUrl ?? "");
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
   * The GitHub App callback: the code proves which user installed. The installation id
   * counts only when that user can reach it. With no id, one installation of this App is
   * kept, several open a picker, and none sends the operator to install. The user token
   * is discarded; the connection keeps the installation id.
   */
  async function applyGithubInstallation(
    row: Record<string, unknown>,
    installation: GithubInstallation,
  ): Promise<void> {
    const [ciphertext, nonce] = encrypt({ installation_id: installation.id, account: installation.account });
    const connected = await saveMcpConnection(db,
      String(row.id),
      {
        ciphertext,
        nonce,
        status: "connected",
        accountHint: installation.account,
        oauthState: null,
      },
      new Date(),
    );
    if (connected === null) {
      throw new OAuthError("the pending connection was removed");
    }
    await bindMcpConnection(db,
      {
        bindingId: newId("bind"),
        serverId: connected.mcp_server_id,
        ownerScope: connected.owner_scope,
        ownerId: connected.owner_id,
        connectionId: connected.id,
      },
      new Date(),
    );
  }

  function githubPendingFields(row: Record<string, unknown>): {
    storedId?: string;
    redirectUri?: string;
    pending: Record<string, unknown>;
  } {
    try {
      const pending = decrypt(row.ciphertext, row.nonce);
      const stored =
        pending.installation_id !== undefined && pending.installation_id !== null
          ? String(pending.installation_id)
          : undefined;
      const oauth = pending.oauth;
      let redirectUri: string | undefined;
      if (oauth && typeof oauth === "object" && !Array.isArray(oauth)) {
        const uri = (oauth as { redirect_uri?: unknown }).redirect_uri;
        if (typeof uri === "string" && uri) {
          redirectUri = uri;
        }
      }
      return { ...(stored ? { storedId: stored } : {}), ...(redirectUri ? { redirectUri } : {}), pending };
    } catch {
      return { pending: {} };
    }
  }

  async function completeGithubAuth(
    row: Record<string, unknown>,
    code: string,
    rawInstallationId: string | undefined,
  ): Promise<{ status: "connected" } | { status: "install" } | { status: "pick"; state: string }> {
    const fields = githubPendingFields(row);
    const storedId = rawInstallationId || fields.storedId;
    const github = requireGithubApp();
    const proxyUrl = process.env.ADAPTER_PROXY_URL ?? "";
    const userToken = await exchangeUserCode(github, code, {
      proxyUrl,
      ...(fields.redirectUri ? { redirectUri: fields.redirectUri } : {}),
    });
    let choice;
    try {
      choice = await resolveGithubInstallation(github, userToken, storedId, { proxyUrl });
    } catch (error) {
      if (error instanceof GithubError) {
        throw new OAuthError(error.message);
      }
      throw error;
    }
    if (choice.action === "use") {
      await applyGithubInstallation(row, choice.installation);
      return { status: "connected" };
    }
    if (choice.action === "install") {
      // The install page's own authorization hop returns to the App's first callback URL with no
      // `redirect_uri`, so its code is traded without one.
      const { redirect_uri: _redirect, ...oauth } =
        fields.pending.oauth && typeof fields.pending.oauth === "object" && !Array.isArray(fields.pending.oauth)
          ? (fields.pending.oauth as Record<string, unknown>)
          : {};
      const [ciphertext, nonce] = encrypt({ ...fields.pending, oauth });
      await saveMcpConnection(db,
        String(row.id),
        {
          ciphertext,
          nonce,
          status: "pending",
          accountHint: "",
          oauthState: String(row.oauth_state ?? ""),
        },
        new Date(),
      );
      return { status: "install" };
    }
    const pickerState = newState();
    const [ciphertext, nonce] = encrypt({
      ...fields.pending,
      github_user_token: userToken,
      oauth: {
        ...(fields.pending.oauth && typeof fields.pending.oauth === "object" && !Array.isArray(fields.pending.oauth)
          ? fields.pending.oauth
          : {}),
        replaces: pendingReplaces(fields.pending),
      },
    });
    await saveMcpConnection(db,
      String(row.id),
      { ciphertext, nonce, status: "pending", accountHint: "", oauthState: pickerState },
      new Date(),
    );
    return { status: "pick", state: pickerState };
  }

  async function pendingGithubRow(
    state: string | undefined,
    request: FastifyRequest,
    githubCallback: boolean,
  ): Promise<Record<string, unknown> | null> {
    if (state) {
      const row = await getMcpConnectionByOauthState(db, state);
      if (row !== null) {
        return row;
      }
    }
    if (!githubCallback) {
      return null;
    }
    try {
      const user = await currentUser(identityDb, request, deps);
      return await getPendingGithubConnectionForUser(db, String(user.id), GITHUB_SERVER_ID);
    } catch {
      return null;
    }
  }

  async function githubPickerSession(state: string | undefined): Promise<{
    row: Record<string, unknown>;
    payload: Record<string, unknown>;
    userToken: string;
  } | null> {
    if (!state) {
      return null;
    }
    const row = await getMcpConnectionByOauthState(db, state);
    if (row === null || row.status !== "pending") {
      return null;
    }
    const server = await getMcpServer(db, String(row.mcp_server_id));
    if (server === null || server.slug !== GITHUB_SLUG) {
      return null;
    }
    let payload: Record<string, unknown>;
    try {
      payload = decrypt(row.ciphertext, row.nonce);
    } catch {
      return null;
    }
    const token = payload.github_user_token;
    if (typeof token !== "string" || !token) {
      return null;
    }
    return { row, payload, userToken: token };
  }

  app.post("/api/mcp/connections", async (request, reply) => {
    const user = await currentUser(identityDb, request, deps);
    const missing = missingBodyFields(request.body, ["mcp_server_id", "owner_scope"]);
    if (missing) {
      throw missing;
    }
    const body = bodyOf(request);
    let ownerScope: OwnerScope;
    let ownerId: string | null;
    try {
      [ownerScope, ownerId] = validateOwner(String(body.owner_scope ?? ""), body.owner_id as string | null);
    } catch (error) {
      if (error instanceof CredentialError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    await assertOwner(ownerScope, ownerId, user);
    const server = await getMcpServer(db, String(body.mcp_server_id ?? ""));
    if (server === null || !serverVisible(server, await ownerOrgId(ownerScope, ownerId))) {
      throw new HttpError(404, "mcp server not found");
    }
    if (server.enabled === false) {
      throw new HttpError(422, "connector is disabled");
    }
    const now = new Date();
    if (server.auth === "token") {
      const settings = body.settings;
      if (settings !== undefined && (typeof settings !== "object" || settings === null || Array.isArray(settings))) {
        throw new HttpError(422, "settings must be an object");
      }
      let connected: Record<string, unknown>;
      try {
        ({ connection: connected } = await connect(
          connectDatabase(db),
          deps.mcp ?? null,
          {
            server,
            ownerScope,
            ownerId,
            credentials: body,
            ...(settings ? { settings: settings as Record<string, unknown> } : {}),
          },
          now,
          { masterKey: deps.masterKey },
        ));
      } catch (error) {
        if (error instanceof ConnectError) {
          throw new HttpError(error.status, error.message);
        }
        throw error;
      }
      await fillFromEndpoint(connected, server);
      return send(reply, 201, connectionMetadata(connected));
    }
    const existing = await getMcpConnectionForOwner(db, String(server.id), ownerScope, ownerId);
    if (existing !== null && existing.status === "connected") {
      throw new HttpError(409, "already connected; disconnect first");
    }
    const replaces = existing !== null;
    let oauthState: string | null = null;
    let authorize: string | undefined;
    let bind = true;
    let ciphertext: Buffer;
    let nonce: Buffer;
    if (isGithubApp(server)) {
      if (ownerScope !== "org" && ownerScope !== "guild" && ownerScope !== "agent") {
        throw new HttpError(422, "GitHub connects at the organisation, a guild, or an agent");
      }
      const github = githubAppConfig();
      if (github === null) {
        throw new HttpError(422, { message: "the GitHub App is not configured", setup_state: "unsupported" });
      }
      oauthState = newState();
      const redirect = oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);
      // User authorization first: the callback then uses an installation the user already
      // reaches, or sends them on to install the App. GitHub sends nobody back from editing an
      // existing installation, so Connect never starts on the install page.
      [ciphertext, nonce] = encrypt(pendingOauthPayload("", redirect, replaces));
      authorize = userAuthorizationUrl(github, oauthState, redirect);
      bind = false;
      appendSetCookie(reply, githubOauthStateCookie(oauthState, githubOauthCookieSecure()));
    } else if (startsBrowserOauth(server)) {
      const redirect = oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);
      try {
        const [discovery, client] = await ensureClient(oauthDatabase(db), server, redirect);
        const [verifier, challenge] = pkcePair();
        oauthState = newState();
        [ciphertext, nonce] = encrypt(pendingOauthPayload(verifier, redirect, replaces));
        authorize = authorizationUrl(discovery, {
          clientId: String(client.client_id),
          redirectUri: redirect,
          codeChallenge: challenge,
          state: oauthState,
        });
        bind = false;
      } catch (error) {
        if (error instanceof OAuthUnsupportedError) {
          throw new HttpError(422, { message: error.message, setup_state: "unsupported" });
        }
        if (error instanceof OAuthError) {
          throw new HttpError(502, error.message);
        }
        throw error;
      }
    } else {
      [ciphertext, nonce] = encrypt({});
    }
    const row = await connectMcp(db,
      {
        connectionId: newId("conn"),
        bindingId: newId("bind"),
        serverId: String(server.id),
        ownerScope,
        ownerId,
        ciphertext,
        nonce,
        oauthState,
        bind,
        status: "pending",
        accountHint: "",
      },
      now,
    );
    const payload: Record<string, unknown> = connectionMetadata(row);
    if (authorize !== undefined) {
      payload.authorization_url = authorize;
      // Where the consent step sends the operator, shown before they go.
      payload.authorization_host = new URL(authorize).host;
    }
    await send(reply, 201, payload);
  });

  app.get("/api/mcp/oauth/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
      installation_id?: string;
      setup_action?: string;
    };
    const code = query.code;
    const state = query.state || requestCookies(request)[GITHUB_OAUTH_STATE_COOKIE] || undefined;
    const error = query.error;
    const errorDescription = query.error_description;
    const installationId = query.installation_id;
    const setupAction = query.setup_action;
    if (error) {
      await abandonOauthAttempt(state);
      return sendHtml(reply, 400, {
        success: false,
        title: "Authorization Cancelled",
        message: errorDescription || error || "The authorization request was cancelled or incomplete.",
      });
    }
    if (setupAction === "request") {
      await abandonOauthAttempt(state);
      return sendHtml(reply, 400, {
        success: false,
        title: "Approval Required",
        message:
          "An organisation admin needs to approve the GitHub App. Connect again after they approve.",
      });
    }
    const githubCallback = Boolean(
      installationId || setupAction === "install" || setupAction === "update" || (code && !query.state),
    );
    const row = await pendingGithubRow(state, request, githubCallback);
    if (row === null) {
      if (code && !query.state && !requestCookies(request)[GITHUB_OAUTH_STATE_COOKIE]) {
        return sendHtml(reply, 404, {
          success: false,
          title: "Session Expired",
          message:
            "This GitHub authorization could not be matched to a pending connection. Please try connecting again.",
        });
      }
      if (!code || !state) {
        await abandonOauthAttempt(state);
        return sendHtml(reply, 400, {
          success: false,
          title: "Authorization Cancelled",
          message: errorDescription || error || "The authorization request was cancelled or incomplete.",
        });
      }
      return sendHtml(reply, 404, {
        success: false,
        title: "Session Expired",
        message: "This authorization request has expired or was already completed. Please try connecting again.",
      });
    }
    const server = await getMcpServer(db, String(row.mcp_server_id));
    if (server === null) {
      await discardAttempt(row);
      return sendHtml(reply, 404, {
        success: false,
        title: "Server Not Found",
        message: "The requested tool service could not be found.",
      });
    }
    if (isGithubApp(server)) {
      appendSetCookie(reply, clearGithubOauthStateCookie(githubOauthCookieSecure()));
      if (!code) {
        const parsedId = Number(installationId);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          await discardAttempt(row);
          return sendHtml(reply, 400, {
            success: false,
            title: "Authorization Failed",
            message: "Could not complete the GitHub installation: the callback has no installation",
          });
        }
        try {
          const pending = decrypt(row.ciphertext, row.nonce);
          const redirectUri = oauthCallbackUrl(deps.config?.publicBaseUrl ?? "", request);
          const oauthState = String(row.oauth_state ?? state ?? "");
          const [ciphertext, nonce] = encrypt({
            ...pending,
            installation_id: parsedId,
            oauth: {
              ...(pending.oauth && typeof pending.oauth === "object" && !Array.isArray(pending.oauth)
                ? pending.oauth
                : {}),
              redirect_uri: redirectUri,
              replaces: pendingReplaces(pending),
            },
          });
          await saveMcpConnection(db,
            String(row.id),
            { ciphertext, nonce, status: "pending", accountHint: "", oauthState },
            new Date(),
          );
          return reply.redirect(userAuthorizationUrl(requireGithubApp(), oauthState, redirectUri));
        } catch (caught) {
          await discardAttempt(row);
          const message = caught instanceof Error ? caught.message : String(caught);
          return sendHtml(reply, 400, {
            success: false,
            title: "Authorization Failed",
            message: `Could not complete the GitHub installation: ${message}`,
          });
        }
      }
      try {
        const result = await completeGithubAuth(row, code, installationId);
        if (result.status === "install") {
          return reply.redirect(installUrl(requireGithubApp(), String(row.oauth_state ?? state ?? "")));
        }
        if (result.status === "pick") {
          return reply.redirect(`/api/mcp/oauth/github-installation?state=${encodeURIComponent(result.state)}`);
        }
      } catch (caught) {
        await discardAttempt(row);
        const message = caught instanceof Error ? caught.message : String(caught);
        return sendHtml(reply, 400, {
          success: false,
          title: "Authorization Failed",
          message: `Could not complete the GitHub installation: ${message}`,
        });
      }
      return sendHtml(reply, 200, {
        success: true,
        title: "Connected to GitHub!",
        message:
          "The GitHub App is installed on the account you chose. Each guild picks its own repositories in Settings. You can close this window now.",
      });
    }
    if (!code || !state) {
      await discardAttempt(row);
      return sendHtml(reply, 400, {
        success: false,
        title: "Authorization Cancelled",
        message: errorDescription || error || "The authorization request was cancelled or incomplete.",
      });
    }
    try {
      const pending = decrypt(row.ciphertext, row.nonce);
      const [verifier, redirectUri] = pendingOauth(pending);
      const [discovery, client] = await ensureClient(oauthDatabase(db), server, redirectUri);
      const tokens = await exchangeCode(discovery, {
        code,
        codeVerifier: verifier,
        clientId: String(client.client_id),
        clientSecret: typeof client.client_secret === "string" ? client.client_secret : null,
        redirectUri,
      });
      const now = new Date();
      const stored = tokenPayload(tokens, { now });
      const schema = installedConnectors().forServer(server)?.manifest.settings_schema;
      if (!settingsComplete(schema, row.settings)) {
        await awaitSettings(row, stored, now);
        return sendHtml(reply, 200, {
          success: true,
          title: `Signed in to ${String(server.display_name || server.slug)}`,
          message: "Finish its setup in guilds.run: the login connects once its settings are saved. You can close this window now.",
        });
      }
      await finishOauthConnection(row, server, stored, now);
    } catch (caught) {
      await discardAttempt(row);
      const message = caught instanceof Error ? caught.message : String(caught);
      return sendHtml(reply, 400, {
        success: false,
        title: "Authorization Failed",
        message: `Could not complete authorization: ${message}`,
      });
    }
    const serverSlug = String(server.slug ?? "service");
    const serverTitle = String(server.display_name || serverSlug.charAt(0).toUpperCase() + serverSlug.slice(1));
    return sendHtml(reply, 200, {
      success: true,
      title: `Connected to ${serverTitle}!`,
      message: `Your ${serverTitle} account has been connected successfully. You can close this window now and return to guilds.run.`,
    });
  });

  app.get("/api/mcp/oauth/github-installation", async (request, reply) => {
    const session = await githubPickerSession(queryOf(request).state);
    if (session === null) {
      return sendHtml(reply, 404, {
        success: false,
        title: "Session Expired",
        message: "This authorization request has expired or was already completed. Please try connecting again.",
      });
    }
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header("content-type", "text/html; charset=utf-8")
      .send(githubInstallationPickerHtml());
  });

  app.get("/api/mcp/oauth/github-installations", async (request) => {
    const session = await githubPickerSession(queryOf(request).state);
    if (session === null) {
      throw new HttpError(404, "session expired");
    }
    try {
      const choice = await resolveGithubInstallation(requireGithubApp(), session.userToken, undefined, {
        proxyUrl: process.env.ADAPTER_PROXY_URL ?? "",
        retryDelayMs: 0,
      });
      const installations = choice.action === "pick" ? choice.installations : choice.action === "use" ? [choice.installation] : [];
      const oauthState = String(session.row.oauth_state ?? "");
      return {
        installations: installations.map((item) => ({ id: item.id, account: item.account })),
        install_url: installUrl(requireGithubApp(), oauthState),
      };
    } catch (caught) {
      const message = caught instanceof GithubError || caught instanceof Error ? caught.message : String(caught);
      throw new HttpError(400, message);
    }
  });

  app.post("/api/mcp/oauth/github-installation", async (request, reply) => {
    const body = bodyOf(request);
    const state = typeof body.state === "string" ? body.state : "";
    const session = await githubPickerSession(state);
    if (session === null) {
      throw new HttpError(404, "session expired");
    }
    try {
      const choice = await resolveGithubInstallation(
        requireGithubApp(),
        session.userToken,
        body.installation_id as string | number | undefined,
        { proxyUrl: process.env.ADAPTER_PROXY_URL ?? "" },
      );
      if (choice.action !== "use") {
        throw new OAuthError("pick one of the GitHub accounts this App is already installed on");
      }
      await applyGithubInstallation(session.row, choice.installation);
      return send(reply, 200, { ok: true, account: choice.installation.account });
    } catch (caught) {
      if (caught instanceof HttpError) {
        throw caught;
      }
      const message = caught instanceof GithubError || caught instanceof OAuthError || caught instanceof Error ? caught.message : String(caught);
      throw new HttpError(400, message);
    }
  });
}
