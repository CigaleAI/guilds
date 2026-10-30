import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { validateCatalog, type ResolvableBinding } from "../../src/access/index.js";
import { PLATFORM_SEED_TOOLS } from "../../src/access/runtime.js";
import { isOptimizedBrowserOn } from "../../src/agents/config.js";
import { generationLive } from "../../src/generation/completion.js";
import { liveOfferedNames, toolSchemaName, type OfferedToolSettings } from "../../src/generation/offered-tools.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { logWriter } from "../../src/observability/log.js";
import { assertAvailableScriptName } from "../../src/scripts/validation.js";
import { BROWSE_TOOL, BROWSER_TOOLS, OPTIMIZED_BROWSER_TOOLS } from "../../src/toolbox/browser.js";
import { offeredToolNames } from "../../src/toolbox/offered.js";
import { clearInstanceKeys, storeKeys, tempDir } from "../helpers/env.js";
import { AGENT_CONFIG, FakeDB, FakeSandboxes, fakeStream, makeLoop, seededLoop } from "../helpers/generation.js";

const SCOPE = { orgId: "org_1", guildId: "guild_1", agentId: "agent_1" };
const NOTE_BINDING: ResolvableBinding = {
  catalog_kind: "native_tool",
  catalog_id: "note_find",
  scope: "agent",
  scope_id: "agent_1",
  enabled: true,
  connection_id: null,
};
const SETTINGS: OfferedToolSettings = {
  browser: true,
  browserOptimized: false,
  coding: false,
  scripting: true,
  memory: true,
  schedules: true,
  direct: true,
};

const originalStream = generationLive.streamCompletion;

afterEach(() => {
  clearInstanceKeys();
});

after(() => {
  generationLive.streamCompletion = originalStream;
});

/** The `operation` of each JSON log line written while `work` runs. */
async function loggedOperations(work: () => Promise<unknown>): Promise<unknown[]> {
  const chunks: string[] = [];
  const originalWrite = logWriter.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  try {
    await work();
  } finally {
    logWriter.write = originalWrite;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => (JSON.parse(line) as { operation?: unknown }).operation);
}

/** What generations of one run logged, and the tool names the model was offered at each. */
type GeneratedRun = { operations: unknown[]; offered: string[][] };

/**
 * `generations` generations of one run of an agent whose live config is `config`, on a snapshot
 * that froze `frozen`.
 */
async function generateWithLiveConfig(
  config: Record<string, unknown>,
  frozen: readonly string[] = ["browser_navigate"],
  generations = 1,
): Promise<GeneratedRun> {
  const db = new FakeDB({
    model: AGENT_CONFIG.model,
    temperature: 0,
    max_tokens: 32,
    max_steps: 30,
    browser: true,
    tools: frozen.map((name) => ({ type: "function" as const, function: { name, arguments: "{}" } })),
    secrets: [],
  });
  db.agent.config = { ...AGENT_CONFIG, ...config };
  db.bindings = PLATFORM_SEED_TOOLS.map((name) => ({
    id: `bind_${name}`,
    catalog_kind: "native_tool",
    catalog_id: name,
    scope: "platform",
    scope_id: null,
    enabled: true,
    connection_id: null,
  }));
  const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes());
  const stream = fakeStream(db, []);
  const offered: string[][] = [];
  generationLive.streamCompletion = (request) => {
    offered.push((request.tools ?? []).map((tool) => toolSchemaName(tool as Record<string, unknown>)));
    return stream(request);
  };
  const operations = await loggedOperations(async () => {
    for (let generation = 1; generation <= generations; generation += 1) {
      await loop.generator.generate("r_1", generation);
    }
  });
  return { operations, offered };
}

test("the browser offers the step-by-step tools when the agent-optimized browser is off", () => {
  const offered = offeredToolNames(["note_find"], { browser: true });
  assert.deepEqual(offered, ["note_find", ...BROWSER_TOOLS, "report_issue"]);
  assert.ok(!offered.includes(BROWSE_TOOL));
});

test("the agent-optimized browser offers browse and browser_eval in place of the step-by-step tools", () => {
  const offered = offeredToolNames(["note_find"], { browser: true, browserOptimized: true });
  assert.deepEqual(offered, ["note_find", ...OPTIMIZED_BROWSER_TOOLS, "report_issue"]);
  assert.ok(!offered.includes("browser_navigate"));
});

test("the agent-optimized browser offers nothing with the browser off", () => {
  assert.deepEqual(offeredToolNames(["note_find"], { browser: false, browserOptimized: true }), [
    "note_find",
    "report_issue",
  ]);
});

test("a binding cannot add browse or a step-by-step browser tool", () => {
  assert.deepEqual(offeredToolNames(["note_find", BROWSE_TOOL, "browser_click"], {}), ["note_find", "report_issue"]);
  assert.deepEqual(offeredToolNames([BROWSE_TOOL], { browser: true }), [...BROWSER_TOOLS, "report_issue"]);
});

test("browse is neither a binding nor a script name", () => {
  assert.throws(() => validateCatalog("native_tool", BROWSE_TOOL), /browse is not a binding/);
  assert.throws(() => assertAvailableScriptName(BROWSE_TOOL), /collides with a native or connection tool name/);
});

test("the agent-optimized browser is on only with its setting and the System One key", () => {
  assert.equal(isOptimizedBrowserOn({ browser_optimized: true }), false, "the System One key is off");
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
  assert.equal(isOptimizedBrowserOn({ browser_optimized: true }), true);
  assert.equal(isOptimizedBrowserOn({ browser_optimized: false }), false);
});

test("a snapshot that froze browse keeps it while the agent-optimized browser stays on", () => {
  const frozen = new Set(["note_find", ...OPTIMIZED_BROWSER_TOOLS]);
  const live = liveOfferedNames(frozen, [NOTE_BINDING], SCOPE, { ...SETTINGS, browserOptimized: true });
  assert.deepEqual([...live].sort(), [...frozen].sort());
});

test("a snapshot that froze browse loses it when the agent-optimized browser is off", () => {
  const frozen = new Set(["note_find", ...OPTIMIZED_BROWSER_TOOLS]);
  const live = liveOfferedNames(frozen, [NOTE_BINDING], SCOPE, SETTINGS);
  assert.deepEqual([...live].sort(), ["browser_eval", "note_find"]);
});

test("a snapshot keeps its step-by-step browser tools when the agent-optimized browser turns on", () => {
  const frozen = new Set(["note_find", ...BROWSER_TOOLS]);
  const live = liveOfferedNames(frozen, [NOTE_BINDING], SCOPE, { ...SETTINGS, browserOptimized: true });
  assert.deepEqual([...live].sort(), [...frozen].sort());
});

test("turning the browser off withholds the browser tools a snapshot froze", () => {
  const frozen = new Set(["note_find", ...BROWSER_TOOLS]);
  const live = liveOfferedNames(frozen, [NOTE_BINDING], SCOPE, { ...SETTINGS, browser: false });
  assert.deepEqual([...live], ["note_find"]);
});

test("a run warns once across its generations when the agent-optimized browser is on without the System One key", async () => {
  const { operations, offered } = await generateWithLiveConfig(
    { browser: true, browser_optimized: true, browser_model: AGENT_CONFIG.model },
    ["browser_navigate"],
    2,
  );
  assert.ok(offered.length >= 2, "both generations reached the model");
  assert.equal(operations.filter((operation) => operation === "browse.integration_off").length, 1);
});

test("a run that froze browse keeps offering it after the System One key is removed", async () => {
  const { offered } = await generateWithLiveConfig(
    { browser: true, browser_optimized: true, browser_model: AGENT_CONFIG.model },
    [...OPTIMIZED_BROWSER_TOOLS],
  );
  assert.ok(offered.length > 0);
  for (const names of offered) {
    assert.ok(names.includes(BROWSE_TOOL), "browse stays offered and its calls answer the key message");
  }
});

test("a run that froze browse stops offering it once the agent-optimized browser is turned off", async () => {
  const { offered } = await generateWithLiveConfig({ browser: true }, [...OPTIMIZED_BROWSER_TOOLS]);
  assert.ok(offered.length > 0);
  for (const names of offered) {
    assert.ok(!names.includes(BROWSE_TOOL));
    assert.ok(names.includes("browser_eval"));
  }
});

test("a generation does not warn when the agent-optimized browser has its key or is off", async () => {
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
  const keyed = await generateWithLiveConfig({ browser: true, browser_optimized: true, browser_model: AGENT_CONFIG.model });
  assert.ok(!keyed.operations.includes("browse.integration_off"));
  clearInstanceKeys();
  const standard = await generateWithLiveConfig({ browser: true });
  assert.ok(!standard.operations.includes("browse.integration_off"));
});

/** A new run of an agent with the agent-optimized browser on: the tools its snapshot froze and its system prompt. */
async function createdOptimizedRun(): Promise<{ tools: string[]; system: string }> {
  const { loop, db } = await seededLoop();
  loop.generateInBackground = () => undefined;
  db.agent.config = { ...AGENT_CONFIG, browser: true, browser_optimized: true, browser_model: AGENT_CONFIG.model };
  await loop.runs.createRun("a_1", null);
  const snapshot = db.run?.config_snapshot as { tools: Array<Record<string, unknown>> };
  return { tools: snapshot.tools.map(toolSchemaName), system: String(db.create_args?.system_content) };
}

test("a new run with the System One key on freezes browse and the agent-optimized browser's guidance", async () => {
  setInstanceKeys(storeKeys({ "system-one": { api_key: "ts-key" } }));
  const { tools, system } = await createdOptimizedRun();
  for (const name of OPTIMIZED_BROWSER_TOOLS) {
    assert.ok(tools.includes(name), name);
  }
  assert.ok(!tools.includes("browser_navigate"));
  assert.match(system, /`browse` carries out a\s+whole web task/);
  assert.doesNotMatch(system, /`browser_snapshot`/);
  assert.doesNotMatch(system, /<capability/);
});

test("a new run with the System One key off freezes the step-by-step browser tools and their guidance", async () => {
  const { tools, system } = await createdOptimizedRun();
  for (const name of BROWSER_TOOLS) {
    assert.ok(tools.includes(name), name);
  }
  assert.ok(!tools.includes(BROWSE_TOOL));
  assert.match(system, /`browser_snapshot`/);
  assert.doesNotMatch(system, /`browse` carries out/);
  assert.doesNotMatch(system, /<capability/);
});
