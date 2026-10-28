// The provider's callback that completes a sign-in, or ends it when the operator cancelled.
import { installedConnectors } from "../connectors/index.js";
import type { LoadedConnector } from "../connectors/load.js";
import { getMcpServer } from "../connectors/servers.js";
import { settingsComplete } from "../connectors/settings.js";
import {
  getMcpConnectionByOauthState,
  getPendingGithubConnectionForUser,
  saveMcpConnection,
  type McpConnectionRow,
} from "../db/mcp.js";
import {
  GITHUB_SERVER_ID,
  installUrl,
  requireGithubApp,
  userAuthorizationUrl,
} from "../github/index.js";
import {
  accountHint,
  ensureClient,
  exchangeCode,
  isGithubApp,
  oauthDatabase,
  pendingOauth,
  pendingReplaces,
  tokenPayload,
} from "../oauth/index.js";

import {
  abandonAttempt,
  bindToOwner,
  decrypt,
  discardAttempt,
  encrypt,
  fillFromEndpoint,
  messageOf,
  oauthOf,
  type ConnectFlowServices,
  type Payload,
} from "./connect-flow.js";
import { completeGithubAuth } from "./github-install.js";

/** What the provider's callback carries back, and the state cookie a GitHub sign-in left. */
export type OAuthCallback = {
  code: string | undefined;
  state: string | undefined;
  cookieState: string | undefined;
  error: string | undefined;
  errorDescription: string | undefined;
  installationId: string | undefined;
  setupAction: string | undefined;
};

/** The page the callback shows the operator. */
export type CallbackPage = { status: number; success: boolean; title: string; message: string };

/** Where the callback leaves the browser: a page, or the next hop; and whether the GitHub state cookie is spent. */
export type CallbackOutcome =
  | { page: CallbackPage; clearsGithubCookie: boolean }
  | { redirect: string; clearsGithubCookie: boolean };

/** What the browser coming back is known by: the URL the provider returns to, and its signed-in user when it has one. */
export type CallbackRequest = { redirectUri: string; signedInUserId: () => Promise<string | null> };

const EXPIRED: CallbackPage = {
  status: 404,
  success: false,
  title: "Session Expired",
  message:
    "This authorization request has expired or was already completed. Please try connecting again.",
};

function cancelled(callback: OAuthCallback): CallbackPage {
  return {
    status: 400,
    success: false,
    title: "Authorization Cancelled",
    message:
      callback.errorDescription ||
      callback.error ||
      "The authorization request was cancelled or incomplete.",
  };
}

function failed(message: string): CallbackPage {
  return { status: 400, success: false, title: "Authorization Failed", message };
}

/** Stores a signed-in login as connected, binds it, and lists its tools. */
async function finishOauthConnection(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  server: LoadedConnector,
  stored: Payload,
): Promise<void> {
  const now = new Date();
  const [ciphertext, nonce] = encrypt(services, stored);
  const login = {
    ciphertext,
    nonce,
    status: "connected" as const,
    accountHint: accountHint(stored),
    oauthState: null,
  };
  const connected = await saveMcpConnection(services.db, row.id, login, now);
  if (connected === null) {
    return;
  }
  await bindToOwner(services.db, connected, now);
  try {
    await services.mcp?.syncTools(connected, server, { force: true });
  } catch {
    // The login stands; its tools list on the next sync.
  }
  await fillFromEndpoint(services, connected, server);
}

/** Stores a signed-in login that still needs its settings: pending, bound, with no sign-in under way. */
async function awaitSettings(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  stored: Payload,
): Promise<void> {
  const now = new Date();
  const [ciphertext, nonce] = encrypt(services, stored);
  const login = {
    ciphertext,
    nonce,
    status: "pending" as const,
    accountHint: accountHint(stored),
    oauthState: null,
  };
  const saved = await saveMcpConnection(services.db, row.id, login, now);
  if (saved !== null) {
    await bindToOwner(services.db, saved, now);
  }
}

/**
 * Whether a callback comes from the GitHub App: it carries an installation or a setup action, or
 * a code with no state, as an installation's own authorization hop sends.
 */
function isGithubCallback(callback: OAuthCallback): boolean {
  const { installationId, setupAction, code } = callback;
  return Boolean(
    installationId ||
    setupAction === "install" ||
    setupAction === "update" ||
    (code && !callback.state),
  );
}

/**
 * The pending login a callback completes: the one its state names, or for a GitHub callback that
 * lost its state, the signed-in user's pending GitHub login.
 */
async function pendingRow(
  services: ConnectFlowServices,
  callback: OAuthCallback,
  state: string | undefined,
  request: CallbackRequest,
): Promise<McpConnectionRow | null> {
  const row = state ? await getMcpConnectionByOauthState(services.db, state) : null;
  if (row !== null || !isGithubCallback(callback)) {
    return row;
  }
  const userId = await request.signedInUserId();
  return userId === null
    ? null
    : getPendingGithubConnectionForUser(services.db, userId, GITHUB_SERVER_ID);
}

/** The page for a callback whose pending login is gone: expired, or a sign-in left before it finished. */
async function unmatchedCallback(
  services: ConnectFlowServices,
  callback: OAuthCallback,
  state: string | undefined,
): Promise<CallbackPage> {
  if (callback.code && !callback.state && !callback.cookieState) {
    return {
      ...EXPIRED,
      message:
        "This GitHub authorization could not be matched to a pending connection. Please try connecting again.",
    };
  }
  if (!callback.code || !state) {
    await abandonAttempt(services, state);
    return cancelled(callback);
  }
  return EXPIRED;
}

/**
 * GitHub coming back from an installation with no code: the login keeps the installation id and
 * the browser goes on to user authorization, which proves the user reaches it.
 */
async function continueAfterInstall(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  callback: OAuthCallback,
  redirectUri: string,
): Promise<CallbackOutcome> {
  const installationId = Number(callback.installationId);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    await discardAttempt(services, row);
    return {
      page: failed("Could not complete the GitHub installation: the callback has no installation"),
      clearsGithubCookie: true,
    };
  }
  try {
    const pending = decrypt(services, row);
    const oauthState = row.oauth_state ?? callback.state ?? "";
    const [ciphertext, nonce] = encrypt(services, {
      ...pending,
      installation_id: installationId,
      oauth: { ...oauthOf(pending), redirect_uri: redirectUri, replaces: pendingReplaces(pending) },
    });
    const login = { ciphertext, nonce, status: "pending" as const, accountHint: "", oauthState };
    await saveMcpConnection(services.db, row.id, login, new Date());
    return {
      redirect: userAuthorizationUrl(requireGithubApp(), oauthState, redirectUri),
      clearsGithubCookie: true,
    };
  } catch (caught) {
    await discardAttempt(services, row);
    return {
      page: failed(`Could not complete the GitHub installation: ${messageOf(caught)}`),
      clearsGithubCookie: true,
    };
  }
}

/** The GitHub App's callback: an installation to authorize, or a user code to trade for an installation. */
async function completeGithubCallback(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  callback: OAuthCallback,
  redirectUri: string,
): Promise<CallbackOutcome> {
  if (!callback.code) {
    return continueAfterInstall(services, row, callback, redirectUri);
  }
  let result;
  try {
    result = await completeGithubAuth(services, row, callback.code, callback.installationId);
  } catch (caught) {
    await discardAttempt(services, row);
    return {
      page: failed(`Could not complete the GitHub installation: ${messageOf(caught)}`),
      clearsGithubCookie: true,
    };
  }
  if (result.status === "install") {
    return {
      redirect: installUrl(requireGithubApp(), row.oauth_state ?? callback.state ?? ""),
      clearsGithubCookie: true,
    };
  }
  if (result.status === "pick") {
    return {
      redirect: `/api/mcp/oauth/github-installation?state=${encodeURIComponent(result.state)}`,
      clearsGithubCookie: true,
    };
  }
  const message =
    "The GitHub App is installed on the account you chose. Each guild picks its own repositories in Settings. You can close this window now.";
  return {
    page: { status: 200, success: true, title: "Connected to GitHub!", message },
    clearsGithubCookie: true,
  };
}

/** A browser OAuth callback: the code is traded for tokens, and the login connects or waits for its settings. */
async function completeBrowserCallback(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  server: LoadedConnector,
  callback: OAuthCallback,
): Promise<CallbackPage> {
  const { code, state } = callback;
  if (!code || !state) {
    await discardAttempt(services, row);
    return cancelled(callback);
  }
  try {
    const [verifier, redirectUri] = pendingOauth(decrypt(services, row));
    const [discovery, client] = await ensureClient(oauthDatabase(services.db), server, redirectUri);
    const tokens = await exchangeCode(discovery, {
      code,
      codeVerifier: verifier,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      redirectUri,
    });
    const stored = tokenPayload(tokens, { now: new Date() });
    const schema = installedConnectors().forServer(server)?.manifest.settings_schema;
    if (!settingsComplete(schema, row.settings)) {
      await awaitSettings(services, row, stored);
      return {
        status: 200,
        success: true,
        title: `Signed in to ${server.display_name || server.slug}`,
        message:
          "Finish its setup in guilds.run: the login connects once its settings are saved. You can close this window now.",
      };
    }
    await finishOauthConnection(services, row, server, stored);
  } catch (caught) {
    await discardAttempt(services, row);
    return failed(`Could not complete authorization: ${messageOf(caught)}`);
  }
  const slug = server.slug || "service";
  const title = server.display_name || slug.charAt(0).toUpperCase() + slug.slice(1);
  return {
    status: 200,
    success: true,
    title: `Connected to ${title}!`,
    message: `Your ${title} account has been connected successfully. You can close this window now and return to guilds.run.`,
  };
}

/** Completes the sign-in the provider's callback names, or ends it when the operator cancelled. */
export async function completeOAuthCallback(
  services: ConnectFlowServices,
  callback: OAuthCallback,
  request: CallbackRequest,
): Promise<CallbackOutcome> {
  const state = callback.state || callback.cookieState || undefined;
  if (callback.error) {
    await abandonAttempt(services, state);
    return { page: cancelled(callback), clearsGithubCookie: false };
  }
  if (callback.setupAction === "request") {
    await abandonAttempt(services, state);
    const message =
      "An organisation admin needs to approve the GitHub App. Connect again after they approve.";
    return {
      page: { status: 400, success: false, title: "Approval Required", message },
      clearsGithubCookie: false,
    };
  }
  const row = await pendingRow(services, callback, state, request);
  if (row === null) {
    return { page: await unmatchedCallback(services, callback, state), clearsGithubCookie: false };
  }
  const server = await getMcpServer(services.db, row.mcp_server_id);
  if (server === null) {
    await discardAttempt(services, row);
    const page = {
      status: 404,
      success: false,
      title: "Server Not Found",
      message: "The requested tool service could not be found.",
    };
    return { page, clearsGithubCookie: false };
  }
  if (isGithubApp(server)) {
    return completeGithubCallback(services, row, { ...callback, state }, request.redirectUri);
  }
  return {
    page: await completeBrowserCallback(services, row, server, { ...callback, state }),
    clearsGithubCookie: false,
  };
}
