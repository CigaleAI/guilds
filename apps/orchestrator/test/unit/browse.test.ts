import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { browserUsageOf } from "../../src/browse/cost.js";
import { BrowseModelError, FASTBROWSE_PINNED_ENV, fastbrowseEnv } from "../../src/browse/env.js";
import { formatBrowseResult, formatStep } from "../../src/browse/format.js";
import { catalogCostUsd } from "../../src/llm/cost.js";
import { logWriter } from "../../src/observability/log.js";
import { browse, browseRequest, fieldsToOutputSchema } from "../../src/toolbox/browse.js";
import { ToolArgumentError } from "../../src/toolbox/errors.js";
import { invokeTool } from "../../src/toolbox/index.js";
import type { BrowseService } from "../../src/browse/service.js";
import { costLine, runResult, stepResult as step } from "../helpers/browse.js";
import { toolFixture } from "../helpers/toolbox.js";

const originalWrite = logWriter.write;

afterEach(() => {
  logWriter.write = originalWrite;
});

/** The JSON log lines written while `work` runs. */
function capturedLogs(work: () => void): Array<Record<string, unknown>> {
  const chunks: string[] = [];
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  try {
    work();
  } finally {
    logWriter.write = originalWrite;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// fastbrowseEnv

/** The variables of `env` that differ from their pinned value. */
function routeOf(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => FASTBROWSE_PINNED_ENV[name] !== value));
}

/** Asserts that `env` sets every pinned variable, and only those. */
function assertWholeEnvironment(env: Record<string, string>): void {
  assert.deepEqual(Object.keys(env).sort(), Object.keys(FASTBROWSE_PINNED_ENV).sort());
}

test("the pinned environment blanks every key, endpoint, and model, routes Jev to TypeSafe, and never heads Chrome", () => {
  for (const [name, value] of Object.entries(FASTBROWSE_PINNED_ENV)) {
    if (/_API_KEY$|_BASE_URL$|_MODEL(_[A-Z_]+)?$|_TOKEN$/.test(name)) {
      assert.equal(value, "", name);
    }
  }
  for (const purpose of ["PLAN", "READ", "FIELD_TEXT", "SHORTCUT", "RECOVER", "COMPOSE", "VERIFY"]) {
    assert.equal(FASTBROWSE_PINNED_ENV[`FASTBROWSE_LLM_MODEL_${purpose}`], "");
  }
  assert.equal(FASTBROWSE_PINNED_ENV.FASTBROWSE_DECISION_SOURCE, "typesafe");
  assert.equal(FASTBROWSE_PINNED_ENV.FASTBROWSE_JEV_SOURCE, "typesafe");
  assert.equal(FASTBROWSE_PINNED_ENV.FASTBROWSE_HEADED, "false");
  assert.equal(FASTBROWSE_PINNED_ENV.FASTBROWSE_BINARY, "");
});

test("a provider fastbrowse names gets its own key variable and the model without its prefix, every other key blank", () => {
  const cases: Array<[string, string, string]> = [
    ["openrouter/openai/gpt-5-mini", "openrouter", "OPENROUTER_API_KEY"],
    ["openai/gpt-5", "openai", "OPENAI_API_KEY"],
    ["anthropic/claude-sonnet-4-5", "anthropic", "ANTHROPIC_API_KEY"],
    ["xai/grok-4", "xai", "XAI_API_KEY"],
  ];
  for (const [model, route, variable] of cases) {
    const env = fastbrowseEnv("ts-key", model, { apiKey: "model-key" });
    assertWholeEnvironment(env);
    assert.deepEqual(routeOf(env), {
      TYPESAFE_API_KEY: "ts-key",
      FASTBROWSE_LLM_MODEL: model.slice(model.indexOf("/") + 1),
      FASTBROWSE_LLM_PROVIDER: route,
      [variable]: "model-key",
    });
    assert.equal(env.FASTBROWSE_LLM_BASE_URL, "");
    assert.equal(env.FASTBROWSE_LLM_API_KEY, "");
  }
});

test("deepinfra runs as fastbrowse's custom provider at its own address, every named key blank", () => {
  const env = fastbrowseEnv("ts-key", "deepinfra/zai-org/GLM-5.3-Flash", { apiKey: "di-key" });
  assertWholeEnvironment(env);
  assert.deepEqual(routeOf(env), {
    TYPESAFE_API_KEY: "ts-key",
    FASTBROWSE_LLM_MODEL: "zai-org/GLM-5.3-Flash",
    FASTBROWSE_LLM_PROVIDER: "custom",
    FASTBROWSE_LLM_BASE_URL: "https://api.deepinfra.com/v1/openai",
    FASTBROWSE_LLM_API_KEY: "di-key",
  });
});

test("a local endpoint runs as the custom provider at its saved address, its key blank when it has none", () => {
  const env = fastbrowseEnv("ts-key", "local/qwen3", { apiKey: "", baseURL: "http://10.0.0.5:11434/v1" });
  assertWholeEnvironment(env);
  assert.deepEqual(routeOf(env), {
    TYPESAFE_API_KEY: "ts-key",
    FASTBROWSE_LLM_MODEL: "qwen3",
    FASTBROWSE_LLM_PROVIDER: "custom",
    FASTBROWSE_LLM_BASE_URL: "http://10.0.0.5:11434/v1",
  });
  assert.equal(env.FASTBROWSE_LLM_API_KEY, "");
});

test("a named provider whose credentials name another address runs as the custom provider there", () => {
  const env = fastbrowseEnv("ts-key", "openrouter/openai/gpt-5-mini", { apiKey: "k", baseURL: "https://gateway.test/v1" });
  assertWholeEnvironment(env);
  assert.deepEqual(routeOf(env), {
    TYPESAFE_API_KEY: "ts-key",
    FASTBROWSE_LLM_MODEL: "openai/gpt-5-mini",
    FASTBROWSE_LLM_PROVIDER: "custom",
    FASTBROWSE_LLM_BASE_URL: "https://gateway.test/v1",
    FASTBROWSE_LLM_API_KEY: "k",
  });
  assert.equal(env.OPENROUTER_API_KEY, "");
});

test("a local endpoint without an address is refused", () => {
  assert.throws(() => fastbrowseEnv("ts-key", "local/qwen3", { apiKey: "" }), BrowseModelError);
});

test("a coding-only model and an id without a known provider are refused", () => {
  assert.throws(() => fastbrowseEnv("ts-key", "kimi/kimi-for-coding", { apiKey: "k" }), /Kimi Code models cannot run/);
  assert.throws(() => fastbrowseEnv("ts-key", "acme/model", { apiKey: "k" }), BrowseModelError);
  assert.throws(() => fastbrowseEnv("ts-key", "no-provider", { apiKey: "k" }), BrowseModelError);
});

// browserUsageOf

test("browser usage sums the jev and llm lines with the dollars fastbrowse metered", () => {
  const usage = browserUsageOf("openrouter/openai/gpt-5-mini", [
    costLine({ component: "jev", dollars: 0.01, input_tokens: 100, output_tokens: 5 }),
    costLine({ component: "jev", dollars: 0.002, input_tokens: 50, output_tokens: 1 }),
    costLine({ component: "llm", dollars: 0.03, input_tokens: 900, output_tokens: 80 }),
    costLine({ component: "browser", dollars: 5, input_tokens: 7, output_tokens: 7 }),
    costLine({ component: "proxy", dollars: 1 }),
  ]);
  assert.equal(usage.model, "openrouter/openai/gpt-5-mini");
  assert.equal(usage.jev_input_tokens, 150);
  assert.equal(usage.jev_output_tokens, 6);
  assert.equal(usage.jev_cost_usd.toFixed(6), "0.012000");
  assert.equal(usage.llm_input_tokens, 900);
  assert.equal(usage.llm_output_tokens, 80);
  assert.equal(usage.llm_cost_usd, 0.03);
  assert.equal(usage.cost_usd.toFixed(6), "0.042000");
});

test("an llm line without dollars is priced from the model catalog", () => {
  const model = "deepinfra/zai-org/GLM-5.3-Flash";
  const expected = catalogCostUsd(model, { input_tokens: 2000, output_tokens: 300, cache_read_tokens: 0 }).cost_usd;
  assert.ok(expected > 0, "the catalog prices the model");
  const usage = browserUsageOf(model, [costLine({ component: "llm", dollars: null, input_tokens: 2000, output_tokens: 300 })]);
  assert.equal(usage.llm_cost_usd, expected);
  assert.equal(usage.cost_usd, expected);
});

test("a jev line without dollars counts 0 and logs a warning", () => {
  let usage = browserUsageOf("openai/gpt-5", []);
  const logs = capturedLogs(() => {
    usage = browserUsageOf("openai/gpt-5", [
      costLine({ component: "jev", basis: "unknown", dollars: null, input_tokens: 40, output_tokens: 2 }),
    ]);
  });
  assert.equal(usage.jev_input_tokens, 40);
  assert.equal(usage.jev_cost_usd, 0);
  assert.equal(usage.cost_usd, 0);
  assert.deepEqual(
    logs.filter((line) => line.operation === "browse.cost").map((line) => line.level),
    ["warn"],
  );
});

// formatBrowseResult and formatStep

test("a complete result reads as its status, final URL, answer with markers, citations, and data", () => {
  const text = formatBrowseResult(
    runResult({
      status: "complete",
      final_url: "https://shop.test/item/7",
      answer: "The kettle costs £10.69 [1].",
      citations: [
        { id: 1, text: "price", requirement_id: null, url: "https://shop.test/item/7", quote: "£10.69", deep_link: "" },
      ],
      data: { price: 10.69 },
    }),
  );
  assert.equal(
    text,
    [
      "Status: complete",
      "Final URL: https://shop.test/item/7",
      "Answer:",
      "The kettle costs £10.69 [1].",
      "Citations:",
      '[1] "£10.69" — https://shop.test/item/7',
      "Data:",
      '{\n  "price": 10.69\n}',
    ].join("\n"),
  );
});

test("a run stopped at a wall names the wall's kind, origin, and fields", () => {
  const text = formatBrowseResult(
    runResult({
      status: "needs_login",
      final_url: "https://shop.test/login",
      wall: { kind: "password", origin: "https://shop.test", fields: ["Email", "Password"], seen_at_ms: 1 },
      error: "the page asks for a sign-in",
    }),
  );
  assert.equal(
    text,
    [
      "Status: needs_login",
      "Final URL: https://shop.test/login",
      "Wall: password at https://shop.test (fields: Email, Password)",
      "Error: the page asks for a sign-in",
    ].join("\n"),
  );
});

test("a run out of budget names the resource and its limit", () => {
  const text = formatBrowseResult(runResult({ status: "budget_exceeded", budget: { resource: "steps", limit: 40 } }));
  assert.equal(text, "Status: budget_exceeded\nBudget: steps limit 40 reached");
});

test("a wall with no fields and a run with nothing else read as their status lines alone", () => {
  assert.equal(
    formatBrowseResult(runResult({ status: "blocked", wall: { kind: "bot_check", origin: "https://x.test", fields: [], seen_at_ms: 1 } })),
    "Status: blocked\nWall: bot_check at https://x.test",
  );
  assert.equal(formatBrowseResult(runResult({ status: "needs_confirmation" })), "Status: needs_confirmation");
});

test("a step reads as its operation, target, page, outcome when not executed, and note", () => {
  assert.equal(
    formatStep(step({ target: "Sign in", note: "opens the login form" })),
    'click "Sign in" at https://shop.test/cart — opens the login form',
  );
  assert.equal(formatStep(step({ operation: "scroll", outcome: "stale" })), "scroll at https://shop.test/cart (stale)");
});

// fieldsToOutputSchema

test("fields become a flat JSON Schema object with every field required", () => {
  assert.deepEqual(
    fieldsToOutputSchema({ price: { type: "number", description: "Price in pounds" }, in_stock: { type: "boolean" } }),
    {
      type: "object",
      properties: { price: { type: "number", description: "Price in pounds" }, in_stock: { type: "boolean" } },
      required: ["price", "in_stock"],
      additionalProperties: false,
    },
  );
});

test("no fields, null fields, and an empty object ask for no extraction", () => {
  assert.equal(fieldsToOutputSchema(undefined), null);
  assert.equal(fieldsToOutputSchema(null), null);
  assert.equal(fieldsToOutputSchema({}), null);
});

test("fields refuse a non-object, a bad name, a bad type, an extra key, a bad description, and more than 20 fields", () => {
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`f${index}`, { type: "string" }]));
  for (const fields of [
    ["price"],
    "price",
    { Price: { type: "string" } },
    { "1price": { type: "string" } },
    { price: { type: "object" } },
    { price: "number" },
    { price: { type: "number", format: "currency" } },
    { price: { type: "number", description: 4 } },
    tooMany,
  ]) {
    assert.throws(() => fieldsToOutputSchema(fields), ToolArgumentError, JSON.stringify(fields));
  }
});

// browseRequest

test("a browse call takes its defaults: no start, no authorization, no fields, 40 steps, 300 seconds", () => {
  assert.deepEqual(browseRequest({ task: "  find the price  " }), {
    task: "find the price",
    start: null,
    authorize: false,
    output: null,
    max_steps: 40,
    max_seconds: 300,
  });
});

test("a browse call keeps the start, authorization, fields, and limits it gives", () => {
  const request = browseRequest({
    task: "buy it",
    start: "https://shop.test/item/7",
    authorize: true,
    fields: { order_id: { type: "string" } },
    max_steps: 100,
    max_seconds: 10,
  });
  assert.equal(request.start, "https://shop.test/item/7");
  assert.equal(request.authorize, true);
  assert.deepEqual(request.output?.required, ["order_id"]);
  assert.equal(request.max_steps, 100);
  assert.equal(request.max_seconds, 10);
  assert.equal(browseRequest({ task: "t", start: "" }).start, null);
});

test("a browse call refuses a missing task, a non-web start, a non-boolean authorize, and limits out of range", () => {
  for (const args of [
    {},
    { task: "   " },
    { task: 4 },
    { task: "t", start: "ftp://shop.test" },
    { task: "t", start: "not a url" },
    { task: "t", start: 7 },
    { task: "t", authorize: "yes" },
    { task: "t", max_steps: 0 },
    { task: "t", max_steps: 101 },
    { task: "t", max_steps: 2.5 },
    { task: "t", max_seconds: 9 },
    { task: "t", max_seconds: 601 },
    { task: "t", max_seconds: "60" },
  ]) {
    assert.throws(() => browseRequest(args), ToolArgumentError, JSON.stringify(args));
  }
});

// the browse tool

test("browse without a browse service answers that the server has none", async () => {
  const { services, run, hooks } = toolFixture({ run_id: "r_1", agent_id: "a_1", guild_id: "g_1", sandbox: null, secrets: {} });
  const [message, metadata] = await invokeTool(services, run, hooks, {
    id: "call_1",
    type: "function",
    function: { name: "browse", arguments: JSON.stringify({ task: "find the price" }) },
  });
  assert.equal(message.content, "ERROR: the agent-optimized browser is not available on this server");
  assert.equal(metadata.error, "the agent-optimized browser is not available on this server");
});

test("browse wakes the browser, runs the service, and keeps its status, page, steps, and usage on the result", async () => {
  const order: string[] = [];
  const usage = {
    model: "openai/gpt-5",
    jev_input_tokens: 1,
    jev_output_tokens: 1,
    jev_cost_usd: 0.01,
    llm_input_tokens: 2,
    llm_output_tokens: 2,
    llm_cost_usd: 0.02,
    cost_usd: 0.03,
  };
  const service = {
    run: async (_run, _hooks, call, request) => {
      order.push(`run ${call.id} ${request.task} ${request.max_steps}`);
      return {
        text: "Status: complete",
        metadata: { status: "complete", final_url: "https://shop.test/", steps: 3, browser_usage: usage },
      };
    },
  } as Pick<BrowseService, "run">;
  const { services, run, hooks } = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: null,
    secrets: {},
    browse: service as BrowseService,
    ensure_browser: async () => {
      order.push("ensure_browser");
    },
  });
  const [message, metadata] = await invokeTool(services, run, hooks, {
    id: "call_7",
    type: "function",
    function: { name: browse.name, arguments: JSON.stringify({ task: "find the price" }) },
  });
  assert.deepEqual(order, ["ensure_browser", "run call_7 find the price 40"]);
  assert.equal(message.content, "Status: complete");
  assert.equal(metadata.error, null);
  assert.equal(metadata.status, "complete");
  assert.equal(metadata.final_url, "https://shop.test/");
  assert.equal(metadata.steps, 3);
  assert.deepEqual(metadata.browser_usage, usage);
});

test("browse refuses bad arguments before it wakes the browser", async () => {
  let woke = false;
  const { services, run, hooks } = toolFixture({
    run_id: "r_1",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox: null,
    secrets: {},
    browse: { run: async () => assert.fail("the service is not called") } as unknown as BrowseService,
    ensure_browser: async () => {
      woke = true;
    },
  });
  const [message] = await invokeTool(services, run, hooks, {
    id: "call_1",
    type: "function",
    function: { name: "browse", arguments: JSON.stringify({ task: "t", max_steps: 500 }) },
  });
  assert.equal(message.content, "ERROR: max_steps must be an integer from 1 to 100");
  assert.equal(woke, false);
});
