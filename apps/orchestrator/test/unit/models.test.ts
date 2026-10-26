import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelCatalog } from "../../src/llm/catalog.js";
import { coreModelCredentials, type ModelCredentialsProvider } from "../../src/llm/credentials.js";
import { ModelsError, ModelsService, type ModelsRepository } from "../../src/llm/models.js";
import { projectModelsDevFeed } from "../../src/llm/models-dev.js";
import type { NewOrgModelProvider, OrgModelProviderRow } from "../../src/db/orgs.js";
import { TEST_MASTER_KEY } from "../helpers/models.js";

const STORED_AT = "2026-01-01T00:00:00.000Z";

class MemoryRepo implements ModelsRepository {
  rows = new Map<string, OrgModelProviderRow>();
  defaults = new Map<string, string | null>();

  async listOrgModelProviders(orgId: string) {
    return [...this.rows.values()]
      .filter((row) => row.org_id === orgId)
      .map((row) => ({ ...row, own_key: row.ciphertext !== null }));
  }

  async getOrgModelProvider(orgId: string, provider: string) {
    return this.rows.get(`${orgId}/${provider}`) ?? null;
  }

  async upsertOrgModelProvider(input: NewOrgModelProvider, _now: Date) {
    const { providerId: id, orgId, provider, ciphertext, nonce, keyHint, models } = input;
    const stored = {
      id,
      org_id: orgId,
      provider,
      ciphertext,
      nonce,
      key_hint: keyHint,
      models,
      created_at: STORED_AT,
      updated_at: STORED_AT,
    };
    this.rows.set(`${orgId}/${provider}`, stored);
    return stored;
  }

  async deleteOrgModelProvider(orgId: string, provider: string) {
    const row = this.rows.get(`${orgId}/${provider}`) ?? null;
    this.rows.delete(`${orgId}/${provider}`);
    return row;
  }

  async getOrgDefaultModel(orgId: string) {
    return this.defaults.get(orgId) ?? null;
  }

  async setOrgDefaultModel(orgId: string, model: string | null) {
    this.defaults.set(orgId, model);
  }
}

const feed = projectModelsDevFeed(
  {
    openai: {
      id: "openai",
      models: {
        "gpt-5": { id: "gpt-5", name: "GPT-5", tool_call: true, reasoning: true, temperature: false, attachment: true, modalities: { input: ["text"], output: ["text"] }, cost: { input: 1, output: 2, cache_read: 0.5 }, limit: { context: 1000 } },
        "gpt-5-mini": { id: "gpt-5-mini", name: "GPT-5 mini", tool_call: true, modalities: { input: ["text"], output: ["text"] }, cost: { input: 0.1, output: 0.2 } },
      },
    },
    "kimi-code-plan-global": {
      id: "kimi-code-plan-global",
      models: { k3: { id: "k3", name: "Kimi K3", tool_call: true, reasoning: true, modalities: { input: ["text"], output: ["text"] } } },
    },
  },
  ["openai", "kimi-code-plan-global"],
);

function service(
  probe: Record<string, string[] | number> = {},
  credentialsOf: (repo: MemoryRepo) => ModelCredentialsProvider = (repo) => coreModelCredentials(repo, TEST_MASTER_KEY),
) {
  const repo = new MemoryRepo();
  const requests: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace("Bearer ", "");
    requests.push(`${String(url)} ${key}`);
    const answer = probe[String(url)];
    if (typeof answer === "number") {
      return new Response("no", { status: answer });
    }
    return new Response(JSON.stringify({ data: (answer ?? []).map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const models = new ModelsService({
    repo,
    credentials: credentialsOf(repo),
    catalog: new ModelCatalog({ snapshot: { fetched_at: "2026-01-01", providers: feed }, url: "" }),
    fetch: fetchFn,
    masterKey: TEST_MASTER_KEY,
  });
  return { repo, models, requests };
}

test("nothing is offered until a provider is connected", async () => {
  const { models } = service();
  const payload = await models.read("org_1");
  assert.equal(payload.default, null);
  assert.deepEqual(payload.models, []);
  assert.deepEqual(
    payload.providers.map((item) => [item.id, item.kind, item.connected, item.source, item.key_hint]),
    [
      ["openai", "marketplace", false, null, null],
      ["anthropic", "marketplace", false, null, null],
      ["openrouter", "marketplace", false, null, null],
      ["xai", "marketplace", false, null, null],
      ["deepinfra", "marketplace", false, null, null],
      ["local", "marketplace", false, null, null],
      ["kimi", "coding", false, null, null],
    ],
  );
  assert.deepEqual(await models.connectedProviders("org_1"), new Set());
});

test("connecting probes the key, keeps it on a later save, and offers the chosen models with their capacities", async () => {
  const { models, requests, repo } = service({ "https://api.openai.com/v1/models": ["gpt-5", "gpt-5-mini"] });
  await assert.rejects(() => models.connect("org_1", "openai", {}), /api_key is required/);
  await assert.rejects(
    () => models.connect("org_1", "openai", { api_key: "sk-1", models: ["gpt-5"] }),
    (error: unknown) => error instanceof ModelsError && /openai\/\{model\}/.test(error.message),
  );
  const item = await models.connect("org_1", "openai", { api_key: " sk-openai-1234 ", models: ["openai/gpt-5", "openai/gpt-5", "openai/gpt-5-dated"] });
  assert.deepEqual(item, { id: "openai", label: "OpenAI", kind: "marketplace", connected: true, source: "own", key_hint: "1234", base_url: null });
  assert.deepEqual(requests, ["https://api.openai.com/v1/models sk-openai-1234"]);
  const payload = await models.read("org_1");
  assert.equal(payload.providers.find((row) => row.id === "openai")?.connected, true);
  assert.deepEqual(
    payload.models.map((row) => [row.id, row.label, row.thinking, row.temperature, row.attachments, row.context, row.price]),
    [
      ["openai/gpt-5", "GPT-5", true, false, true, 1000, { input: 1, output: 2, cache_read: 0.5 }],
      ["openai/gpt-5-dated", "gpt-5-dated", true, true, false, null, null],
    ],
  );
  await models.connect("org_1", "openai", { models: ["openai/gpt-5-mini"] });
  assert.equal(requests.length, 2, "a later save probes the kept key");
  assert.equal(requests[1], "https://api.openai.com/v1/models sk-openai-1234");
  assert.deepEqual((await models.read("org_1")).models.map((row) => row.id), ["openai/gpt-5-mini"]);
  const catalog = await models.providerCatalog("org_1", "openai");
  assert.deepEqual(catalog.map((row) => row.id), ["openai/gpt-5", "openai/gpt-5-mini"]);
  assert.equal(repo.rows.get("org_1/openai")?.key_hint, "1234");
});

test("a rejected key is not saved", async () => {
  const { models, repo } = service({ "https://api.x.ai/v1/models": 401 });
  await assert.rejects(
    () => models.connect("org_1", "xai", { api_key: "bad" }),
    (error: unknown) => error instanceof ModelsError && error.status === 422 && /xAI rejected the key/.test(error.message),
  );
  assert.equal(repo.rows.size, 0);
});

test("the local endpoint takes a URL and an optional key, lists what it reports, and offers fixed capacities", async () => {
  const { models, requests } = service({ "http://127.0.0.1:11434/v1/models": ["qwen3:8b", "llama"] });
  await assert.rejects(() => models.connect("org_1", "local", {}), /base_url is required/);
  await assert.rejects(() => models.connect("org_1", "local", { base_url: "ftp://x" }), /http/);
  await assert.rejects(() => models.providerCatalog("org_1", "local"), /URL first/);
  const item = await models.connect("org_1", "local", { base_url: "http://127.0.0.1:11434/v1", models: ["local/qwen3:8b"] });
  assert.deepEqual(item, { id: "local", label: "Local endpoint", kind: "marketplace", connected: true, source: "own", key_hint: null, base_url: "http://127.0.0.1:11434/v1" });
  assert.deepEqual(requests, ["http://127.0.0.1:11434/v1/models "]);
  const listed = await models.providerCatalog("org_1", "local");
  assert.deepEqual(listed.map((row) => [row.id, row.thinking, row.temperature, row.attachments, row.price]), [
    ["local/qwen3:8b", true, true, false, null],
    ["local/llama", true, true, false, null],
  ]);
  const payload = await models.read("org_1");
  assert.equal(payload.providers.find((row) => row.id === "local")?.base_url, "http://127.0.0.1:11434/v1");
  assert.deepEqual(payload.models.map((row) => row.id), ["local/qwen3:8b"]);
});

test("the default is one of the chosen marketplace models, and clears when that choice goes", async () => {
  const { models } = service({
    "https://api.openai.com/v1/models": ["gpt-5"],
    "https://api.kimi.ai/coding/v1/models": ["k3"],
  });
  await models.connect("org_1", "openai", { api_key: "sk-1", models: ["openai/gpt-5", "openai/gpt-5-mini"] });
  await models.connect("org_1", "kimi", { api_key: "sk-2", models: ["kimi/k3"] });
  await assert.rejects(() => models.setDefault("org_1", "kimi/k3"), /marketplace/);
  await assert.rejects(() => models.setDefault("org_1", "openai/gpt-5-dated"), /choose openai\/gpt-5-dated under OpenAI/);
  await assert.rejects(() => models.setDefault("org_1", "gpt-5"), /\{provider\}\/\{model\}/);
  assert.deepEqual(await models.setDefault("org_1", "openai/gpt-5"), { default: "openai/gpt-5" });
  assert.equal((await models.read("org_1")).default, "openai/gpt-5");
  await models.connect("org_1", "openai", { models: ["openai/gpt-5-mini"] });
  assert.equal((await models.read("org_1")).default, null, "unticking the default clears it");
  await models.setDefault("org_1", "openai/gpt-5-mini");
  assert.deepEqual(await models.setDefault("org_1", null), { default: null });
  await models.setDefault("org_1", "openai/gpt-5-mini");
  assert.equal(await models.remove("org_1", "openai"), true);
  assert.equal((await models.read("org_1")).default, null, "removing the key clears the default");
  assert.equal(await models.remove("org_1", "openai"), false);
  assert.deepEqual(await models.connectedProviders("org_1"), new Set(["kimi"]));
});

test("a provider the platform serves is marked so, offers its models, and is not the organisation's to remove", async () => {
  const { models, repo } = service({ "https://api.openai.com/v1/models": ["gpt-5"] }, (store) => {
    const own = coreModelCredentials(store, TEST_MASTER_KEY);
    return {
      async modelCredentials(orgId, provider) {
        return (await own.modelCredentials(orgId, provider)) ?? (provider === "openai" ? { apiKey: "platform-key" } : null);
      },
    };
  });
  await repo.upsertOrgModelProvider(
    {
      providerId: "mp_1",
      orgId: "org_1",
      provider: "openai",
      ciphertext: null,
      nonce: null,
      keyHint: null,
      models: ["openai/gpt-5"],
    },
    new Date(STORED_AT),
  );
  const payload = await models.read("org_1");
  assert.deepEqual(
    payload.providers.filter((item) => item.connected).map((item) => [item.id, item.source, item.key_hint]),
    [["openai", "platform", null]],
  );
  assert.deepEqual(payload.models.map((row) => row.id), ["openai/gpt-5"]);
  assert.deepEqual(await models.setDefault("org_1", "openai/gpt-5"), { default: "openai/gpt-5" });
  await assert.rejects(() => models.connect("org_1", "openai", { models: [] }), /api_key is required/);
  await assert.rejects(
    () => models.remove("org_1", "openai"),
    (error: unknown) => error instanceof ModelsError && error.status === 409 && /OpenAI is provided by the platform/.test(error.message),
  );
  const item = await models.connect("org_1", "openai", { api_key: "sk-own-5678" });
  assert.equal(item.source, "own", "the organisation's key takes over from the platform's");
  assert.deepEqual(repo.rows.get("org_1/openai")?.models, ["openai/gpt-5"]);
  assert.equal(await models.remove("org_1", "openai"), true);
});
