import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { getMcpServer } from "../../src/connectors/servers.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import { connect } from "../../src/seed/connect.js";
import { connectMcp, getMcpConnection, saveMcpConnection } from "../../src/db/mcp.js";
import { ConnectionError } from "../../src/mcp/visibility.js";
import { completeOAuthCallback, type OAuthCallback } from "../../src/mcp/connect-callback.js";
import type { ConnectFlowServices } from "../../src/mcp/connect-flow.js";
import { startConnection } from "../../src/mcp/connect-start.js";
import {
  chooseGithubInstallation,
  listGithubInstallations,
  loadGithubPickerSession,
} from "../../src/mcp/github-install.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_connect_flow");
const JSON_HOME = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};
const NO_CALLBACK: OAuthCallback = {
  code: undefined,
  state: undefined,
  cookieState: undefined,
  error: undefined,
  errorDescription: undefined,
  installationId: undefined,
  setupAction: undefined,
};
const REQUEST = {
  redirectUri: "http://127.0.0.1:8080/api/mcp/oauth/callback",
  signedInUserId: async () => null,
};

after(async () => {
  await dropIsolatedDatabase(dbName);
});

function refusedWith(status: number, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ConnectionError, String(error));
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  };
}

function pageOf(outcome: Awaited<ReturnType<typeof completeOAuthCallback>>) {
  assert.ok("page" in outcome, JSON.stringify(outcome));
  return outcome.page;
}

test(
  "a login starts by the connector's auth and its callback ends what does not finish",
  { timeout: 60_000 },
  async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    const database = await connect(await createIsolatedDatabase(dbName));
    const notes = new NotesStore(tempDir("guilds-connect-flow-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    const db = database.pool;
    const masterKey = Buffer.from(HEX_MASTER_KEY, "hex");
    const app = await buildApp(database, {
      db,
      notes,
      scripts: agentScripts(db),
      schedules: agentSchedules(db),
      masterKey,
    });
    const services: ConnectFlowServices = { db, mcp: null, masterKey };
    const addServer = async (payload: object) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/orgs/org_home/mcp/servers",
        headers: JSON_HOME,
        payload,
      });
      assert.equal(response.statusCode, 201, response.body);
      return String(response.json().id);
    };
    const start = (serverId: string, ownerScope = "org", form: Record<string, unknown> = {}) =>
      startConnection(services, "user_operator", {
        serverId,
        ownerScope,
        ownerId: ownerScope === "platform" ? null : "org_home",
        form,
        redirectUri: REQUEST.redirectUri,
      });

    try {
      const openId = await addServer({
        slug: "open",
        url: "https://mcp.open.example/mcp",
        auth: "none",
      });
      const tokenId = await addServer({
        slug: "keyed",
        url: "https://mcp.keyed.example/mcp",
        auth: "token",
      });

      await assert.rejects(start(openId, "platform"), refusedWith(400, /platform/));
      await assert.rejects(start("srv_missing"), refusedWith(404, /server/));
      await assert.rejects(start(tokenId, "org", { settings: "x" }), refusedWith(422, /settings/));
      const opened = await start(openId);
      assert.equal(opened.githubState, null);
      assert.equal(opened.connection.status, "pending");
      assert.equal(
        opened.connection.authorization_url,
        undefined,
        "a login with no auth leaves for no consent page",
      );
      const openLogin = await getMcpConnection(db, String(opened.connection.id));
      assert.ok(openLogin);
      await saveMcpConnection(
        db,
        openLogin.id,
        {
          ciphertext: openLogin.ciphertext,
          nonce: openLogin.nonce,
          status: "connected",
          accountHint: "",
          oauthState: null,
        },
        new Date(),
      );
      await assert.rejects(start(openId), refusedWith(409, /already connected/));

      const github = await getMcpServer(db, "mcp_github");
      assert.ok(github, "core installs the GitHub connector");
      await assert.rejects(start(github.id), refusedWith(422, /GitHub App is not configured/));

      const cancelledPage = pageOf(
        await completeOAuthCallback(services, { ...NO_CALLBACK, error: "access_denied" }, REQUEST),
      );
      assert.deepEqual([cancelledPage.status, cancelledPage.message], [400, "access_denied"]);
      const approval = pageOf(
        await completeOAuthCallback(services, { ...NO_CALLBACK, setupAction: "request" }, REQUEST),
      );
      assert.equal(approval.title, "Approval Required");
      const unmatched = pageOf(
        await completeOAuthCallback(services, { ...NO_CALLBACK, code: "c" }, REQUEST),
      );
      assert.match(unmatched.message, /could not be matched/);
      const incomplete = pageOf(await completeOAuthCallback(services, NO_CALLBACK, REQUEST));
      assert.equal(incomplete.title, "Authorization Cancelled");
      const expired = pageOf(
        await completeOAuthCallback(
          services,
          { ...NO_CALLBACK, code: "c", state: "gone" },
          REQUEST,
        ),
      );
      assert.equal(expired.title, "Session Expired");

      const [ciphertext, nonce] = encryptPayload({}, masterKey);
      const pending = (connectionId: string, oauthState: string) =>
        connectMcp(
          db,
          {
            connectionId,
            bindingId: `bind_${connectionId}`,
            serverId: tokenId,
            ownerScope: "org",
            ownerId: "org_home",
            ciphertext,
            nonce,
            oauthState,
            bind: false,
          },
          new Date(),
        );
      await pending("conn_left", "state_left");
      const left = pageOf(
        await completeOAuthCallback(services, { ...NO_CALLBACK, state: "state_left" }, REQUEST),
      );
      assert.equal(left.title, "Authorization Cancelled");
      assert.equal(
        await getMcpConnection(db, "conn_left"),
        null,
        "a sign-in left before its code is discarded",
      );

      await pending("conn_broken", "state_broken");
      const broken = pageOf(
        await completeOAuthCallback(
          services,
          { ...NO_CALLBACK, code: "c", state: "state_broken" },
          REQUEST,
        ),
      );
      assert.equal(broken.title, "Authorization Failed");
      assert.match(broken.message, /oauth state/);
      assert.equal(await getMcpConnection(db, "conn_broken"), null);

      await pending("conn_errored", "state_errored");
      const errored = pageOf(
        await completeOAuthCallback(
          services,
          { ...NO_CALLBACK, error: "denied", cookieState: "state_errored" },
          REQUEST,
        ),
      );
      assert.equal(errored.status, 400);
      assert.equal(
        await getMcpConnection(db, "conn_errored"),
        null,
        "a cancelled sign-in is abandoned by its cookie state",
      );

      assert.equal(await loadGithubPickerSession(services, undefined), null);
      assert.equal(await loadGithubPickerSession(services, "state_missing"), null);
      await assert.rejects(
        listGithubInstallations(services, "state_missing"),
        refusedWith(404, /session expired/),
      );
      await assert.rejects(
        chooseGithubInstallation(services, "state_missing", 7),
        refusedWith(404, /session expired/),
      );
    } finally {
      await app.close();
      await database.close();
    }
  },
);
