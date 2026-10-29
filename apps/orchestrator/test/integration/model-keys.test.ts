import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { coreModelCredentials, modelProviderStore } from "../../src/llm/credentials.js";
import { modelsService } from "../../src/llm/models.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MASTER_KEY } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember } from "../../src/db/orgs.js";

const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const MEMBER = { "X-Guilds-User": "user_member", "X-Guilds-Org": "org_home" };

const dbName = uniqueDbName("agent_platform_model_keys");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an organisation connects providers, chooses models, and names a default", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-model-keys-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  const member = await insertUser(db, { userId: "user_member", name: "member", image: null, email: "member@example.com" }, new Date());
  await insertMember(db, "org_home", String(member.id), "member", new Date());
  const probed: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    probed.push(`${String(url)} ${key}`);
    if (key.includes("rejected")) {
      return new Response("no", { status: 401 });
    }
    return new Response(JSON.stringify({ data: [{ id: "zai-org/GLM-5.3-Flash" }, { id: "k3" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const credentials = coreModelCredentials(modelProviderStore(db), TEST_MASTER_KEY);
  const app = await buildApp(database, {
    db,
    notes,
    scripts: new Scripts(scriptDatabase(db)),
    schedules: new Schedules(scheduleDatabase(db)),
    masterKey: TEST_MASTER_KEY,
    modelCredentials: credentials,
    models: modelsService(db, { credentials, fetch: fetchFn, masterKey: TEST_MASTER_KEY }),
  });
  const base = "/api/orgs/org_home";
  const put = (headers: Record<string, string>, path: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: `${base}${path}`,
      headers: { ...headers, "content-type": "application/json" },
      payload,
    });

  try {
    const empty = await app.inject({ method: "GET", url: `${base}/models`, headers: OWNER });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().default, null);
    assert.deepEqual(empty.json().models, []);
    assert.deepEqual(
      empty.json().providers.map((item: { id: string; connected: boolean }) => [item.id, item.connected]),
      [["openai", false], ["anthropic", false], ["openrouter", false], ["xai", false], ["deepinfra", false], ["local", false], ["kimi", false]],
    );

    const catalog = await app.inject({ method: "GET", url: `${base}/model-providers/deepinfra/catalog`, headers: MEMBER });
    assert.equal(catalog.statusCode, 200, catalog.body);
    const rows = catalog.json().models as Array<{ id: string; attachments: boolean; price: unknown }>;
    assert.ok(rows.length > 10, "the models.dev catalog lists DeepInfra");
    assert.ok(rows.some((row) => row.id === "deepinfra/zai-org/GLM-5.3-Flash" && row.attachments && row.price));
    assert.deepEqual(probed, [], "browsing the catalog reaches no provider");

    const rejected = await put(OWNER, "/model-providers/deepinfra", { api_key: "sk-rejected", models: [] });
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.match(rejected.json().detail, /DeepInfra rejected the key/);

    const set = await put(OWNER, "/model-providers/deepinfra", {
      api_key: "  sk-di-secret-abcd  ",
      models: ["deepinfra/zai-org/GLM-5.3-Flash", "deepinfra/Qwen/Qwen3.8-2.4T-A95B"],
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(set.json(), {
      id: "deepinfra",
      label: "DeepInfra",
      kind: "marketplace",
      connected: true,
      source: "own",
      key_hint: "abcd",
      base_url: null,
    });
    assert.equal(set.body.includes("sk-di-secret"), false);
    assert.equal(probed.at(-1), "https://api.deepinfra.com/v1/openai/models Bearer sk-di-secret-abcd");
    assert.deepEqual(await credentials.modelCredentials("org_home", "deepinfra"), { apiKey: "sk-di-secret-abcd" });

    const listed = await app.inject({ method: "GET", url: `${base}/models`, headers: MEMBER });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().providers.find((item: { id: string }) => item.id === "deepinfra").key_hint, "abcd");
    assert.equal(listed.json().providers.find((item: { id: string }) => item.id === "deepinfra").source, "own");
    assert.deepEqual(
      listed.json().models.map((item: { id: string; attachments: boolean }) => [item.id, item.attachments]),
      [["deepinfra/zai-org/GLM-5.3-Flash", true], ["deepinfra/Qwen/Qwen3.8-2.4T-A95B", false]],
    );
    assert.equal(listed.body.includes("sk-di-secret"), false);

    assert.equal((await put(MEMBER, "/model-providers/deepinfra", { api_key: "sk-other" })).statusCode, 404);
    assert.equal((await put(OWNER, "/model-providers/acme", { api_key: "sk-x" })).statusCode, 422);
    assert.equal((await put(OWNER, "/model-providers/openrouter", { api_key: "   " })).statusCode, 422);
    assert.equal((await put(OWNER, "/model-providers/openrouter", {})).statusCode, 422);
    assert.equal((await put(OWNER, "/model-providers/deepinfra", { models: ["openai/gpt-5"] })).statusCode, 422);

    const wrongKind = await put(OWNER, "/default-model", { model: "kimi/k3" });
    assert.equal(wrongKind.statusCode, 422, wrongKind.body);
    const unchosen = await put(OWNER, "/default-model", { model: "deepinfra/zai-org/GLM-5.3" });
    assert.equal(unchosen.statusCode, 422, unchosen.body);
    const chosen = await put(OWNER, "/default-model", { model: "deepinfra/zai-org/GLM-5.3-Flash" });
    assert.equal(chosen.statusCode, 200, chosen.body);
    assert.deepEqual(chosen.json(), { default: "deepinfra/zai-org/GLM-5.3-Flash" });
    assert.equal((await put(MEMBER, "/default-model", { model: null })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `${base}/models`, headers: OWNER })).json().default, "deepinfra/zai-org/GLM-5.3-Flash");

    const retick = await put(OWNER, "/model-providers/deepinfra", { models: ["deepinfra/Qwen/Qwen3.8-2.4T-A95B"] });
    assert.equal(retick.statusCode, 200, retick.body);
    assert.equal(retick.json().key_hint, "abcd", "the key is kept when the save carries none");
    assert.equal((await app.inject({ method: "GET", url: `${base}/models`, headers: OWNER })).json().default, null);

    const local = await put(OWNER, "/model-providers/local", { base_url: "http://127.0.0.1:11434/v1", models: ["local/k3"] });
    assert.equal(local.statusCode, 200, local.body);
    assert.equal(local.json().base_url, "http://127.0.0.1:11434/v1");
    assert.equal(local.json().key_hint, null);
    const localCatalog = await app.inject({ method: "GET", url: `${base}/model-providers/local/catalog`, headers: OWNER });
    assert.equal(localCatalog.statusCode, 200, localCatalog.body);
    assert.deepEqual(localCatalog.json().models.map((item: { id: string }) => item.id), ["local/zai-org/GLM-5.3-Flash", "local/k3"]);

    const outsider = await app.inject({ method: "GET", url: "/api/orgs/org_elsewhere/models", headers: OWNER });
    assert.equal(outsider.statusCode, 404);

    const refused = await app.inject({ method: "DELETE", url: `${base}/model-providers/deepinfra`, headers: MEMBER });
    assert.equal(refused.statusCode, 404);
    const removed = await app.inject({ method: "DELETE", url: `${base}/model-providers/deepinfra`, headers: OWNER });
    assert.equal(removed.statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `${base}/model-providers/deepinfra`, headers: OWNER })).statusCode, 404);
    const after = await app.inject({ method: "GET", url: `${base}/models`, headers: OWNER });
    assert.deepEqual(after.json().models.map((item: { id: string }) => item.id), ["local/k3"]);
    assert.equal(await credentials.modelCredentials("org_home", "deepinfra"), null);
  } finally {
    await app.close();
    await database.close();
  }
});
