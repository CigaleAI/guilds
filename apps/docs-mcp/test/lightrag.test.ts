import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import {
  chapterPreviewUrl,
  formatGraphResult,
  formatLabels,
  formatSearchResult,
  searchDocs,
  searchLabels,
} from "../src/lightrag.js";

test("loadConfig trims the URL and treats an empty API key as absent", () => {
  const config = loadConfig({
    LIGHTRAG_URL: "http://127.0.0.1:9621/",
    LIGHTRAG_API_KEY: "  ",
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:9621");
  assert.equal(config.apiKey, undefined);
  assert.equal(config.timeoutMs, 60_000);
});

test("formatSearchResult lists entities, relations, and clipped chunks", () => {
  const text = formatSearchResult({
    status: "success",
    data: {
      entities: [{ entity_name: "AUTH_MODE", entity_type: "setting", description: "selects identity" }],
      relationships: [
        { src_id: "AUTH_MODE", tgt_id: "identity.ts", description: "selects the current_user seam" },
      ],
      chunks: [
        {
          file_path: "philosophy.md",
          content: "compat-cookie is the local default.",
        },
      ],
    },
  });
  assert.match(text, /AUTH_MODE \(setting\)/);
  assert.match(text, /AUTH_MODE → identity\.ts/);
  assert.match(text, /philosophy\.md/);
  assert.match(text, /http:\/\/127\.0\.0\.1:9622\/#philosophy\.md/);
  assert.match(text, /compat-cookie is the local default/);
});

test("chapterPreviewUrl keeps the filename and hash-routes the viewer", () => {
  assert.equal(
    chapterPreviewUrl("docs/concepts/users-and-organisations.md"),
    "http://127.0.0.1:9622/#concepts%2Fusers-and-organisations.md",
  );
});

test("formatGraphResult and formatLabels compact graph payloads", () => {
  const graph = formatGraphResult({
    is_truncated: true,
    nodes: [
      {
        id: "organisation",
        properties: { entity_type: "concept", description: "tenancy and billing root" },
      },
    ],
    edges: [{ source: "organisation", target: "guild", properties: { description: "owns" } }],
  });
  assert.match(graph, /truncated: true/);
  assert.match(graph, /organisation \(concept\)/);
  assert.match(graph, /organisation → guild/);
  assert.equal(formatLabels(["AUTH_MODE", "sandbox_hosts"]), "1. AUTH_MODE\n2. sandbox_hosts");
  assert.equal(formatLabels([]), "No matching entity labels.");
});

test("searchDocs posts mix query/data and forwards the API key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        status: "success",
        data: { entities: [{ entity_name: "guild" }], chunks: [] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const text = await searchDocs(
      { baseUrl: "http://127.0.0.1:9621", apiKey: "docs-key", timeoutMs: 5_000 },
      { query: "what is a guild", mode: "mix", topK: 40, chunkTopK: 12 },
    );
    assert.match(text, /guild/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:9621/query/data");
    const headers = new Headers(calls[0]?.init.headers);
    assert.equal(headers.get("X-API-Key"), "docs-key");
    const body = JSON.parse(String(calls[0]?.init.body)) as { mode: string; enable_rerank: boolean };
    assert.equal(body.mode, "mix");
    assert.equal(body.enable_rerank, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("searchLabels encodes the query string", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    assert.equal(String(url), "http://127.0.0.1:9621/graph/label/search?q=AUTH&limit=20");
    return new Response(JSON.stringify(["AUTH_MODE"]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const text = await searchLabels(
      { baseUrl: "http://127.0.0.1:9621", apiKey: undefined, timeoutMs: 5_000 },
      "AUTH",
      20,
    );
    assert.equal(text, "1. AUTH_MODE");
  } finally {
    globalThis.fetch = original;
  }
});
