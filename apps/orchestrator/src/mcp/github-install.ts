// A GitHub App sign-in's installation: traded from the user's code, picked when the user
// reaches several, or installed when they reach none.
import { getMcpServer } from "../connectors/servers.js";
import {
  getMcpConnectionByOauthState,
  saveMcpConnection,
  type McpConnectionRow,
} from "../db/mcp.js";
import {
  exchangeUserCode,
  GITHUB_SLUG,
  GithubError,
  installUrl,
  requireGithubApp,
  resolveGithubInstallation,
  type GithubInstallation,
} from "../github/index.js";
import { ConnectionError } from "./visibility.js";
import { newState, OAuthError, pendingReplaces } from "../oauth/index.js";

import {
  bindToOwner,
  decrypt,
  encrypt,
  messageOf,
  oauthOf,
  type ConnectFlowServices,
  type Payload,
} from "./connect-flow.js";

/** A pending GitHub sign-in whose user has several installations to pick from. */
export type GithubPickerSession = { row: McpConnectionRow; userToken: string };

/** Keeps the installation a user chose: the login connects with its id, and its user token is discarded. */
async function applyGithubInstallation(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  installation: GithubInstallation,
): Promise<void> {
  const [ciphertext, nonce] = encrypt(services, {
    installation_id: installation.id,
    account: installation.account,
  });
  const login = {
    ciphertext,
    nonce,
    status: "connected" as const,
    accountHint: installation.account,
    oauthState: null,
  };
  const connected = await saveMcpConnection(services.db, row.id, login, new Date());
  if (connected === null) {
    throw new OAuthError("the pending connection was removed");
  }
  await bindToOwner(services.db, connected, new Date());
}

/** A pending GitHub sign-in's payload, with the installation it names and the redirect URI it was started with. */
function githubPendingFields(
  services: ConnectFlowServices,
  row: McpConnectionRow,
): { storedId: string | undefined; redirectUri: string | undefined; pending: Payload } {
  let pending: Payload;
  try {
    pending = decrypt(services, row);
  } catch {
    return { storedId: undefined, redirectUri: undefined, pending: {} };
  }
  const installation = pending.installation_id;
  const uri = oauthOf(pending).redirect_uri;
  return {
    storedId:
      installation === undefined || installation === null ? undefined : String(installation),
    redirectUri: typeof uri === "string" && uri ? uri : undefined,
    pending,
  };
}

/**
 * The GitHub App callback with a code: the code proves which user installed. The installation id
 * counts only when that user can reach it. With no id, one installation of this App is kept,
 * several open a picker, and none sends the operator to install.
 */
export async function completeGithubAuth(
  services: ConnectFlowServices,
  row: McpConnectionRow,
  code: string,
  installationId: string | undefined,
): Promise<{ status: "connected" } | { status: "install" } | { status: "pick"; state: string }> {
  const fields = githubPendingFields(services, row);
  const github = requireGithubApp();
  const proxyUrl = process.env.ADAPTER_PROXY_URL ?? "";
  const userToken = await exchangeUserCode(github, code, fields.redirectUri, { proxyUrl });
  let choice;
  try {
    choice = await resolveGithubInstallation(github, userToken, installationId || fields.storedId, {
      proxyUrl,
    });
  } catch (error) {
    throw error instanceof GithubError ? new OAuthError(error.message) : error;
  }
  if (choice.action === "use") {
    await applyGithubInstallation(services, row, choice.installation);
    return { status: "connected" };
  }
  if (choice.action === "install") {
    // The install page's own authorization hop returns to the App's first callback URL with no
    // `redirect_uri`, so its code is traded without one.
    const { redirect_uri: _redirect, ...oauth } = oauthOf(fields.pending);
    const [ciphertext, nonce] = encrypt(services, { ...fields.pending, oauth });
    const login = {
      ciphertext,
      nonce,
      status: "pending" as const,
      accountHint: "",
      oauthState: row.oauth_state ?? "",
    };
    await saveMcpConnection(services.db, row.id, login, new Date());
    return { status: "install" };
  }
  const pickerState = newState();
  const [ciphertext, nonce] = encrypt(services, {
    ...fields.pending,
    github_user_token: userToken,
    oauth: { ...oauthOf(fields.pending), replaces: pendingReplaces(fields.pending) },
  });
  const login = {
    ciphertext,
    nonce,
    status: "pending" as const,
    accountHint: "",
    oauthState: pickerState,
  };
  await saveMcpConnection(services.db, row.id, login, new Date());
  return { status: "pick", state: pickerState };
}

/** A pending GitHub sign-in waiting for its user to pick an installation; null for a state that names none. */
export async function loadGithubPickerSession(
  services: ConnectFlowServices,
  state: string | undefined,
): Promise<GithubPickerSession | null> {
  const row = state ? await getMcpConnectionByOauthState(services.db, state) : null;
  if (row === null || row.status !== "pending") {
    return null;
  }
  const server = await getMcpServer(services.db, row.mcp_server_id);
  if (server === null || server.slug !== GITHUB_SLUG) {
    return null;
  }
  let payload: Payload;
  try {
    payload = decrypt(services, row);
  } catch {
    return null;
  }
  const token = payload.github_user_token;
  return typeof token === "string" && token ? { row, userToken: token } : null;
}

async function requirePickerSession(services: ConnectFlowServices, state: string | undefined) {
  const session = await loadGithubPickerSession(services, state);
  if (session === null) {
    throw new ConnectionError(404, "session expired");
  }
  return session;
}

/** The installations of the App a picking user reaches, each by id and account, and where to install it on another account. */
export type GithubInstallationPicker = {
  installations: Array<Pick<GithubInstallation, "id" | "account">>;
  install_url: string;
};

/** The installations of the App the picking user reaches, and where to install it on another account. */
export async function listGithubInstallations(
  services: ConnectFlowServices,
  state: string | undefined,
): Promise<GithubInstallationPicker> {
  const session = await requirePickerSession(services, state);
  try {
    const choice = await resolveGithubInstallation(
      requireGithubApp(),
      session.userToken,
      undefined,
      {
        proxyUrl: process.env.ADAPTER_PROXY_URL ?? "",
        retryDelayMs: 0,
      },
    );
    const installations =
      choice.action === "pick"
        ? choice.installations
        : choice.action === "use"
          ? [choice.installation]
          : [];
    return {
      installations: installations.map((item) => ({ id: item.id, account: item.account })),
      install_url: installUrl(requireGithubApp(), session.row.oauth_state ?? ""),
    };
  } catch (caught) {
    throw new ConnectionError(400, messageOf(caught));
  }
}

/** Connects the pending GitHub sign-in with the installation its user picked, among those they reach. */
export async function chooseGithubInstallation(
  services: ConnectFlowServices,
  state: string | undefined,
  installationId: string | number | undefined,
): Promise<{ ok: true; account: string }> {
  const session = await requirePickerSession(services, state);
  try {
    const app = requireGithubApp();
    const choice = await resolveGithubInstallation(app, session.userToken, installationId, {
      proxyUrl: process.env.ADAPTER_PROXY_URL ?? "",
    });
    if (choice.action !== "use") {
      throw new OAuthError("pick one of the GitHub accounts this App is already installed on");
    }
    await applyGithubInstallation(services, session.row, choice.installation);
    return { ok: true, account: choice.installation.account };
  } catch (caught) {
    throw new ConnectionError(400, messageOf(caught));
  }
}
