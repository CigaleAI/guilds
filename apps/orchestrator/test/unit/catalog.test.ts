import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelCatalog } from "../../src/llm/catalog.js";
import { keepModelsDevRow, projectModelsDevFeed, readBundledSnapshot } from "../../src/llm/models-dev.js";
import { PROVIDERS, parseModelId } from "../../src/llm/providers.js";

const feed = {
  openai: {
    id: "openai",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 400000, output: 128000 },
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
        extra: "dropped",
      },
      "gpt-3.5-turbo": { id: "gpt-3.5-turbo", tool_call: true, status: "deprecated", modalities: { input: ["text"], output: ["text"] } },
      "tts-1": { id: "tts-1", tool_call: false, modalities: { input: ["text"], output: ["audio"] } },
      "whisper": { id: "whisper", tool_call: true, modalities: { input: ["audio"], output: ["text"] } },
    },
  },
  "kimi-code-plan-global": {
    id: "kimi-code-plan-global",
    models: {
      k3: {
        id: "k3",
        name: "Kimi K3",
        reasoning: true,
        temperature: false,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0, output: 0 },
      },
    },
  },
  someone: { id: "someone", models: { x: { id: "x", tool_call: true, modalities: { input: ["text"], output: ["text"] } } } },
};

function catalog(options: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; retryMs?: number } = {}) {
  return new ModelCatalog({
    snapshot: { fetched_at: "2026-01-01", providers: projectModelsDevFeed(feed, ["openai", "kimi-code-plan-global"]) },
    ...options,
  });
}

test("a row is kept when it calls tools, is not deprecated, and takes text in and out", () => {
  const rows = projectModelsDevFeed(feed, ["openai"]).openai!.models;
  assert.equal(keepModelsDevRow(rows["gpt-5"]!), true);
  assert.equal(keepModelsDevRow(rows["gpt-3.5-turbo"]!), false);
  assert.equal(keepModelsDevRow(rows["tts-1"]!), false);
  assert.equal(keepModelsDevRow(rows["whisper"]!), false);
  assert.equal("extra" in rows["gpt-5"]!, false, "only the fields the catalog reads are kept");
});

test("the catalog maps each kept row to an entry, with rates for a billed provider only", () => {
  const entries = catalog();
  assert.deepEqual(entries.listed("openai").map((entry) => entry.id), ["openai/gpt-5"]);
  const gpt5 = entries.entry("openai/gpt-5");
  assert.deepEqual(gpt5, {
    id: "openai/gpt-5",
    provider: "openai",
    model: "gpt-5",
    label: "GPT-5",
    thinking: true,
    temperature: false,
    attachments: true,
    context: 400000,
    rates: { input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7 },
    kind: "marketplace",
    coding_only: false,
    listed: true,
  });
  const k3 = entries.entry("kimi/k3");
  assert.equal(k3?.rates, null, "an unbilled provider has no rates");
  assert.equal(k3?.coding_only, true);
  assert.equal(k3?.attachments, true);
  assert.equal(entries.entry("openai/gpt-5-dated")?.listed, false);
  assert.equal(entries.entry("someone/x"), null, "a models.dev provider that is not one of ours is not a prefix");
  assert.equal(entries.pricingVersion(), "models.dev 2026-01-01");
});

test("the catalog fetches on the first read, again after an hour, and keeps the cache when the fetch fails", async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  let fail = false;
  const fetchFn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (fail) {
      return new Response("down", { status: 503 });
    }
    const fresh = structuredClone(feed);
    fresh.openai.models["gpt-5"].name = "GPT-5 (fresh)";
    return new Response(JSON.stringify(fresh), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const entries = catalog({ fetch: fetchFn, now: () => now, ttlMs: 3_600_000, retryMs: 300_000 });
  assert.equal(entries.entry("openai/gpt-5")?.label, "GPT-5");
  await entries.ensureFresh();
  assert.equal(calls.length, 1);
  assert.equal(entries.entry("openai/gpt-5")?.label, "GPT-5 (fresh)");
  assert.equal(entries.pricingVersion(), "models.dev 1970-01-01");
  await entries.ensureFresh();
  assert.equal(calls.length, 1, "a fresh cache is not fetched again");
  now += 3_600_000;
  fail = true;
  await entries.ensureFresh();
  assert.equal(calls.length, 2);
  assert.equal(entries.entry("openai/gpt-5")?.label, "GPT-5 (fresh)", "the last good cache stays");
  await entries.ensureFresh();
  assert.equal(calls.length, 2, "a failed fetch is not retried at once");
  now += 300_000;
  fail = false;
  await Promise.all([entries.ensureFresh(), entries.ensureFresh()]);
  assert.equal(calls.length, 3, "concurrent reads share one fetch");
});

test("a feed that is not the models.dev shape projects to empty providers, and a row with no id is dropped", () => {
  assert.deepEqual(projectModelsDevFeed(["openai"], ["openai"]), { openai: { id: "openai", models: {} } });
  assert.deepEqual(projectModelsDevFeed({ openai: "x" }, ["openai"]), { openai: { id: "openai", models: {} } });
  assert.deepEqual(projectModelsDevFeed({ openai: { models: [] } }, ["openai"]), { openai: { id: "openai", models: {} } });
  const projected = projectModelsDevFeed(
    {
      openai: {
        models: {
          bare: null,
          listed: ["gpt-5"],
          nameless: { id: "" },
          loose: { id: "loose", name: 5, modalities: "text", limit: [], cost: { input: "1" } },
        },
      },
    },
    ["openai"],
  );
  assert.deepEqual(projected.openai?.models, { loose: { id: "loose", cost: {} } });
});

test("the bundled snapshot carries every models.dev provider of the table", () => {
  const snapshot = readBundledSnapshot();
  assert.match(snapshot.fetched_at, /^\d{4}-\d{2}-\d{2}$/);
  for (const provider of PROVIDERS) {
    if (provider.modelsDev) {
      assert.ok(Object.keys(snapshot.providers[provider.modelsDev]?.models ?? {}).length > 0, provider.id);
    }
  }
  const live = new ModelCatalog({ snapshot });
  for (const provider of PROVIDERS) {
    if (provider.modelsDev) {
      assert.ok(live.listed(provider.id).length > 0, `${provider.id} lists models`);
    }
  }
  assert.equal(live.listed("local").length, 0);
});

test("a stored id splits at its provider prefix", () => {
  assert.deepEqual(parseModelId("deepinfra/zai-org/GLM-5.3-Flash")?.model, "zai-org/GLM-5.3-Flash");
  assert.equal(parseModelId("deepinfra/")?.model, undefined);
  assert.equal(parseModelId("acme/model"), null);
  assert.equal(parseModelId("gpt-5"), null);
});
