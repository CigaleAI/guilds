// Starting an operator's connector login: a token login connects at once; an OAuth or GitHub
// App login is stored pending and leaves for the provider's consent page.
import { connect, connectDatabase } from "../connectors/connect.js";
import type { LoadedConnector } from "../connectors/load.js";
import { getMcpServer } from "../connectors/servers.js";
import { connectionMetadata } from "../credentials/items.js";
import { validateOwner, type OwnerScope } from "../credentials/validate.js";
import { isPlainRecord } from "../db/json.js";
import { connectMcp, getMcpConnectionForOwner } from "../db/mcp.js";
import { githubAppConfig, userAuthorizationUrl } from "../github/index.js";
import { newId } from "../lib/ids.js";
import { assertActsFor, ConnectionError, ownerOrgId, serverVisible } from "../mcp/visibility.js";
import {
  authorizationUrl,
  ensureClient,
  isGithubApp,
  newState,
  oauthDatabase,
  OAuthError,
  OAuthUnsupportedError,
  pendingOauthPayload,
  pkcePair,
  startsBrowserOauth,
} from "./index.js";

import {
  encrypt,
  fillFromEndpoint,
  type ConnectFlowServices,
  type Payload,
} from "./connect-flow.js";

/**
 * A login as an operator asks for it: the connector, the owner, the form's values (a token
 * login's credentials and settings), and where the provider sends the browser back to.
 */
export type ConnectionStart = {
  serverId: string;
  ownerScope: string;
  ownerId: unknown;
  form: Record<string, unknown>;
  redirectUri: string;
};

/** Who a login belongs to: the platform, an organisation, a guild, or an agent. */
export type ConnectionOwner = { ownerScope: OwnerScope; ownerId: string | null };

/** A started login: what the page shows, and the state a GitHub App sign-in keeps in a cookie. */
export type StartedConnection = { connection: Record<string, unknown>; githubState: string | null };

/** The connector a login is asked for, which the owner's organisation sees and which is switched on. */
async function requireConnectable(
  services: ConnectFlowServices,
  start: ConnectionStart,
  ownerId: string | null,
) {
  const server = await getMcpServer(services.db, start.serverId);
  const orgId = await ownerOrgId(services.db, start.ownerScope, ownerId);
  if (server === null || !serverVisible(server, orgId)) {
    throw new ConnectionError(404, "mcp server not found");
  }
  if (server.enabled === false) {
    throw new ConnectionError(422, "connector is disabled");
  }
  return server;
}

/** Connects a token login at once with the form's credentials and settings. */
async function connectWithToken(
  services: ConnectFlowServices,
  server: LoadedConnector,
  owner: ConnectionOwner,
  form: Payload,
): Promise<StartedConnection> {
  const settings = form.settings;
  if (settings !== undefined && !isPlainRecord(settings)) {
    throw new ConnectionError(422, "settings must be an object");
  }
  const input = { server, ...owner, credentials: form, ...(settings ? { settings } : {}) };
  const { connection } = await connect(
    connectDatabase(services.db),
    services.mcp,
    input,
    new Date(),
    {
      masterKey: services.masterKey,
    },
  );
  await fillFromEndpoint(services, connection, server);
  return { connection: connectionMetadata(connection), githubState: null };
}

/** A sign-in's first hop: the provider's consent page, the state it returns with, and the payload kept until then. */
type SignIn = {
  authorize: string | undefined;
  oauthState: string | null;
  payload: Payload;
  bind: boolean;
};

/** A GitHub App sign-in starts with user authorization; the callback then picks or installs. */
function githubSignIn(ownerScope: string, redirectUri: string, replaces: boolean): SignIn {
  if (ownerScope !== "org" && ownerScope !== "guild" && ownerScope !== "agent") {
    throw new ConnectionError(422, "GitHub connects at the organisation, a guild, or an agent");
  }
  const github = githubAppConfig();
  if (github === null) {
    throw new ConnectionError(422, {
      message: "the GitHub App is not configured",
      setup_state: "unsupported",
    });
  }
  const oauthState = newState();
  // GitHub sends nobody back from editing an existing installation, so Connect never starts on
  // the install page.
  return {
    authorize: userAuthorizationUrl(github, oauthState, redirectUri),
    oauthState,
    payload: pendingOauthPayload("", redirectUri, replaces),
    bind: false,
  };
}

/** A browser OAuth sign-in: a registered client, a PKCE pair, and the provider's authorization URL. */
async function browserSignIn(
  services: ConnectFlowServices,
  server: LoadedConnector,
  redirectUri: string,
  replaces: boolean,
): Promise<SignIn> {
  try {
    const [discovery, client] = await ensureClient(oauthDatabase(services.db), server, redirectUri);
    const [verifier, challenge] = pkcePair();
    const oauthState = newState();
    const authorize = authorizationUrl(discovery, {
      clientId: client.client_id,
      redirectUri,
      codeChallenge: challenge,
      state: oauthState,
    });
    return {
      authorize,
      oauthState,
      payload: pendingOauthPayload(verifier, redirectUri, replaces),
      bind: false,
    };
  } catch (error) {
    if (error instanceof OAuthUnsupportedError) {
      throw new ConnectionError(422, { message: error.message, setup_state: "unsupported" });
    }
    throw error instanceof OAuthError ? new ConnectionError(502, error.message) : error;
  }
}

/**
 * Starts a login for an owner the user acts for. A token login connects at once; an OAuth or
 * GitHub App login is stored pending and answers the provider's authorization URL; a login with
 * no auth is stored pending and bound.
 */
export async function startConnection(
  services: ConnectFlowServices,
  userId: string,
  start: ConnectionStart,
): Promise<StartedConnection> {
  const { db } = services;
  const [ownerScope, ownerId] = validateOwner(
    start.ownerScope,
    typeof start.ownerId === "string" ? start.ownerId : null,
  );
  await assertActsFor(db, ownerScope, ownerId, userId);
  const server = await requireConnectable(services, start, ownerId);
  if (server.auth === "token") {
    return connectWithToken(services, server, { ownerScope, ownerId }, start.form);
  }
  const existing = await getMcpConnectionForOwner(db, server.id, ownerScope, ownerId);
  if (existing !== null && existing.status === "connected") {
    throw new ConnectionError(409, "already connected; disconnect first");
  }
  const replaces = existing !== null;
  const github = isGithubApp(server);
  const signIn: SignIn = github
    ? githubSignIn(ownerScope, start.redirectUri, replaces)
    : startsBrowserOauth(server)
      ? await browserSignIn(services, server, start.redirectUri, replaces)
      : { authorize: undefined, oauthState: null, payload: {}, bind: true };
  const [ciphertext, nonce] = encrypt(services, signIn.payload);
  const row = await connectMcp(
    db,
    {
      connectionId: newId("conn"),
      bindingId: newId("bind"),
      serverId: server.id,
      ownerScope,
      ownerId,
      ciphertext,
      nonce,
      oauthState: signIn.oauthState,
      bind: signIn.bind,
      status: "pending",
      accountHint: "",
    },
    new Date(),
  );
  const connection: Payload = connectionMetadata(row);
  if (signIn.authorize !== undefined) {
    connection.authorization_url = signIn.authorize;
    // Where the consent step sends the operator, shown before they go.
    connection.authorization_host = new URL(signIn.authorize).host;
  }
  return { connection, githubState: github ? signIn.oauthState : null };
}
