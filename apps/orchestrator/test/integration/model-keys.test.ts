import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { Repositories } from "../../src/db/repositories.js";
import { NotesStore } from "../../src/notes/store.js";
import { Scripts } from "../../src/scripts/catalog.js";
import { Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const MEMBER = { "X-Guilds-User": "user_member", "X-Guilds-Org": "org_home" };

const dbName = uniqueDbName("agent_platform_model_keys");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an organisation's model keys are listed by members and managed by owners", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-model-keys-"), templatesRoot(), "notes");
  await notes.ensureSystemPrompt();
  const repo = new Repositories(database.pool);
  const member = await repo.insertUser("user_member", "member", new Date(), null, "member@example.com");
  await repo.insertMember("org_home", String(member.id), "member", new Date());
  const app = await buildApp(database, {
    repo,
    notes,
    scripts: new Scripts(repo),
    schedules: new Schedules(repo, notes),
    masterKey: Buffer.from(HEX_MASTER_KEY, "hex"),
  });
  const url = "/api/orgs/org_home/model-providers";
  const put = (headers: Record<string, string>, provider: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `${url}/${provider}`,
      headers: { ...headers, "content-type": "application/json" },
      payload,
    });

  try {
    const empty = await app.inject({ method: "GET", url, headers: OWNER });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json(), []);

    const set = await put(OWNER, "openrouter", { api_key: "  sk-or-v1-secret-abcd  " });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().provider, "openrouter");
    assert.equal(set.json().key_hint, "abcd");
    assert.equal(set.body.includes("sk-or-v1-secret"), false);
    assert.equal(await repo.resolveOrgApiKey("org_home", "openrouter/openai/gpt-5.6-luna"), "sk-or-v1-secret-abcd");

    const listed = await app.inject({ method: "GET", url, headers: MEMBER });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().map((item: { provider: string; key_hint: string }) => [item.provider, item.key_hint]),
      [["openrouter", "abcd"]],
    );
    assert.equal(listed.body.includes("sk-or-v1-secret"), false);

    assert.equal((await put(MEMBER, "openrouter", { api_key: "sk-other" })).statusCode, 404);
    assert.equal((await put(OWNER, "openai", { api_key: "sk-x" })).statusCode, 422);
    assert.equal((await put(OWNER, "openrouter", { api_key: "   " })).statusCode, 422);
    assert.equal((await put(OWNER, "openrouter", {})).statusCode, 422);

    const outsider = await app.inject({ method: "GET", url: "/api/orgs/org_elsewhere/model-providers", headers: OWNER });
    assert.equal(outsider.statusCode, 404);

    const refused = await app.inject({ method: "DELETE", url: `${url}/openrouter`, headers: MEMBER });
    assert.equal(refused.statusCode, 404);
    const removed = await app.inject({ method: "DELETE", url: `${url}/openrouter`, headers: OWNER });
    assert.equal(removed.statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `${url}/openrouter`, headers: OWNER })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: "GET", url, headers: OWNER })).json(), []);
  } finally {
    await app.close();
    await database.close();
  }
});
