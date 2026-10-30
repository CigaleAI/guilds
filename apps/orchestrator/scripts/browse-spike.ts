// Run one fastbrowse task on an agent's sandbox Chrome through the CDP bridge, and print each
// step, the result, and its cost lines. The task drives the Chrome the Browser tab shows.
//
//   pnpm browse:spike -- <agent id>           AGENT_ID names the agent when no argument does
//   pnpm browse:spike -- <agent id> --probe   stop after /json/version through the bridge
//
// TASK is the task. fastbrowse runs with the environment a browse call gives it (src/browse/env.ts):
// TYPESAFE_API_KEY is its Jev key, and it plans and reads with BROWSER_MODEL, else the agent's
// browser_model, on BROWSER_MODEL_API_KEY at BROWSER_MODEL_BASE_URL when set. The script reads the
// agent and does not migrate the database.
import { Fastbrowse, type BrowserEvent, type StepEvent } from "fastbrowse";
import { openCdpBridge, type CdpBridge } from "../src/browse/bridge.js";
import { fastbrowseEnv } from "../src/browse/env.js";
import { loadToolConfig } from "../src/config/index.js";
import { getAgent } from "../src/db/agents.js";
import { createPool } from "../src/db/client.js";
import { agentMachine, agentSeat } from "../src/generation/machines.js";
import { prepareBrowserWorkspace, RunSandboxes } from "../src/sandbox/index.js";

const DEFAULT_TASK = "Open https://example.com and tell me the page heading";

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The environment a browse call of `browserModel` runs fastbrowse with, its keys from this process's. */
function spikeFastbrowseEnv(browserModel: string | null): Record<string, string> {
  const model = process.env.BROWSER_MODEL || browserModel;
  if (!model) {
    throw new Error("a browser model is required: BROWSER_MODEL or the agent's browser_model");
  }
  const baseURL = process.env.BROWSER_MODEL_BASE_URL;
  return fastbrowseEnv(process.env.TYPESAFE_API_KEY ?? "", model, {
    apiKey: process.env.BROWSER_MODEL_API_KEY ?? "",
    ...(baseURL ? { baseURL } : {}),
  });
}

function printEvent(event: StepEvent | BrowserEvent): void {
  if (event.type === "browser") {
    print(`browser open (live_url ${event.live_url ?? "-"})`);
    return;
  }
  const { step } = event;
  print(
    `step ${step.index} ${step.operation} ${step.outcome} target=${step.target ?? "-"} url=${step.url}`
      + (step.note ? ` note=${step.note}` : ""),
  );
}

async function printJsonVersion(bridge: CdpBridge): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/json/version`);
  print(`/json/version through the bridge (${response.status}):`);
  print(await response.text());
}

async function runTask(bridge: CdpBridge, task: string, env: Record<string, string>): Promise<void> {
  // cdpPort attaches to the Chrome already running behind the bridge, and fastbrowse refuses
  // `local` beside it.
  const fastbrowse = await Fastbrowse.start({
    cdpPort: bridge.port,
    attach: true,
    foreground: true,
    env,
  });
  try {
    print(`fastbrowse ${fastbrowse.fastbrowseVersion}: ${task}`);
    const result = await fastbrowse.run(task, {
      limits: { maxSteps: 8, maxSeconds: 120 },
      onEvent: printEvent,
    });
    print(`status: ${result.status}`);
    print(`final_url: ${result.final_url ?? "-"}`);
    print(`answer: ${result.answer ?? "-"}`);
    if (result.error) {
      print(`error: ${result.error}`);
    }
    for (const line of result.cost.lines) {
      print(
        `cost ${line.component}/${line.purpose ?? "-"} ${line.basis} $${line.dollars ?? "?"} `
          + `in=${line.input_tokens} out=${line.output_tokens} s=${line.seconds ?? "-"}`,
      );
    }
  } finally {
    await fastbrowse.close();
  }
}

const args = process.argv.slice(2);
const probe = args.includes("--probe");
const agentId = args.find((arg) => !arg.startsWith("--")) ?? process.env.AGENT_ID ?? "";
if (!agentId) {
  throw new Error("an agent id is required: browse-spike <agent id> or AGENT_ID");
}
const config = loadToolConfig();
const pool = await createPool(config.databaseUrl, (error) => {
  process.stderr.write(`database: ${error.message}\n`);
});
const sandboxes = new RunSandboxes({
  url: config.opensandboxUrl,
  apiKey: config.opensandboxApiKey,
  image: config.sandboxImage,
  workspaceRoot: config.workspaceRoot,
});
try {
  const agent = await getAgent(pool, agentId);
  if (agent === null) {
    throw new Error(`agent ${agentId} does not exist`);
  }
  if (!agent.config.browser) {
    throw new Error(`agent ${agentId} has no browser`);
  }
  await sandboxes.start();
  const machine = agentMachine(agent);
  prepareBrowserWorkspace(config.workspaceRoot, machine.id, agent.id);
  const sandbox = await sandboxes.ensure(machine);
  await sandboxes.startBrowser(sandbox, agentSeat(agent));
  const target = await sandboxes.cdpTarget(sandbox, agentSeat(agent));
  print(`relay: ${target[0]}`);
  const bridge = await openCdpBridge(target);
  try {
    await printJsonVersion(bridge);
    if (!probe) {
      await runTask(bridge, process.env.TASK || DEFAULT_TASK, spikeFastbrowseEnv(agent.config.browser_model));
    }
  } finally {
    await bridge.close();
  }
} finally {
  await sandboxes.close();
  await pool.end();
}
