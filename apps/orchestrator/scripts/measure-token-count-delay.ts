// Measures how long input counting holds the server event loop: the main-thread encode against the
// counting worker, on the same fixtures, with a 10 ms heartbeat on the main thread.
// Run: pnpm --filter @guildsrun/orchestrator exec tsx scripts/measure-token-count-delay.ts
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { MessagePayload } from "../src/db/schema/index.js";
import type { FunctionTool } from "../src/lib/tool-schema.js";
import { TokenCounter, TokenCountError } from "../src/llm/token-counter.js";
import { TOKEN_COUNTER_LIMITS, TOKEN_ENCODING } from "../src/llm/tokens.js";
import { NATIVE_TOOL_NAMES, schemasFor } from "../src/toolbox/index.js";

const HEARTBEAT_MS = 10;
const CONCURRENT = 4;

type Fixture = { name: string; texts: string[] };

type Measurement = { latenciesMs: number[]; maxDelayMs: number; counts: number[] };

function inputText(messages: readonly MessagePayload[], tools: readonly FunctionTool[]): string {
  return JSON.stringify(messages) + JSON.stringify(tools);
}

/** A tool result as a long minified or encoded output reads: one run of a repeated character, then prose. */
function longToolResult(index: number, runLength: number): MessagePayload[] {
  const prose = `notes/weekly-${index}.md: the canonical finding stays in the note and links the source run.\n`.repeat(1500);
  return [
    { role: "system", content: "You are an agent in a work guild." },
    { role: "user", content: `Read the export ${index}.` },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${index}`, type: "function", function: { name: "file_read", arguments: `{"path":"export-${index}.txt"}` } }],
    },
    { role: "tool", tool_call_id: `call_${index}`, content: `${"x".repeat(runLength)}\n${prose}` },
  ];
}

/** A long agent history of ordinary tool reads. */
function longPrompt(turns: number): MessagePayload[] {
  const messages: MessagePayload[] = [{ role: "system", content: "You are an agent in a work guild." }];
  for (let index = 0; index < turns; index += 1) {
    messages.push(
      { role: "user", content: `Continue the standing task. Step ${index}.` },
      { role: "tool", tool_call_id: `call_${index}`, content: `finding ${index} stays in the canonical note. `.repeat(40) },
    );
  }
  return messages;
}

function fixtures(): Fixture[] {
  const tools = schemasFor([...NATIVE_TOOL_NAMES]);
  return [
    { name: "long tool result", texts: [inputText(longToolResult(0, 4000), tools)] },
    { name: "long prompt", texts: [inputText(longPrompt(400), tools)] },
    {
      name: `${CONCURRENT} concurrent long tool results`,
      texts: Array.from({ length: CONCURRENT }, (_, index) => inputText(longToolResult(index + 1, 2500), tools)),
    },
  ];
}

/** Runs `work` while a heartbeat on the main thread records how late each beat fires. */
async function withHeartbeat(work: () => Promise<{ latenciesMs: number[]; counts: number[] }>): Promise<Measurement> {
  let maxDelayMs = 0;
  let last = performance.now();
  const beat = setInterval(() => {
    const now = performance.now();
    maxDelayMs = Math.max(maxDelayMs, now - last - HEARTBEAT_MS);
    last = now;
  }, HEARTBEAT_MS);
  await nextTurn();
  last = performance.now();
  try {
    const result = await work();
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 3));
    return { ...result, maxDelayMs };
  } finally {
    clearInterval(beat);
  }
}

/** Every text encoded on the main thread, as the server counted before the worker. */
async function mainThreadCounts(encoding: () => Tiktoken, texts: string[]): Promise<Measurement> {
  return withHeartbeat(async () => {
    const start = performance.now();
    const latenciesMs: number[] = [];
    const counts: number[] = [];
    for (const text of texts) {
      counts.push(Math.max(1, encoding().encode(text).length));
      latenciesMs.push(performance.now() - start);
      await nextTurn();
    }
    return { latenciesMs, counts };
  });
}

/** Every text counted at once on the counter's worker. */
async function workerCounts(counter: TokenCounter, texts: string[]): Promise<Measurement> {
  return withHeartbeat(async () => {
    const start = performance.now();
    const latenciesMs: number[] = [];
    const counts = await Promise.all(
      texts.map(async (text) => {
        const tokens = Math.max(1, await counter.count(text));
        latenciesMs.push(performance.now() - start);
        return tokens;
      }),
    );
    return { latenciesMs: latenciesMs.sort((a, b) => a - b), counts };
  });
}

function report(label: string, measurement: Measurement): string {
  const latencies = measurement.latenciesMs.map((ms) => ms.toFixed(0)).join(", ");
  return `${label}: count latency ms [${latencies}], max heartbeat delay ${measurement.maxDelayMs.toFixed(0)} ms`;
}

/** Asks for more counts than the queue holds while the worker encodes a slow text: the rest are refused. */
async function pendingBound(): Promise<string> {
  const counter = new TokenCounter(TOKEN_ENCODING, TOKEN_COUNTER_LIMITS);
  const asked = TOKEN_COUNTER_LIMITS.maxPending + 8;
  const settled = await Promise.allSettled([
    counter.count("x".repeat(4000)),
    ...Array.from({ length: asked }, (_, index) => counter.count(`short ${index}`)),
  ]);
  await counter.close();
  const refused = settled.filter(
    (result) => result.status === "rejected" && result.reason instanceof TokenCountError && /queue is full/.test(result.reason.message),
  ).length;
  return `pending bound ${TOKEN_COUNTER_LIMITS.maxPending}: ${asked} counts asked behind a slow one, ${refused} refused`;
}

async function main(): Promise<void> {
  process.stdout.write(`node ${process.version}, heartbeat every ${HEARTBEAT_MS} ms\n`);
  for (const fixture of fixtures()) {
    const sizes = fixture.texts.map((text) => text.length).join(", ");
    process.stdout.write(`\n${fixture.name}: ${fixture.texts.length} text(s) of ${sizes} chars\n`);
    let loaded: Tiktoken | undefined;
    const sharedEncoding = () => (loaded ??= getEncoding(TOKEN_ENCODING));
    const legacyCold = await mainThreadCounts(sharedEncoding, fixture.texts);
    const legacyWarm = await mainThreadCounts(sharedEncoding, fixture.texts);
    const counter = new TokenCounter(TOKEN_ENCODING, TOKEN_COUNTER_LIMITS);
    const workerCold = await workerCounts(counter, fixture.texts);
    const workerWarm = await workerCounts(counter, fixture.texts);
    await counter.close();
    const equal = [legacyWarm, workerCold, workerWarm].every(
      (measurement) => JSON.stringify(measurement.counts) === JSON.stringify(legacyCold.counts),
    );
    process.stdout.write(
      [
        `  tokens [${legacyCold.counts.join(", ")}], equal on both paths: ${equal}`,
        `  ${report("main thread cold", legacyCold)}`,
        `  ${report("main thread warm", legacyWarm)}`,
        `  ${report("worker cold", workerCold)}`,
        `  ${report("worker warm", workerWarm)}`,
      ].join("\n") + "\n",
    );
  }
  process.stdout.write(`\n${await pendingBound()}\n`);
}

await main();
