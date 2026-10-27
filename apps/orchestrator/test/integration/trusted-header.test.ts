import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config/index.js";
import { connect } from "../../src/seed/connect.js";
import { setOperatorEmail } from "../../src/seed/operator.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_trusted_header");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("behind an authenticating proxy, a user is whoever holds the email it sends", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-trusted-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const deps = { db, notes, scripts: new Scripts(scriptDatabase(db)), schedules: new Schedules(scheduleDatabase(db)) };
  const config = {
    authMode: "trusted-header",
    publicBaseUrl: "https://box.tailnet.test",
    trustedProxySecret: "shared",
    trustedHeaderName: "X-Forwarded-Email",
    operatorEmail: "operator@example.com",
  } as AppConfig;
  const app = await buildApp(database, { ...deps, config });
  const open = await buildApp(database, deps);
  const as = (email: string | null, secret = "shared"): Record<string, string> => ({
    host: "box.tailnet.test",
    "content-type": "application/json",
    "x-guilds-proxy-secret": secret,
    ...(email === null ? {} : { "x-forwarded-email": email }),
  });
  const me = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/auth/me", headers });

  try {
    // A fresh box's only user has no email, so the proxy's header names nobody.
    assert.equal((await me(as("operator@example.com"))).statusCode, 401);

    await setOperatorEmail(database.pool, config.operatorEmail);
    await setOperatorEmail(database.pool, config.operatorEmail);
    const operator = await me(as("Operator@Example.com"));
    assert.equal(operator.statusCode, 200);
    assert.equal(operator.json().id, "user_operator");
    assert.equal(operator.json().email, "operator@example.com");
    assert.equal((await me(as("operator@example.com", "guessed"))).statusCode, 401);
    assert.equal((await me(as(null))).statusCode, 401);
    assert.equal((await me(as("stranger@example.com"))).statusCode, 401);

    // The operator, who administers the instance, gives another person an account by their email.
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: as("operator@example.com"),
      payload: { name: "ada", email: " Ada@Example.com " },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().email, "ada@example.com");
    const ada = created.json().id as string;
    assert.equal((await me(as("ada@example.com"))).json().id, ada);
    const directory = await app.inject({ method: "GET", url: "/api/users", headers: as("operator@example.com") });
    assert.deepEqual(
      directory.json().map((user: { name: string }) => user.name).sort(),
      ["ada", "operator"],
    );

    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/users", headers: as("operator@example.com"), payload });
    const taken = await post({ name: "ada-again", email: "ada@example.com" });
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().detail, "email already belongs to a user");
    assert.equal((await post({ name: "ada" })).json().detail, "user name already exists");
    assert.equal((await post({ name: "grace", email: "not an address" })).statusCode, 422);

    // The directory is the administrator's: anyone else gets no sign that it exists.
    for (const [method, url] of [
      ["GET", "/api/users"],
      ["POST", "/api/users"],
      ["PATCH", `/api/users/${ada}`],
      ["DELETE", `/api/users/${ada}`],
    ] as const) {
      const refused = await app.inject({ method, url, headers: as("ada@example.com"), payload: { name: "eve", email: null } });
      assert.equal(refused.statusCode, 404, `${method} ${url}`);
      assert.equal((await app.inject({ method, url, headers: as(null), payload: {} })).statusCode, 401, `${method} ${url}`);
    }

    // A changed email moves the person to the new address, and a cleared one identifies nobody.
    const patch = (userId: string, payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/users/${userId}`, headers: as("operator@example.com"), payload });
    const moved = await patch(ada, { email: "Ada@New.example" });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().email, "ada@new.example");
    assert.equal((await me(as("ada@example.com"))).statusCode, 401);
    assert.equal((await me(as("ada@new.example"))).json().id, ada);
    assert.equal((await patch(ada, { email: "operator@example.com" })).statusCode, 409);
    assert.equal((await patch(ada, { email: "nope" })).statusCode, 422);
    assert.equal((await patch(ada, {})).statusCode, 422);
    assert.equal((await patch("user_missing", { email: null })).statusCode, 404);
    assert.equal((await patch(ada, { email: null })).json().email, null);
    assert.equal((await me(as("ada@new.example"))).statusCode, 401);

    // The address in the box's settings cannot be one another user already holds.
    assert.equal((await patch(ada, { email: "ada@example.com" })).statusCode, 200);
    await assert.rejects(setOperatorEmail(database.pool, "ada@example.com"), /OPERATOR_EMAIL is another user's email/);
    assert.equal((await me(as("operator@example.com"))).json().id, "user_operator");

    // With no proxy the directory is open, and takes an email for a later move behind one.
    const local = await open.inject({
      method: "POST",
      url: "/api/users",
      headers: { "content-type": "application/json" },
      payload: { name: "grace", email: "grace@example.com" },
    });
    assert.equal(local.statusCode, 201);
    assert.equal((await me(as("grace@example.com"))).json().id, local.json().id);
    assert.equal((await open.inject({ method: "POST", url: "/api/users", headers: { "content-type": "application/json" }, payload: { name: "linus" } })).json().email, null);
  } finally {
    await app.close();
    await open.close();
    await database.close();
  }
});
