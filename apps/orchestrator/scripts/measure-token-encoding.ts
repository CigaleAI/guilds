// Times js-tiktoken getEncoding against encode on the payloads input counting sees.
// Run: pnpm --filter @guildsrun/orchestrator exec tsx scripts/measure-token-encoding.ts
import { performance } from "node:perf_hooks";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { readStudioSystemTemplate } from "../src/studio/system.js";
import { studioToolSchemas } from "../src/studio/tools.js";
import { NATIVE_TOOL_NAMES, schemasFor } from "../src/toolbox/index.js";

const ENCODING_NAME = "o200k_base";
const SAMPLES = 8;
const BURST = 20;
const STUB_LIMIT_CHARS = 1800;

type Payload = {
  name: string;
  messages: unknown[];
  tools: unknown[] | null;
};

function promptBlob(messages: unknown[], tools?: unknown[] | null): string {
  let text = JSON.stringify(messages);
  if (tools && tools.length) {
    text += JSON.stringify(tools);
  }
  return text;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? 0;
}

function elapsed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function firstAndMedian(run: () => void): { first: number; median: number } {
  const first = elapsed(run);
  const rest: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    rest.push(elapsed(run));
  }
  return { first, median: median(rest) };
}

function toolBody(index: number): string {
  const line = `notes/weekly-${index}.md:12: finding ${index} stays in the canonical note and links the source run.`;
  return `${line}\n`
    .repeat(Math.ceil(STUB_LIMIT_CHARS / (line.length + 1)))
    .slice(0, STUB_LIMIT_CHARS);
}

function historyTurns(count: number): unknown[] {
  const messages: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push(
      { role: "user", content: `Continue the standing task. Step ${index}.` },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${index}`,
            type: "function",
            function: {
              name: "file_read",
              arguments: JSON.stringify({ path: `notes/weekly-${index}.md` }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: `call_${index}`, content: toolBody(index) },
    );
  }
  return messages;
}

function turnsUntilChars(system: string, tools: unknown[], targetChars: number): unknown[] {
  const messages: unknown[] = [{ role: "system", content: system }];
  while (promptBlob(messages, tools).length < targetChars) {
    messages.push(...historyTurns(1));
  }
  return messages;
}

function agentSystemPrompt(tools: Array<Record<string, unknown>>): string {
  return [
    "You are an agent in a work guild.",
    "State is a snapshot of the UTC clock, the last 10 public group messages, and the catalogs for this run.",
    JSON.stringify({
      utc_now: "2026-11-03T15:00:00Z",
      max_tool_calls: 50,
      catalogs: tools.map((tool) => tool.function),
    }),
  ].join("\n");
}

function coachPayloads(): Payload[] {
  return [
    {
      name: "short user",
      messages: [{ role: "user", content: "What should change in the standing task?" }],
      tools: null,
    },
    {
      name: "studio turn",
      messages: [
        { role: "system", content: readStudioSystemTemplate() },
        {
          role: "user",
          content: "The roster is one writer. Survey the guild and say what to change.",
        },
        ...historyTurns(2),
      ],
      tools: studioToolSchemas(),
    },
  ];
}

function runPayloads(): Payload[] {
  const tools = schemasFor([...NATIVE_TOOL_NAMES]);
  const system = agentSystemPrompt(tools);
  return [
    {
      name: "agent history",
      messages: [{ role: "system", content: system }, ...historyTurns(40)],
      tools,
    },
    {
      name: "near input cap",
      messages: turnsUntilChars(system, tools, 400_000),
      tools,
    },
  ];
}

function burst(times: number, run: () => void): number {
  return elapsed(() => {
    for (let i = 0; i < times; i += 1) {
      run();
    }
  });
}

function measure(encoding: Tiktoken, text: string): string {
  const load = firstAndMedian(() => {
    getEncoding(ENCODING_NAME);
  });
  const encode = firstAndMedian(() => {
    encoding.encode(text);
  });
  const both = firstAndMedian(() => {
    getEncoding(ENCODING_NAME).encode(text);
  });
  const encodeShare = both.median === 0 ? 0 : encode.median / both.median;
  const lines = [
    `tokens ${encoding.encode(text).length}`,
    `bytes ${text.length}`,
    `getEncoding ms first ${load.first.toFixed(1)} median ${load.median.toFixed(1)}`,
    `encode ms first ${encode.first.toFixed(1)} median ${encode.median.toFixed(1)}`,
    `getEncoding+encode ms first ${both.first.toFixed(1)} median ${both.median.toFixed(1)}`,
    `encode share of combined median ${encodeShare.toFixed(2)}`,
    `burst ${BURST} getEncoding+encode ms ${burst(BURST, () => getEncoding(ENCODING_NAME).encode(text)).toFixed(1)}`,
    `burst ${BURST} encode ms ${burst(BURST, () => encoding.encode(text)).toFixed(1)}`,
  ];
  return lines.join("\n  ");
}

const encoding = getEncoding(ENCODING_NAME);
for (const payload of [...coachPayloads(), ...runPayloads()]) {
  const text = promptBlob(payload.messages, payload.tools);
  process.stdout.write(`${payload.name}\n  ${measure(encoding, text)}\n`);
}
