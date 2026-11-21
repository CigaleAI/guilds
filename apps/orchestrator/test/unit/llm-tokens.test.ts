import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { getEncoding } from "js-tiktoken";
import { inputText } from "../../src/llm/token-count-worker.js";
import { TokenCountError, TokenCounter } from "../../src/llm/token-counter.js";
import { TOKEN_COUNTER_LIMITS, TOKEN_ENCODING, countInputTokens } from "../../src/llm/tokens.js";
import { NATIVE_TOOL_NAMES, schemasFor } from "../../src/toolbox/index.js";
import { installRecordingTokenCounter } from "../helpers/tokens.js";
import type { MessagePayload } from "../../src/db/schema/index.js";
import type { FunctionTool } from "../../src/lib/tool-schema.js";

const MODEL = "openrouter/openai/gpt-5.6-luna";

const MESSAGES: MessagePayload[] = [
  { role: "system", content: "You are an agent in a work guild." },
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "file_read", arguments: '{"path":"notes/weekly.md"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "The weekly note keeps the canonical finding." },
];

const TOOLS: FunctionTool[] = [
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read a file from the agent's notes.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

const legacyEncoding = getEncoding(TOKEN_ENCODING);

function legacyCount(
  messages: readonly MessagePayload[],
  tools?: readonly FunctionTool[] | null,
): number {
  let text = JSON.stringify(messages);
  if (tools && tools.length) {
    text += JSON.stringify(tools);
  }
  return Math.max(1, legacyEncoding.encode(text).length);
}

/** A run of one letter: its BPE merge is quadratic in its length, so the worker encodes it for seconds. */
const SLOW_TEXT = "a".repeat(6000);

const PARITY_CASES: Array<{ name: string; messages: MessagePayload[]; tools?: FunctionTool[] | null }> = [
  { name: "ordinary", messages: MESSAGES, tools: TOOLS },
  {
    name: "multilingual",
    messages: [
      { role: "user", content: "Résumé du rapport : 週次ノートに記録する。 تقرير أسبوعي. Ελληνικά. 🚀🧪 naïve façade" },
    ],
    tools: null,
  },
  {
    name: "long",
    messages: [{ role: "user", content: "The canonical finding stays in the weekly note and links the source run. ".repeat(4000) }],
    tools: TOOLS,
  },
  {
    name: "repetitive",
    messages: [{ role: "tool", tool_call_id: "call_1", content: `${"=".repeat(1500)}\n${"ab".repeat(500)}\n${"0".repeat(1500)}` }],
    tools: [],
  },
  {
    name: "tool result",
    messages: [
      ...MESSAGES,
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify({ rows: Array.from({ length: 200 }, (_, index) => ({ id: index, path: `notes/n-${index}.md`, ok: index % 3 === 0 })) }),
      },
    ],
    tools: TOOLS,
  },
  { name: "native tool schemas", messages: MESSAGES, tools: schemasFor([...NATIVE_TOOL_NAMES]) },
  { name: "empty messages", messages: [], tools: null },
];

function said(text: string): MessagePayload[] {
  return [{ role: "user", content: text }];
}

function encodedLength(messages: readonly MessagePayload[]): number {
  return legacyEncoding.encode(inputText(messages, null)).length;
}

test("countInputTokens matches a fresh encoding for each kind of input, tools, and model", async () => {
  for (const { name, messages, tools } of PARITY_CASES) {
    for (const model of [MODEL, "unknown/model", ""]) {
      assert.equal(await countInputTokens(model, messages, tools), legacyCount(messages, tools), `${name} on ${model}`);
    }
  }
  assert.equal(await countInputTokens(MODEL, MESSAGES), legacyCount(MESSAGES));
  assert.equal(await countInputTokens(MODEL, MESSAGES, []), legacyCount(MESSAGES, null));
  assert.notEqual(await countInputTokens(MODEL, MESSAGES, TOOLS), await countInputTokens(MODEL, MESSAGES, null));
});

test("concurrent counts each settle with their own count, on one worker", async () => {
  const recording = installRecordingTokenCounter();
  try {
    const inputs = Array.from({ length: 24 }, (_, index): MessagePayload[] => [
      { role: "user", content: `request ${index} `.repeat(index * 50 + 1) },
    ]);
    const counts = await Promise.all(inputs.map((messages) => countInputTokens(MODEL, messages, TOOLS)));
    assert.deepEqual(counts, inputs.map((messages) => legacyCount(messages, TOOLS)));
    assert.equal(recording.counter.workersStarted, 1);
  } finally {
    await recording.restore();
  }
});

test("a count past the queue bound is refused, and close rejects the counts it has not answered", async () => {
  const counter = new TokenCounter(TOKEN_ENCODING, { maxPending: 1, deadlineMs: TOKEN_COUNTER_LIMITS.deadlineMs });
  const running = assert.rejects(counter.count(said(SLOW_TEXT), null), /token counter closed/);
  const queued = assert.rejects(counter.count(said("queued"), null), /token counter closed/);
  await assert.rejects(counter.count(said("refused"), null), (error) => error instanceof TokenCountError && /queue is full/.test(error.message));
  await counter.close();
  await running;
  await queued;
  assert.equal(await counter.count(said("after close"), null), encodedLength(said("after close")));
  assert.equal(counter.workersStarted, 2);
  await counter.close();
});

test("a count past the deadline is rejected, its late reply settles nothing, and the next count gets a new worker", async () => {
  const counter = new TokenCounter(TOKEN_ENCODING, { maxPending: 4, deadlineMs: 5000 });
  try {
    await assert.rejects(
      counter.count(said(SLOW_TEXT.repeat(2)), null),
      (error) => error instanceof TokenCountError && /passed 5000 ms/.test(error.message),
    );
    assert.equal(await counter.count(said("the next count"), null), encodedLength(said("the next count")));
    assert.equal(counter.workersStarted, 2);
  } finally {
    await counter.close();
  }
});

test("a count's deadline runs from when it is asked for, so time in the queue counts against it", async () => {
  const deadlineMs = 2000;
  const counter = new TokenCounter(TOKEN_ENCODING, { maxPending: 4, deadlineMs });
  try {
    const passed = (error: unknown) => error instanceof TokenCountError && error.message === `token count passed ${deadlineMs} ms`;
    const first = assert.rejects(counter.count(said(SLOW_TEXT.repeat(2)), null), passed);
    const askedAt = performance.now();
    await assert.rejects(counter.count(said(SLOW_TEXT.repeat(2)), null), passed);
    assert.ok(performance.now() - askedAt < deadlineMs * 1.75, "the queued count was given a deadline of its own after it left the queue");
    await first;
    assert.equal(await counter.count(said("after"), null), encodedLength(said("after")));
  } finally {
    await counter.close();
  }
});

test("an input the worker cannot be sent is rejected, and the counts behind it still run", async () => {
  const counter = new TokenCounter(TOKEN_ENCODING, TOKEN_COUNTER_LIMITS);
  try {
    const unsendable = [{ role: "user", content: () => "not cloneable" }] as unknown as MessagePayload[];
    const [refused, next] = await Promise.allSettled([counter.count(unsendable, null), counter.count(said("next"), null)]);
    assert.ok(refused.status === "rejected" && refused.reason instanceof TokenCountError);
    assert.match(refused.reason.message, /could not take the count/);
    assert.deepEqual(next, { status: "fulfilled", value: encodedLength(said("next")) });
    assert.equal(counter.workersStarted, 1);
  } finally {
    await counter.close();
  }
});

test("a worker that cannot start rejects each count with a TokenCountError instead of stalling the queue", async () => {
  const counter = new TokenCounter((() => TOKEN_ENCODING) as unknown as string, TOKEN_COUNTER_LIMITS);
  try {
    const settled = await Promise.allSettled([counter.count(said("one"), null), counter.count(said("two"), null)]);
    for (const result of settled) {
      assert.ok(result.status === "rejected" && result.reason instanceof TokenCountError);
      assert.match(result.reason.message, /could not take the count/);
    }
    assert.equal(counter.workersStarted, 0);
  } finally {
    await counter.close();
  }
});

test("a worker that fails rejects its count with a TokenCountError", async () => {
  const counter = new TokenCounter("no_such_encoding", TOKEN_COUNTER_LIMITS);
  try {
    await assert.rejects(counter.count(said("hello"), null), (error) => error instanceof TokenCountError && /worker (failed|exited)/.test(error.message));
    await assert.rejects(counter.count(said("hello again"), null), TokenCountError);
    assert.equal(counter.workersStarted, 2);
  } finally {
    await counter.close();
  }
});

test("an aborted signal removes a waiting count from the queue", async () => {
  const counter = new TokenCounter(TOKEN_ENCODING, { maxPending: 1, deadlineMs: TOKEN_COUNTER_LIMITS.deadlineMs });
  try {
    const running = assert.rejects(counter.count(said(SLOW_TEXT), null), /token counter closed/);
    const abort = new AbortController();
    const cancelled = assert.rejects(counter.count(said("cancelled"), null, abort.signal), /token count cancelled/);
    abort.abort();
    await cancelled;
    const queued = assert.rejects(counter.count(said("takes the freed place"), null), /token counter closed/);
    await assert.rejects(counter.count(said("refused"), null, AbortSignal.abort()), /token count cancelled/);
    await counter.close();
    await running;
    await queued;
  } finally {
    await counter.close();
  }
});

test("the server's entry path counts on the worker and exits with the worker idle", async () => {
  const script = [
    'const { countInputTokens } = await import("./src/llm/tokens.ts");',
    'process.stdout.write(String(await countInputTokens("m", [{ role: "user", content: "hello" }])));',
  ].join("\n");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--import", "./src/instrument.ts", "--input-type=module", "-e", script],
    { cwd: new URL("../..", import.meta.url), timeout: 30_000 },
  );
  assert.equal(Number(stdout), legacyCount([{ role: "user", content: "hello" }]));
});
