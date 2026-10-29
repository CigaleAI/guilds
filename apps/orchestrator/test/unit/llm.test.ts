import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  GenerationLimitError,
  INPUT_TOKEN_LIMIT_MESSAGE,
  LLMError,
  MODEL_USER_AGENT,
  applyPromptCacheControl,
  modelAcceptsAttachments,
  modelCatalog,
  modelNeedsInlineImages,
  listProviderModels,
  providerById,
  reasoningEffortForModel,
  applyReasoningDetailDelta,
  assistantMetadata,
  assistantPayload,
  completionRequestBody,
  completionTimeoutMs,
  catalogCostUsd,
  countInputTokens,
  enforceInputTokenLimit,
  redactApiKey,
  streamCompletion,
  type ModelEvent,
  type ReasoningDetail,
} from "../../src/llm/index.js";
import { parseCompletionChunk } from "../../src/llm/client.js";

function provider(id: string) {
  const definition = providerById(id);
  assert.ok(definition, `${id} is a provider`);
  return definition;
}

test("assistant payload excludes null tool_calls", () => {
  assert.deepEqual(assistantPayload("hi", []), {
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

test("catalog attachments flag follows the models.dev snapshot, and an unlisted id takes the default", () => {
  assert.equal(modelAcceptsAttachments("deepinfra/zai-org/GLM-5.3-Flash"), true);
  assert.equal(modelAcceptsAttachments("deepinfra/deepseek-ai/DeepSeek-V4.1-Flash"), true);
  assert.equal(modelAcceptsAttachments("kimi/k3"), true);
  assert.equal(modelAcceptsAttachments("kimi/kimi-for-coding"), true);
  assert.equal(modelAcceptsAttachments("deepinfra/Qwen/Qwen3.8-2.4T-A95B"), false);
  assert.equal(modelAcceptsAttachments("openai/gpt-5-dated-2099-01-01"), false);
  assert.equal(modelAcceptsAttachments("local/qwen"), false);
  assert.equal(modelAcceptsAttachments("not-a-provider"), false);
  assert.equal(modelNeedsInlineImages("kimi/k3"), true);
  assert.equal(modelNeedsInlineImages("deepinfra/zai-org/GLM-5.3-Flash"), false);
  const unlisted = modelCatalog.entry("openai/gpt-5-dated-2099-01-01");
  assert.deepEqual(
    unlisted && { listed: unlisted.listed, thinking: unlisted.thinking, temperature: unlisted.temperature, rates: unlisted.rates },
    { listed: false, thinking: true, temperature: true, rates: null },
  );
  assert.equal(modelCatalog.entry("nope"), null);
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

test("catalog cost_usd comes from the catalog's rates for a billed provider", () => {
  const million = 1_000_000;
  const usage = { input_tokens: million, output_tokens: million, cache_read_tokens: million };
  const glmFlash = catalogCostUsd("deepinfra/zai-org/GLM-5.3-Flash", usage);
  assert.equal(glmFlash.cost_source, "catalog");
  assert.ok(Math.abs(glmFlash.cost_usd - (0.5 + 0.03)) < 1e-9);
  assert.equal(glmFlash.pricing_version, modelCatalog.pricingVersion());
  assert.match(glmFlash.pricing_version, /^models\.dev \d{4}-\d{2}-\d{2}$/);
  const mixed = catalogCostUsd("deepinfra/zai-org/GLM-5.3-Flash", {
    input_tokens: million,
    output_tokens: million,
    cache_read_tokens: 400_000,
  });
  assert.ok(Math.abs(mixed.cost_usd - (0.15 * 0.6 + 0.5 + 0.03 * 0.4)) < 1e-9);
  assert.equal(catalogCostUsd("kimi/kimi-for-coding", usage).cost_source, "unavailable");
  assert.equal(catalogCostUsd("local/qwen", usage).cost_source, "unavailable");
  assert.equal(catalogCostUsd("openai/gpt-5-dated-2099-01-01", usage).cost_source, "unavailable");
  assert.equal(catalogCostUsd("unknown/model", usage).cost_source, "unavailable");
});

test("reasoningEffortForModel maps Kimi Code levels", () => {
  assert.equal(reasoningEffortForModel("kimi/k3", "none"), null);
  assert.equal(reasoningEffortForModel("kimi/k3", "low"), "low");
  assert.equal(reasoningEffortForModel("kimi/k3", "medium"), "high");
  assert.equal(reasoningEffortForModel("kimi/k3", "high"), "max");
  assert.equal(reasoningEffortForModel("openrouter/openai/gpt-6-luna", "high"), "high");
});

test("listProviderModels accepts a 200 and returns the listed ids", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "kimi-for-coding" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const ids = await listProviderModels(provider("kimi"), {
      apiKey: "sk-test",
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(url), "https://api.kimi.ai/coding/v1/models");
        assert.equal((init?.headers as Record<string, string>)["User-Agent"], MODEL_USER_AGENT);
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk-test");
        return fetch(`http://127.0.0.1:${address.port}/models`, init);
      },
    });
    assert.deepEqual(ids, ["kimi-for-coding"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("listProviderModels rejects a 401 and names the provider", async () => {
  await assert.rejects(
    () =>
      listProviderModels(provider("kimi"), {
        apiKey: "bad",
        fetch: async () => new Response("no", { status: 401 }),
      }),
    /Kimi Code rejected the key/,
  );
  await assert.rejects(
    () => listProviderModels(provider("openai"), { apiKey: " ", fetch: async () => new Response("[]") }),
    /api_key is required/,
  );
});

test("listProviderModels reads a bare list of ids, and returns nothing for a body of another shape", async () => {
  const listing = (body: string) => async () => new Response(body, { status: 200 });
  assert.deepEqual(
    await listProviderModels(provider("kimi"), { apiKey: "sk", fetch: listing(JSON.stringify([" k3 ", { id: "k2" }, 5, { id: 7 }, ""])) }),
    ["k3", "k2"],
  );
  for (const body of ["not json", "null", JSON.stringify({ data: "k3" }), JSON.stringify({ models: [{ id: "k3" }] })]) {
    assert.deepEqual(await listProviderModels(provider("kimi"), { apiKey: "sk", fetch: listing(body) }), [], body);
  }
});

test("parseCompletionChunk reads a chunk's text, reasoning, tool call pieces, finish reason, and usage", () => {
  assert.deepEqual(
    parseCompletionChunk({
      id: "chatcmpl-1",
      model: "served-model",
      choices: [
        {
          index: 0,
          delta: {
            content: "hi",
            reasoning_content: "weigh",
            reasoning_details: [{ type: "reasoning.text", text: "weigh", index: 0 }],
            tool_calls: [{ index: 1, id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 }, cache_read_input_tokens: 2, cost: 0.5 },
    }),
    {
      id: "chatcmpl-1",
      model: "served-model",
      text: "hi",
      reasoning: "weigh",
      reasoningDetails: [{ type: "reasoning.text", text: "weigh", index: 0 }],
      toolCalls: [{ index: 1, id: "call_1", type: "function", name: "read", arguments: "{}" }],
      finishReason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 4, cache_read_input_tokens: 2, prompt_tokens_details: { cached_tokens: 2 }, cost: 0.5 },
    },
  );
  assert.equal(parseCompletionChunk({ choices: [{ delta: { reasoning_details: [{ summary: "brief" }] } }] }).reasoning, "brief");
});

test("parseCompletionChunk leaves empty every field a malformed chunk holds in another shape", () => {
  const empty = { id: null, model: null, text: "", reasoning: "", reasoningDetails: [], toolCalls: [], finishReason: null, usage: null };
  for (const chunk of [null, "data", [], { choices: "x" }, { choices: [null] }, { choices: [{ delta: [] }] }]) {
    assert.deepEqual(parseCompletionChunk(chunk), empty, JSON.stringify(chunk));
  }
  assert.deepEqual(
    parseCompletionChunk({
      id: 5,
      model: "",
      choices: [
        {
          delta: {
            content: 7,
            reasoning: 3,
            reasoning_details: [null, "x", { index: "0", text: "dropped" }],
            tool_calls: [null, { function: "read" }, { id: 1, function: { name: 2, arguments: "{}" } }],
          },
          finish_reason: 1,
        },
      ],
      usage: { prompt_tokens: "10", prompt_tokens_details: { cached_tokens: "2" }, cost: null },
    }),
    {
      ...empty,
      toolCalls: [
        { index: 0, id: "", type: "", name: "", arguments: "" },
        { index: 0, id: "", type: "", name: "", arguments: "{}" },
      ],
      usage: {},
    },
  );
});

test("listProviderModels reaches a local endpoint at its saved URL, with no key when none is set", async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const ids = await listProviderModels(provider("local"), {
    apiKey: "",
    baseURL: "http://127.0.0.1:11434/v1/",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "llama" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(ids, ["qwen3:8b", "llama"]);
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:11434/v1/models", auth: undefined }]);
  await assert.rejects(() => listProviderModels(provider("local"), { apiKey: "" }), /needs a base URL/);
});

test("completionRequestBody shapes the body per provider", () => {
  const base = {
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.4,
    max_tokens: 64,
    thinking_level: "medium",
  };
  const openai = completionRequestBody({ ...base, model: "openai/gpt-5-dated-2099-01-01" });
  assert.equal(openai.model, "gpt-5-dated-2099-01-01");
  assert.equal(openai.max_completion_tokens, 64);
  assert.equal("max_tokens" in openai, false);
  assert.equal(openai.reasoning_effort, "medium");
  assert.equal("reasoning" in openai, false);
  assert.equal("cache_control" in openai, false);
  assert.equal(openai.temperature, 0.4, "an unlisted id takes a temperature");
  assert.deepEqual(openai.messages, base.messages);

  const openrouter = completionRequestBody({ ...base, model: "openrouter/anthropic/claude-opus-5" });
  assert.equal(openrouter.model, "anthropic/claude-opus-5");
  assert.equal(openrouter.max_tokens, 64);
  assert.deepEqual(openrouter.reasoning, { effort: "medium" });
  assert.equal("reasoning_effort" in openrouter, false);
  assert.deepEqual(openrouter.cache_control, { type: "ephemeral" });
  assert.equal("temperature" in openrouter, false, "the catalog says this model sets its own temperature");

  const deepinfra = completionRequestBody({ ...base, model: "deepinfra/zai-org/GLM-5.3-Flash" });
  assert.equal(deepinfra.max_tokens, 64);
  assert.equal(deepinfra.reasoning_effort, "medium");
  assert.equal(deepinfra.temperature, 0.4);
  assert.equal("cache_control" in deepinfra, false);

  const kimi = completionRequestBody({ ...base, model: "kimi/k3", thinking_level: "high" });
  assert.equal(kimi.reasoning_effort, "max");
  assert.equal(kimi.max_tokens, 64);

  const local = completionRequestBody({ ...base, model: "local/qwen3:8b", thinking_level: "none" });
  assert.equal(local.model, "qwen3:8b");
  assert.equal("reasoning_effort" in local, false);
  assert.equal(local.temperature, 0.4);
  assert.throws(() => completionRequestBody({ ...base, model: "gpt-5" }), /\{provider\}\/\{model\}/);
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
