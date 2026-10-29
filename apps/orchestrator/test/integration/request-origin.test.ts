import assert from "node:assert/strict";
import { after, test } from "node:test";
import WebSocket from "ws";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config/index.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_request_origin");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("with no sign-in, the server still refuses another host and another origin", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-origin-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const deps = { db, notes, scripts: agentScripts(db), schedules: new Schedules(scheduleDatabase(db)) };
  const local = await buildApp(database, deps);
  const proxied = await buildApp(database, {
    ...deps,
    config: { authMode: "compat-cookie", publicBaseUrl: "https://box.tailnet.test" } as AppConfig,
  });
  const create = (app: typeof local, headers: Record<string, string>, name: string) =>
    app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { "content-type": "application/json", ...headers },
      payload: { name },
    });

  try {
    // A hostname rebound to this server's address names itself in Host.
    const rebound = await local.inject({ method: "GET", url: "/api/guilds", headers: { host: "evil.example:8080" } });
    assert.equal(rebound.statusCode, 403);
    assert.match(rebound.json().detail, /host not allowed/);
    assert.equal((await local.inject({ method: "GET", url: "/", headers: { host: "evil.example" } })).statusCode, 403);
    assert.equal((await local.inject({ method: "GET", url: "/health", headers: { host: "10.0.0.7" } })).statusCode, 200);
    assert.equal((await local.inject({ method: "GET", url: "/api/guilds" })).statusCode, 200);

    // A cross-site page names itself in Origin; a client that is not a browser sends none.
    assert.equal((await create(local, { origin: "https://evil.example" }, "from-evil")).statusCode, 403);
    assert.equal((await create(local, { origin: "null" }, "from-sandboxed")).statusCode, 403);
    assert.equal((await create(local, {}, "from-script")).statusCode, 201);
    assert.equal((await create(local, { host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080" }, "same-origin")).statusCode, 201);
    assert.equal((await create(local, { host: "127.0.0.1:8080", origin: "http://localhost:5173" }, "dev-server")).statusCode, 201);
    const report = await local.inject({
      method: "POST",
      url: "/api/client-errors",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      payload: { message: "x" },
    });
    assert.equal(report.statusCode, 403, "the routes registered first are behind the check too");
    // A cross-site read carries no credential here to protect, and the browser keeps the answer.
    const read = await local.inject({ method: "GET", url: "/api/guilds", headers: { origin: "https://evil.example" } });
    assert.equal(read.statusCode, 200);
    assert.equal(read.headers["access-control-allow-origin"], undefined);

    // Behind the operator's proxy, the public host and origin are the box's own.
    const viaProxy = { host: "box.tailnet.test" };
    assert.equal((await proxied.inject({ method: "GET", url: "/api/guilds", headers: viaProxy })).statusCode, 200);
    assert.equal((await create(proxied, { ...viaProxy, origin: "https://box.tailnet.test" }, "via-proxy")).statusCode, 201);
    assert.equal((await create(proxied, { ...viaProxy, origin: "http://localhost:3000" }, "local-page")).statusCode, 403);
    assert.equal((await proxied.inject({ method: "GET", url: "/api/guilds", headers: { host: "other.tailnet.test" } })).statusCode, 403);

    // A WebSocket handshake is refused the same way, before any route sees it.
    await local.listen({ host: "127.0.0.1", port: 0 });
    const address = local.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const handshake = (origin: string | undefined) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/api/agents/a_missing/cli/tty/ws`,
          origin ? { origin } : {},
        );
        socket.on("unexpected-response", (_request, response) => {
          resolve(response.statusCode ?? 0);
          socket.terminate();
        });
        socket.on("open", () => {
          resolve(101);
          socket.terminate();
        });
        socket.on("error", () => resolve(-1));
      });
    assert.equal(await handshake("https://evil.example"), 403);
    assert.notEqual(await handshake(undefined), 403, "past the origin check, the route answers for itself");
  } finally {
    await local.close();
    await proxied.close();
    await database.close();
  }
});
