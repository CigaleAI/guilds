import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { Writable } from "node:stream";
import { afterEach, test } from "node:test";
import { AbortError, RpcError, type RunOptions } from "fastbrowse";
import { FASTBROWSE_PINNED_ENV } from "../../src/browse/env.js";
import { BrowseError, runBrowse, type BrowseContext, type BrowseRequest } from "../../src/browse/runner.js";
import { BrowseService } from "../../src/browse/service.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { logWriter } from "../../src/observability/log.js";
import { ModelNotConnectedError, type ModelCredentialsProvider } from "../../src/llm/credentials.js";
import { PolicyError } from "../../src/policy/index.js";
import { CancelEvent, createToolHooks, createToolRun, type ToolHooks } from "../../src/toolbox/types.js";
import { costLine, FakeFastbrowse, runResult, stepResult } from "../helpers/browse.js";
import { clearInstanceKeys, storeKeys } from "../helpers/env.js";
import { AGENT_CONFIG, agentRow } from "../helpers/generation.js";
import { fakeToolEvents, toolInvocation } from "../helpers/toolbox.js";

const TARGET: BrowseContext["target"] = ["http://127.0.0.1:9/relay", { authorization: "Bearer sandbox" }];

const REQUEST: BrowseRequest = {
  task: "find the price",
  start: "https://shop.test/",
  authorize: false,
  output: { type: "object", properties: { price: { type: "number" } }, required: ["price"], additionalProperties: false },
  max_steps: 40,
  max_seconds: 300,
};

afterEach(() => {
  clearInstanceKeys();
});

function browseContext(overrides: Partial<BrowseContext> = {}): BrowseContext {
  return {
    env: { TYPESAFE_API_KEY: "ts-key" },
    model: "openai/gpt-5",
    target: TARGET,
    signal: new AbortController().signal,
    onStep: async () => {},
    log: { run_id: "r_1" },
    ...overrides,
  };
}

/** Whether something still listens on the loopback `port`. */
async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** A fake run that reports each of `steps` and then waits until its signal stops it. */
function runUntilStopped(steps: number): (task: string, options: RunOptions) => Promise<never> {
  return async (_task, options) => {
    for (let index = 0; index < steps; index += 1) {
      options.onEvent?.({ type: "step", step: stepResult({ index }), frame: null });
    }
    const signal = options.signal;
    assert.ok(signal);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new AbortError(signal.reason);
  };
}

/** The JSON log lines written while `work` runs, and what it answered. */
async function logged<T>(work: () => Promise<T>): Promise<{ value: T; lines: Array<Record<string, unknown>> }> {
  const chunks: string[] = [];
  const originalWrite = logWriter.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  let value: T;
  try {
    value = await work();
  } finally {
    logWriter.write = originalWrite;
  }
  const lines = chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { value, lines };
}

// runBrowse

test("a browse run starts fastbrowse on the bridge, reports each step in order, and closes fastbrowse and the bridge", async () => {
  const fastbrowse = new FakeFastbrowse(async (_task, options) => {
    options.onEvent?.({ type: "browser", live_url: null, browser_id: null });
    options.onEvent?.({ type: "step", step: stepResult({ target: "Search" }), frame: null });
    options.onEvent?.({ type: "step", step: stepResult({ operation: "read", note: "price found" }), frame: null });
    return runResult({
      status: "complete",
      final_url: "https://shop.test/item/7",
      answer: "£10.69 [1]",
      steps: [stepResult(), stepResult()],
      cost: { lines: [costLine({ component: "jev", dollars: 0.01, input_tokens: 10 }), costLine({ dollars: 0.02 })] },
    });
  });
  const reported: string[] = [];
  const outcome = await runBrowse(
    fastbrowse,
    browseContext({
      onStep: async (text) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        reported.push(text);
      },
    }),
    REQUEST,
  );
  assert.deepEqual(fastbrowse.calls, ["start", "run", "close"]);
  const [started] = fastbrowse.started;
  assert.ok(started);
  assert.deepEqual(started.env, { TYPESAFE_API_KEY: "ts-key" });
  assert.equal(started.attach, true);
  assert.equal(started.foreground, true);
  assert.equal(started.local, undefined);
  assert.ok(started.stderr instanceof Writable);
  assert.equal(typeof started.cdpPort, "number");
  assert.equal(await isListening(started.cdpPort ?? 0), false, "the bridge is closed");
  const [ran] = fastbrowse.runs;
  assert.ok(ran);
  assert.equal(ran.task, "find the price");
  assert.equal(ran.options.start, "https://shop.test/");
  assert.deepEqual(ran.options.output, REQUEST.output);
  assert.deepEqual(ran.options.limits, { maxSteps: 40, maxSeconds: 300 });
  assert.deepEqual(ran.options.authorization, { irreversibleActions: false });
  assert.deepEqual(reported, ['click "Search" at https://shop.test/cart', "read at https://shop.test/cart — price found"]);
  assert.match(outcome.text, /^Status: complete\nFinal URL: https:\/\/shop.test\/item\/7\nAnswer:\n£10.69 \[1\]/);
  assert.deepEqual(outcome.metadata, {
    status: "complete",
    final_url: "https://shop.test/item/7",
    steps: 2,
    browser_usage: {
      model: "openai/gpt-5",
      jev_input_tokens: 10,
      jev_output_tokens: 0,
      jev_cost_usd: 0.01,
      llm_input_tokens: 0,
      llm_output_tokens: 0,
      llm_cost_usd: 0.02,
      cost_usd: 0.03,
    },
  });
});

test("a step that fails to report is logged and the run still answers its result with its usage", async () => {
  const fastbrowse = new FakeFastbrowse(async (_task, options) => {
    options.onEvent?.({ type: "step", step: stepResult({ index: 0 }), frame: null });
    options.onEvent?.({ type: "step", step: stepResult({ index: 1 }), frame: null });
    return runResult({ status: "complete", steps: [stepResult(), stepResult()], cost: { lines: [costLine({ dollars: 0.02 })] } });
  });
  let failures = 1;
  const reported: string[] = [];
  const { value: outcome, lines } = await logged(() =>
    runBrowse(
      fastbrowse,
      browseContext({
        onStep: async (text) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("stream closed");
          }
          reported.push(text);
        },
      }),
      REQUEST,
    ),
  );
  assert.equal(outcome.metadata.status, "complete");
  assert.equal(outcome.metadata.browser_usage?.cost_usd, 0.02);
  assert.equal(reported.length, 1, "the step after the failed one is still reported");
  const warning = lines.find((line) => line.operation === "browse.progress");
  assert.ok(warning);
  assert.equal(warning.level, "warn");
  assert.equal(warning.run_id, "r_1");
  assert.deepEqual(fastbrowse.calls, ["start", "run", "close"]);
});

test("a browse run whose fastbrowse does not start still closes the bridge", async () => {
  let port = 0;
  const launcher = {
    start: async (options: { cdpPort?: number }) => {
      port = options.cdpPort ?? 0;
      throw new BrowseError("fastbrowse did not start");
    },
  };
  await assert.rejects(runBrowse(launcher, browseContext(), REQUEST), /fastbrowse did not start/);
  assert.ok(port > 0);
  assert.equal(await isListening(port), false, "the bridge is closed");
});

test("a browse run with no start and no fields sends neither", async () => {
  const fastbrowse = new FakeFastbrowse(async () => runResult({ status: "needs_confirmation" }));
  const outcome = await runBrowse(fastbrowse, browseContext(), { ...REQUEST, start: null, output: null, authorize: true });
  const [ran] = fastbrowse.runs;
  assert.ok(ran);
  assert.equal("start" in ran.options, false);
  assert.equal("output" in ran.options, false);
  assert.deepEqual(ran.options.authorization, { irreversibleActions: true });
  assert.equal(outcome.text, "Status: needs_confirmation");
  assert.equal(outcome.metadata.status, "needs_confirmation");
});

test("a cancelled browse run closes fastbrowse and answers that it was cancelled, with no usage", async () => {
  const fastbrowse = new FakeFastbrowse(runUntilStopped(1));
  const controller = new AbortController();
  const running = runBrowse(fastbrowse, browseContext({ signal: controller.signal }), REQUEST);
  setTimeout(() => controller.abort(), 10);
  const { value: outcome, lines } = await logged(() => running);
  assert.deepEqual(fastbrowse.calls, ["start", "run", "close"]);
  assert.equal(outcome.text, "ERROR: browse cancelled");
  assert.deepEqual(outcome.metadata, { status: "cancelled", final_url: null, steps: 1 });
  const uncounted = lines.find((line) => line.operation === "browse.cost");
  assert.ok(uncounted, "the uncounted spend is logged");
  assert.equal(uncounted.level, "warn");
  assert.match(String(uncounted.message), /Jev and LLM spend is not counted.*\(steps: 1\)$/);
});

test("a browse run past its time limit answers that it stopped there", async () => {
  const fastbrowse = new FakeFastbrowse(runUntilStopped(0));
  const outcome = await runBrowse(fastbrowse, browseContext({ signal: AbortSignal.timeout(5) }), REQUEST);
  assert.equal(outcome.text, "ERROR: browse stopped at its time limit");
  assert.deepEqual(outcome.metadata, { status: "timed_out", final_url: null, steps: 0 });
  assert.deepEqual(fastbrowse.calls, ["start", "run", "close"]);
});

test("a request fastbrowse refuses throws a BrowseError and still closes fastbrowse", async () => {
  const fastbrowse = new FakeFastbrowse(async () => {
    throw new RpcError(-32003, "set OPENAI_API_KEY for the LLM");
  });
  await assert.rejects(runBrowse(fastbrowse, browseContext(), REQUEST), (error: unknown) => {
    assert.ok(error instanceof BrowseError);
    assert.equal(error.message, "the agent-optimized browser failed: set OPENAI_API_KEY for the LLM");
    return true;
  });
  assert.deepEqual(fastbrowse.calls, ["start", "run", "close"]);
});

test("an error of the runner's own callers passes through unchanged", async () => {
  const fastbrowse = new FakeFastbrowse(async () => {
    throw new TypeError("bad task");
  });
  await assert.rejects(runBrowse(fastbrowse, browseContext(), REQUEST), TypeError);
  assert.deepEqual(fastbrowse.calls, ["start", "run", "close"]);
});

// BrowseService

/** A browse service over a fake agent row, credentials, run stream, and fastbrowse. */
function browseService(
  fastbrowse: FakeFastbrowse,
  credentials: ModelCredentialsProvider,
  published: Array<Record<string, unknown>> = [],
  browserModel: string | null = "openrouter/openai/gpt-5-mini",
): BrowseService {
  const agent = agentRow({ config: { ...AGENT_CONFIG, browser: true, browser_optimized: true, browser_model: browserModel } });
  return new BrowseService({
    db: { getAgent: async (agentId) => (agentId === agent.id ? agent : null) },
    credentials,
    events: fakeToolEvents((event, data) => {
      published.push({ event, ...data });
    }),
    fastbrowse,
  });
}

const CONNECTED: ModelCredentialsProvider = {
  modelCredentials: async (orgId, provider) => (orgId === "org_1" && provider === "openrouter" ? { apiKey: "or-key" } : null),
};

function browserHooks(touched: string[] = []): ToolHooks {
  return createToolHooks({
    cdp_target: async () => TARGET,
    touch_browser: () => {
      touched.push("touch");
    },
  });
}

test("the browse service runs fastbrowse with the System One key and the agent's browser model, publishing redacted steps", async () => {
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
  const fastbrowse = new FakeFastbrowse(async (_task, options) => {
    options.onEvent?.({ type: "step", step: stepResult({ url: "https://shop.test/?token=s3cret" }), frame: null });
    return runResult({ status: "complete", steps: [stepResult()] });
  });
  const published: Array<Record<string, unknown>> = [];
  const touched: string[] = [];
  const service = browseService(fastbrowse, CONNECTED, published);
  const run = createToolRun({ run_id: "r_1", agent_id: "a_1", guild_id: "guild_1", sandbox: null, secrets: { TOKEN: "s3cret" } });
  const outcome = await service.run(run, browserHooks(touched), toolInvocation("browse", {}, "call_9"), REQUEST);
  assert.equal(outcome.metadata.status, "complete");
  assert.equal(outcome.metadata.browser_usage?.model, "openrouter/openai/gpt-5-mini");
  assert.deepEqual(fastbrowse.started[0]?.env, {
    ...FASTBROWSE_PINNED_ENV,
    TYPESAFE_API_KEY: "ts-key",
    FASTBROWSE_LLM_MODEL: "openai/gpt-5-mini",
    FASTBROWSE_LLM_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "or-key",
  });
  assert.deepEqual(published, [
    { event: "tool.progress", run_id: "r_1", tool_call_id: "call_9", lines: ["click at https://shop.test/?token=[REDACTED:TOKEN]"] },
  ]);
  assert.deepEqual(touched, ["touch"]);
});

test("the browse service stops the run when the run is cancelled", async () => {
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
  const fastbrowse = new FakeFastbrowse(runUntilStopped(0));
  const cancel = new CancelEvent();
  const run = createToolRun({ run_id: "r_1", agent_id: "a_1", guild_id: "guild_1", sandbox: null, secrets: {}, cancel_event: cancel });
  const running = browseService(fastbrowse, CONNECTED).run(run, browserHooks(), toolInvocation("browse"), REQUEST);
  setTimeout(() => cancel.set(), 10);
  const outcome = await running;
  assert.equal(outcome.text, "ERROR: browse cancelled");
  assert.deepEqual(fastbrowse.calls, ["start", "run", "close"]);
});

test("the browse service refuses without the System One key, a browser, or a browser model", async () => {
  const fastbrowse = new FakeFastbrowse(async () => runResult());
  const run = createToolRun({ run_id: "r_1", agent_id: "a_1", guild_id: "guild_1", sandbox: null, secrets: {} });
  await assert.rejects(
    browseService(fastbrowse, CONNECTED).run(run, browserHooks(), toolInvocation("browse"), REQUEST),
    /needs the System One key under Platform keys/,
  );
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
  await assert.rejects(
    browseService(fastbrowse, CONNECTED).run(run, createToolHooks(), toolInvocation("browse"), REQUEST),
    /needs the agent's browser/,
  );
  await assert.rejects(
    browseService(fastbrowse, CONNECTED, [], null).run(run, browserHooks(), toolInvocation("browse"), REQUEST),
    /needs a browser model/,
  );
  assert.deepEqual(fastbrowse.calls, []);
});

test("the browse service refuses with the credentials' own error when the model is not connected or the policy refuses", async () => {
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
  const fastbrowse = new FakeFastbrowse(async () => runResult());
  const run = createToolRun({ run_id: "r_1", agent_id: "a_1", guild_id: "guild_1", sandbox: null, secrets: {} });
  const unconnected: ModelCredentialsProvider = { modelCredentials: async () => null };
  await assert.rejects(
    browseService(fastbrowse, unconnected).run(run, browserHooks(), toolInvocation("browse"), REQUEST),
    (error: unknown) => error instanceof ModelNotConnectedError && error.message === "connect a OpenRouter key on Model keys",
  );
  const capped: ModelCredentialsProvider = {
    modelCredentials: async () => {
      throw new PolicyError(409, "the organisation reached its monthly spend");
    },
  };
  await assert.rejects(
    browseService(fastbrowse, capped).run(run, browserHooks(), toolInvocation("browse"), REQUEST),
    (error: unknown) => error instanceof PolicyError && error.message === "the organisation reached its monthly spend",
  );
  assert.deepEqual(fastbrowse.calls, []);
});
