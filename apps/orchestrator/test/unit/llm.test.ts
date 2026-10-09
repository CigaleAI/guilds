import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  CATALOG,
  GenerationLimitError,
  INPUT_TOKEN_LIMIT_MESSAGE,
  LLMError,
  PRICING_VERSION,
  MODEL_USER_AGENT,
  apiKeyForModel,
  applyPromptCacheControl,
  modelAcceptsAttachments,
  modelNeedsInlineImages,
  probeProviderKey,
  reasoningEffortForModel,
  applyReasoningDetailDelta,
  assistantMetadata,
  assistantPayload,
  completionTimeoutMs,
  catalogCostUsd,
  catalogRateTable,
  countInputTokens,
  enforceInputTokenLimit,
  catalogModelId,
  redactApiKey,
  streamCompletion,
  type ModelEvent,
  type ReasoningDetail,
} from "../../src/llm/index.js";

test("assistant payload excludes null tool_calls", () => {
  assert.deepEqual(assistantPayload({ role: "assistant", content: "hi", tool_calls: null }), {
    role: "assistant",
    content: "hi",
  });
});

test("applyPromptCacheControl marks the last text message", () => {
  const marked = applyPromptCacheControl([
    { role: "system", content: "rules" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
  ]);
  assert.deepEqual(marked[0], { role: "system", content: "rules" });
  assert.deepEqual(marked[1], {
    role: "user",
    content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
  });
  assert.deepEqual(marked[2], { role: "assistant", content: "" });
  const empty = [{ role: "assistant", tool_calls: [] }];
  assert.equal(applyPromptCacheControl(empty), empty);
  const multimodal = applyPromptCacheControl([
    {
      role: "user",
      content: [
        { type: "text", text: "see this" },
        { type: "image_url", image_url: { url: "https://example.test/a.png" } },
      ],
    },
  ]);
  assert.deepEqual(multimodal[0]?.content, [
    { type: "text", text: "see this", cache_control: { type: "ephemeral" } },
    { type: "image_url", image_url: { url: "https://example.test/a.png" } },
  ]);
});

test("catalog attachments flag follows the verified model list", () => {
  assert.equal(modelAcceptsAttachments("deepinfra/zai-org/GLM-5.3-Flash"), true);
  assert.equal(modelAcceptsAttachments("deepinfra/deepseek-ai/DeepSeek-V4.1-Flash"), true);
  assert.equal(modelAcceptsAttachments("kimi/k3"), true);
  assert.equal(modelAcceptsAttachments("kimi/kimi-for-coding"), true);
  assert.equal(modelAcceptsAttachments("deepinfra/Qwen/Qwen3.8-2.4T-A95B"), false);
  assert.equal(modelNeedsInlineImages("kimi/k3"), true);
  assert.equal(modelNeedsInlineImages("deepinfra/zai-org/GLM-5.3-Flash"), false);
});

test("assistant metadata catalog cost treats cached tokens as part of input", () => {
  const metadata = assistantMetadata(
    {
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    },
    { latencyMs: 1, model: "deepinfra/zai-org/GLM-5.3-Flash" },
  );
  assert.deepEqual(metadata.usage, { input_tokens: 1_000, output_tokens: 10, cache_read_tokens: 800 });
  assert.equal(metadata.cost_source, "catalog");
  assert.equal(metadata.cost_usd, 1.5e-7 * 200 + 5e-7 * 10 + 3e-8 * 800);
});

test("assistant metadata keeps Python keys and optional cost source", () => {
  const metadata = assistantMetadata(
    {
      id: "chatcmpl-1",
      model: "served-model",
      usage: { prompt_tokens: 10, completion_tokens: 4, cache_read_input_tokens: 0 },
      finish_reason: "stop",
      provider_cost: 0.001,
    },
    { latencyMs: 12, model: "openrouter/openai/gpt-5.6-luna" },
  );
  for (const key of ["usage", "latency_ms", "finish_reason", "model", "response_id", "provider_request_id", "cost_usd"]) {
    assert.ok(key in metadata);
  }
  assert.deepEqual(metadata.usage, { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0 });
  assert.equal(metadata.latency_ms, 12);
  assert.equal(metadata.provider_request_id, null);
  assert.equal(metadata.cost_usd, 0.001);
  assert.equal(metadata.cost_source, "provider");
  assert.equal("reasoning" in metadata, false);
  assert.equal("reasoning_details" in metadata, false);
});

test("assistant metadata carries reasoning only when the model streamed some", () => {
  const options = { latencyMs: 1, model: "openrouter/openai/gpt-5.6-luna" };
  const silent = assistantMetadata({ usage: {}, reasoning: "", reasoning_details: [] }, options);
  assert.equal("reasoning" in silent, false);
  assert.equal("reasoning_details" in silent, false);
  const details: ReasoningDetail[] = [{ type: "reasoning.text", text: "weigh options", index: 0 }];
  const thoughtful = assistantMetadata({ usage: {}, reasoning: "weigh options", reasoning_details: details }, options);
  assert.equal(thoughtful.reasoning, "weigh options");
  assert.deepEqual(thoughtful.reasoning_details, details);
});

test("applyReasoningDetailDelta merges text by index and appends unindexed blocks", () => {
  const acc: ReasoningDetail[] = [];
  applyReasoningDetailDelta(acc, [{ type: "reasoning.text", text: "first ", index: 0 }]);
  applyReasoningDetailDelta(acc, [{ text: "half", index: 0, signature: "sig" }]);
  applyReasoningDetailDelta(acc, [{ type: "reasoning.summary", summary: "brief", index: 1 }]);
  applyReasoningDetailDelta(acc, [{ type: "reasoning.encrypted", data: "abc" }]);
  assert.deepEqual(acc, [
    { type: "reasoning.text", text: "first half", index: 0, signature: "sig" },
    { type: "reasoning.summary", summary: "brief", index: 1 },
    { type: "reasoning.encrypted", data: "abc" },
  ]);
});

test("countInputTokens returns a positive count", () => {
  const tokens = countInputTokens("openrouter/openai/gpt-5.6-luna", [{ role: "user", content: "hello" }]);
  assert.ok(tokens >= 1);
  const unknown = countInputTokens("unknown/model", [{ role: "user", content: "hello" }]);
  assert.ok(unknown >= 1);
});

test("enforceInputTokenLimit is strict greater-than", () => {
  enforceInputTokenLimit(10, 10);
  assert.throws(
    () => enforceInputTokenLimit(11, 10),
    (error: unknown) =>
      error instanceof GenerationLimitError
      && error.message === INPUT_TOKEN_LIMIT_MESSAGE
      && error.operation === "generation.max_input_tokens",
  );
});

test("catalog cost_usd fallback prices every catalog model", () => {
  const million = 1_000_000;
  const usage = { input_tokens: million, output_tokens: million, cache_read_tokens: million };
  const luna = catalogCostUsd("openrouter/openai/gpt-5.6-luna", usage);
  assert.equal(luna.cost_usd, 1.2e-6 * million + 2e-8 * million);
  assert.equal(luna.cost_source, "catalog");
  assert.equal(luna.pricing_version, PRICING_VERSION);
  const luna6 = catalogCostUsd("openrouter/openai/gpt-6-luna", usage);
  assert.equal(luna6.cost_usd, 5e-7 * million + 1e-8 * million);
  const sol = catalogCostUsd("openrouter/openai/gpt-6.1-sol", usage);
  assert.equal(sol.cost_usd, 1e-5 * million + 1e-7 * million);
  const lunaPro = catalogCostUsd("openrouter/openai/gpt-6-luna-pro", usage);
  assert.equal(lunaPro.cost_usd, 5e-7 * million + 1e-8 * million);
  const opus = catalogCostUsd("openrouter/anthropic/claude-opus-5", usage);
  assert.equal(opus.cost_usd, 2.5e-5 * million + 5e-7 * million);
  const gemini = catalogCostUsd("openrouter/google/gemini-3.8-flash", usage);
  assert.equal(gemini.cost_usd, 3.75e-6 * million + 7.5e-8 * million);
  const qwenFlash = catalogCostUsd("openrouter/qwen/qwen3.8-flash", usage);
  assert.equal(qwenFlash.cost_usd, 4.7e-7 * million + 1.6e-8 * million);
  const qwen = catalogCostUsd("deepinfra/Qwen/Qwen3.8-2.4T-A95B", usage);
  assert.equal(qwen.cost_usd, 6e-6 * million + 2e-7 * million);
  const glm = catalogCostUsd("deepinfra/zai-org/GLM-5.3", usage);
  assert.equal(glm.cost_source, "catalog");
  assert.equal(glm.cost_usd, 4e-6 * million + 2e-7 * million);
  const glmFlash = catalogCostUsd("deepinfra/zai-org/GLM-5.3-Flash", usage);
  assert.equal(glmFlash.cost_source, "catalog");
  assert.equal(glmFlash.cost_usd, 5e-7 * million + 3e-8 * million);
  const deepseek = catalogCostUsd("deepinfra/deepseek-ai/DeepSeek-V4.1-Flash", usage);
  assert.equal(deepseek.cost_source, "catalog");
  assert.equal(deepseek.cost_usd, 6e-7 * million + 6e-9 * million);
  const mixed = catalogCostUsd("deepinfra/zai-org/GLM-5.3-Flash", {
    input_tokens: million,
    output_tokens: million,
    cache_read_tokens: 400_000,
  });
  assert.equal(mixed.cost_usd, 1.5e-7 * 600_000 + 5e-7 * million + 3e-8 * 400_000);
  assert.equal(catalogCostUsd("unknown/model", usage).cost_source, "unavailable");
  const table = catalogRateTable();
  assert.deepEqual(
    table.map((item) => item.id),
    CATALOG.filter((item) => item.kind === "marketplace").map((item) =>
      catalogModelId(item.provider, item.model),
    ),
  );
  assert.equal(catalogCostUsd("kimi/kimi-for-coding", usage).cost_source, "unavailable");
  for (const row of table) {
    assert.ok(row.rates.input > 0);
    assert.ok(row.rates.output > 0);
    assert.ok(row.rates.cacheRead > 0);
  }
});

test("apiKeyForModel requires provider prefixes", () => {
  assert.throws(() => apiKeyForModel("openrouter/x", {}), /OPENROUTER_API_KEY is not set/);
  assert.throws(() => apiKeyForModel("deepinfra/x", {}), /DEEPINFRA_API_KEY is not set/);
  assert.throws(() => apiKeyForModel("other/x", {}), /catalog provider prefix/);
  assert.throws(() => apiKeyForModel("kimi/kimi-for-coding", {}), /Kimi Code key is not connected/);
  assert.equal(apiKeyForModel("openrouter/x", { OPENROUTER_API_KEY: "k" }), "k");
  assert.equal(apiKeyForModel("kimi/kimi-for-coding", {}, "org-kimi"), "org-kimi");
});

test("reasoningEffortForModel maps Kimi Code levels", () => {
  assert.equal(reasoningEffortForModel("kimi/k3", "none"), null);
  assert.equal(reasoningEffortForModel("kimi/k3", "low"), "low");
  assert.equal(reasoningEffortForModel("kimi/k3", "medium"), "high");
  assert.equal(reasoningEffortForModel("kimi/k3", "high"), "max");
  assert.equal(reasoningEffortForModel("openrouter/openai/gpt-6-luna", "high"), "high");
});

test("probeProviderKey accepts a 200 from the coding endpoint", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "kimi-for-coding" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await probeProviderKey("kimi", "sk-test", {
      fetch: async (url, init) => {
        assert.equal(String(url).endsWith("/models"), true);
        assert.equal((init?.headers as Record<string, string>)["User-Agent"], MODEL_USER_AGENT);
        return fetch(`http://127.0.0.1:${address.port}/models`, init);
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("probeProviderKey rejects a 401", async () => {
  await assert.rejects(
    () =>
      probeProviderKey("kimi", "bad", {
        fetch: async () => new Response("no", { status: 401 }),
      }),
    /Kimi Code rejected the key/,
  );
});

test("apiKeyForModel prefers an organisation key", () => {
  assert.equal(
    apiKeyForModel("openrouter/x", { OPENROUTER_API_KEY: "platform" }, "org-key"),
    "org-key",
  );
  assert.equal(apiKeyForModel("openrouter/x", { OPENROUTER_API_KEY: "platform" }), "platform");
});

test("redactApiKey strips the provider secret", () => {
  assert.equal(redactApiKey("unauthorized sk-secret here", "sk-secret"), "unauthorized [REDACTED:API_KEY] here");
});

test("streamCompletion yields deltas then a done completion against a fake server", async () => {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as {
        tools?: unknown[];
        cache_control?: unknown;
        messages?: Array<Record<string, unknown>>;
      };
      assert.deepEqual(body.cache_control, { type: "ephemeral" });
      assert.deepEqual(body.messages?.[0], {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-request-id": "req-1",
      });
      const content = body.tools?.length ? "" : "hi";
      for (const thought of ["thinking ", "hard"]) {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            model: "served-model",
            choices: [{
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                reasoning: thought,
                reasoning_details: [{ type: "reasoning.text", text: thought, index: 0 }],
              },
              finish_reason: null,
            }],
          })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          model: "served-model",
          choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
        })}\n\n`,
      );
      if (body.tools?.length) {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            model: "served-model",
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "record_contract", arguments: "{\"value\":\"COMPAT_OK\"}" } }] },
              finish_reason: null,
            }],
          })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          model: "served-model",
          choices: [{ index: 0, delta: {}, finish_reason: body.tools?.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.001 },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  try {
    const events: ModelEvent[] = [];
    for await (const event of streamCompletion({
      model: "openrouter/openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 8,
      apiKey: "test",
      baseURL,
    })) {
      events.push(event);
    }
    assert.deepEqual(events[0], ["reasoning", "thinking "]);
    assert.deepEqual(events[1], ["reasoning", "hard"]);
    assert.deepEqual(events[2], ["delta", "hi"]);
    assert.equal(events.at(-1)?.[0], "done");
    const done = events.at(-1)?.[1] as { payload: Record<string, unknown>; metadata: Record<string, unknown> };
    assert.equal(done.payload.role, "assistant");
    assert.equal(done.payload.content, "hi");
    assert.equal("reasoning" in done.payload, false);
    assert.equal(done.metadata.cost_usd, 0.001);
    assert.equal(done.metadata.finish_reason, "stop");
    assert.equal(done.metadata.reasoning, "thinking hard");
    assert.deepEqual(done.metadata.reasoning_details, [{ type: "reasoning.text", text: "thinking hard", index: 0 }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("streamCompletion omits cache_control on DeepInfra", async () => {
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as {
        cache_control?: unknown;
        messages?: Array<Record<string, unknown>>;
      };
      assert.equal("cache_control" in body, false);
      assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          model: "served-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  try {
    for await (const event of streamCompletion({
      model: "deepinfra/zai-org/GLM-5.3-Flash",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 8,
      apiKey: "test",
      baseURL,
    })) {
      if (event[0] === "done") {
        assert.equal(event[1].metadata.cost_source, "catalog");
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("streamCompletion throws when the provider returns no chunks", async () => {
  await assert.rejects(
    async () => {
      for await (const _event of streamCompletion({
        model: "openrouter/x",
        messages: [],
        temperature: 0,
        max_tokens: 1,
        apiKey: "test",
        baseURL: "http://127.0.0.1:1/v1",
      })) {
        // consume
      }
    },
    LLMError,
  );
});

test("completionTimeoutMs scales with max_tokens and stays bounded", () => {
  assert.equal(completionTimeoutMs(1), 120_000);
  assert.equal(completionTimeoutMs(8192), 204_800);
  assert.equal(completionTimeoutMs(16384), 409_600);
  assert.equal(completionTimeoutMs(100_000), 600_000);
});
