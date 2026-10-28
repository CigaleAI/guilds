import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMasterKey } from "../../src/config/index.js";
import { decryptPayload } from "../../src/credentials/crypto.js";
import { CONNECTORS } from "../../src/connectors/index.js";
import { ConnectorError } from "../../src/connectors/types.js";
import type { McpConnectionRow, NewMcpConnection } from "../../src/db/mcp.js";
import { connect, ConnectError, type ConnectInput, type ConnectPool } from "../../src/mcp/connect-token.js";
import { McpPool } from "../../src/mcp/pool.js";
import type { LoginFailure } from "../../src/mcp/service.js";
import { HEX_MASTER_KEY } from "../helpers/env.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";
import { WITH_QUOTES } from "../helpers/quotes.js";
import { serverRow } from "../helpers/servers.js";

const KEY = decodeMasterKey(HEX_MASTER_KEY);

/** The logins `connect` stores, and the pool's database its listing writes to. */
class ConnectRepoStub extends MemoryMcpDatabase {
  rows = new Map<string, McpConnectionRow>();
  retired: Array<[string, LoginFailure]> = [];

  async getMcpConnectionForOwner(serverId: string, ownerScope: string, ownerId: string | null) {
    return this.rows.get(`${serverId}:${ownerScope}:${ownerId}`) ?? null;
  }

  async connectMcp(input: NewMcpConnection, now: Date): Promise<McpConnectionRow> {
    const stamp = now.toISOString();
    const row: McpConnectionRow = {
      id: input.connectionId,
      mcp_server_id: input.serverId,
      owner_scope: input.ownerScope,
      owner_id: input.ownerId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      status: input.status ?? "pending",
      account_hint: input.accountHint ?? "",
      oauth_state: input.oauthState ?? null,
      settings: input.settings ?? {},
      created_at: stamp,
      updated_at: stamp,
      rotated_at: stamp,
    };
    this.rows.set(`${input.serverId}:${input.ownerScope}:${input.ownerId}`, row);
    return row;
  }

  async retireLogin(_pool: ConnectPool, connection: McpConnectionRow, failure: LoginFailure): Promise<void> {
    this.retired.push([connection.id, failure]);
  }
}

const QONTO = serverRow("qonto", { display_name: "Qonto" });
const X_SERVER = serverRow("x", { display_name: "X" });

test("connect stores a two-field login under the manifest's names with the validated hint", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool(repo);
  pool.connectors = CONNECTORS.withAdapter("qonto", { validate: async () => "Elektro" });
  const { connection, outcome } = await connect(
    repo as never,
    pool,
    { server: QONTO, ownerScope: "org", ownerId: "org_1", credentials: { login: " org ", secret_key: "s3", extra: "x" } },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(outcome, "installed");
  assert.equal(connection.account_hint, "Elektro");
  assert.deepEqual(decryptPayload(connection.ciphertext, connection.nonce, KEY), {
    login: "org",
    secret_key: "s3",
  });
  assert.deepEqual(
    repo.tools.map((tool) => tool.remote_name),
    CONNECTORS.bySlug("qonto")!.manifest.tools!.map((tool) => tool.name),
  );
  await assert.rejects(
    () => connect(repo as never, pool, { server: QONTO, ownerScope: "org", ownerId: "org_2", credentials: { login: "org" } }),
    (error: unknown) => error instanceof ConnectError && error.status === 422 && error.message === "secret key is required",
  );
});

test("connect refuses, keeps, or replaces an owner's login as asked", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool(repo);
  pool.connectors = CONNECTORS.withAdapter("x", { validate: async () => "" });
  const owner = { server: X_SERVER, ownerScope: "org", ownerId: "org_1" } satisfies Partial<ConnectInput>;
  const first = await connect(repo as never, pool, { ...owner, credentials: { token: "one" }, accountHint: "plan" }, new Date(), { masterKey: KEY });
  assert.equal(first.outcome, "installed");
  await assert.rejects(
    () => connect(repo as never, pool, { ...owner, credentials: { token: "two" } }, new Date(), { masterKey: KEY }),
    (error: unknown) => error instanceof ConnectError && error.status === 409,
  );
  const kept = await connect(repo as never, pool, { ...owner, credentials: { token: "two" }, onExisting: "keep" }, new Date(), { masterKey: KEY });
  assert.equal(kept.outcome, "kept");
  const current = await connect(
    repo as never,
    pool,
    { ...owner, credentials: { token: "one" }, onExisting: { replace_when_hint: "plan" } },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(current.outcome, "current");
  const replaced = await connect(
    repo as never,
    pool,
    { ...owner, credentials: { token: "two" }, onExisting: { replace_when_hint: "plan" }, accountHint: "plan" },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(replaced.outcome, "installed");
  const other = await connect(
    repo as never,
    pool,
    { ...owner, credentials: { token: "three" }, onExisting: { replace_when_hint: "someone else" } },
    new Date(),
    { masterKey: KEY },
  );
  assert.equal(other.outcome, "kept");
});

test("connect answers a rejected key with a 422 and stores nothing", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool(repo);
  pool.connectors = CONNECTORS.withAdapter("x", {
    validate: async () => {
      throw new ConnectorError("Unauthorized", 401);
    },
  });
  await assert.rejects(
    () => connect(repo as never, pool, { server: X_SERVER, ownerScope: "org", ownerId: "org_1", credentials: { token: "bad" } }),
    (error: unknown) => error instanceof ConnectError && error.status === 422 && error.message === "api key was rejected",
  );
  assert.equal(repo.rows.size, 0);
});

test("connect retires a login its server refuses on the first listing: a new one never connected, a replacing one unauthorised", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool(repo);
  const refusing = CONNECTORS.withAdapter("x", {
    validate: async () => "",
    list: async () => {
      throw new ConnectorError("Unauthorized", 401);
    },
  });
  const owner = { server: X_SERVER, ownerScope: "org", ownerId: "org_1" } satisfies Partial<ConnectInput>;
  pool.connectors = refusing;
  await assert.rejects(
    () => connect(repo, pool, { ...owner, credentials: { token: "one" } }, new Date(), { masterKey: KEY }),
    (error: unknown) => error instanceof ConnectError && error.status === 422 && error.message === "api key was rejected",
  );
  const created = repo.rows.get(`${X_SERVER.id}:org:org_1`)!;
  assert.deepEqual(repo.retired, [[created.id, "never_connected"]]);
  pool.connectors = CONNECTORS.withAdapter("x", { validate: async () => "", list: async () => [] });
  await connect(repo, pool, { ...owner, credentials: { token: "two" }, onExisting: "replace" }, new Date(), { masterKey: KEY });
  pool.connectors = refusing;
  await assert.rejects(
    () => connect(repo, pool, { ...owner, credentials: { token: "three" }, onExisting: "replace" }, new Date(), { masterKey: KEY }),
    ConnectError,
  );
  const replaced = repo.rows.get(`${X_SERVER.id}:org:org_1`)!;
  assert.deepEqual(repo.retired.at(-1), [replaced.id, "unauthorised"]);
});

test("connect stores a login that lacks required settings as pending, and one with them as connected", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const repo = new ConnectRepoStub();
  const pool = new McpPool(repo);
  const seen: Array<Record<string, unknown>> = [];
  pool.connectors = WITH_QUOTES.withAdapter("quotes", {
    async validate(_creds, ctx) {
      seen.push({ ...ctx.settings });
      return "1 symbol";
    },
  });
  const server = serverRow("quotes", { id: "mcp_quotes", auth: "token", display_name: "Quotes" });
  const waiting = await connect(repo as never, pool, { server, ownerScope: "org", ownerId: "org_1", credentials: { token: "qk" } }, new Date(), { connectors: WITH_QUOTES });
  assert.equal(waiting.connection.status, "pending");
  assert.deepEqual(repo.tools, []);
  const ready = await connect(repo as never, pool, {
    server,
    ownerScope: "org",
    ownerId: "org_2",
    credentials: { token: "qk" },
    settings: { symbols: [{ id: "bitcoin" }] },
  }, new Date(), { connectors: WITH_QUOTES });
  assert.equal(ready.connection.status, "connected");
  assert.deepEqual(seen, [{}, { symbols: [{ id: "bitcoin" }] }]);
  await assert.rejects(
    () =>
      connect(repo as never, pool, {
        server,
        ownerScope: "org",
        ownerId: "org_3",
        credentials: { token: "qk" },
        settings: { symbols: "bitcoin" },
      }, new Date(), { connectors: WITH_QUOTES }),
    (error: unknown) => error instanceof ConnectError && error.status === 422,
  );
});
