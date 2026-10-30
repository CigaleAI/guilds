import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_MEMORY } from "../../src/artifacts/memory.js";
import { renderMemorySection } from "../../src/memory/index.js";
import {
  PromptError,
  STATE_INTRO,
  TASK_INTRO,
  composeSystemPrompt,
  hydratePrompts,
  promptHash,
  standingForCapabilities,
  stateIntroForCapabilities,
  taskIntroForCapabilities,
} from "../../src/prompts/index.js";
import { LOW_TOOL_CALL_BUDGET } from "../../src/toolbox/index.js";
import { loadJsonFixture, loadTextFixture, templatesRoot } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/env.js";

const hashes = loadJsonFixture<{
  abc: string;
  composed: string;
  task_intro_present: boolean;
  state_intro_present: boolean;
}>("prompts/hashes.json");
const hydrate = loadJsonFixture<{
  identity: string;
  wikilink_system: string;
  wikilink_task: string;
  missing_system: string;
  missing_task: string;
}>("prompts/hydrate.json");

class ExpandNotes {
  expandWikilinks(text: string, orgSlug: string, guildName: string, _agentName: string): string {
    return text.replace("[[hello-guild]]", `[[orgs/${orgSlug}/guilds/${guildName}/shared/hello-guild]]`);
  }
}

test("prompt_hash is stable and matches the R0 fixture", () => {
  assert.equal(promptHash("abc"), hashes.abc);
  assert.equal(promptHash("abc"), promptHash("abc"));
  assert.notEqual(promptHash("abc"), promptHash("abd"));
});

test("hydrate reads task.md and ignores a per-agent system.md", () => {
  const root = tempDir("guilds-prompts-");
  const agent = path.join(root, "guilds", "research", "agents", "researcher");
  mkdirSync(agent, { recursive: true });
  const systemTemplate = path.join(templatesRoot(), "system.md");
  const taskTemplate = path.join(templatesRoot(), "task.md");
  writeFileSync(path.join(agent, "task.md"), readFileSync(taskTemplate, "utf8"));
  writeFileSync(path.join(agent, "system.md"), "per-agent override must be ignored");
  const systemPath = path.join(root, "system.md");
  writeFileSync(systemPath, readFileSync(systemTemplate, "utf8"));
  const [system, task] = hydratePrompts(agent, { systemPath, includeTask: true });
  assert.equal(system, readFileSync(systemTemplate, "utf8"));
  assert.equal(task, readFileSync(taskTemplate, "utf8"));
  const [systemOnly, missing] = hydratePrompts(agent, { systemPath, includeTask: false });
  assert.equal(systemOnly, system);
  assert.equal(missing, null);
});

test("hydrate attaches agent name and id", () => {
  const root = tempDir("guilds-prompts-");
  const agent = path.join(root, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(path.join(agent, "task.md"), "Do the work.\n");
  const systemPath = path.join(root, "system.md");
  writeFileSync(systemPath, "# Guidelines\n\nBe brief.\n");
  const [system, task] = hydratePrompts(agent, {
    systemPath,
    includeTask: true,
    agentName: "researcher",
    agentId: "a_1",
  });
  assert.equal(system, hydrate.identity);
  assert.equal(task, "Do the work.\n");
});

test("hydrate expands wikilinks", () => {
  const root = tempDir("guilds-prompts-");
  const agent = path.join(root, "agent");
  mkdirSync(agent, { recursive: true });
  const systemPath = path.join(root, "system.md");
  writeFileSync(systemPath, "See [[hello-guild]] in guidelines.\n");
  writeFileSync(path.join(agent, "task.md"), "Write every sentence to [[hello-guild]].\n");
  const [system, task] = hydratePrompts(agent, {
    systemPath,
    includeTask: true,
    notes: new ExpandNotes(),
    orgSlug: "acme",
    guildName: "research",
    agentName: "researcher",
  });
  assert.equal(system, hydrate.wikilink_system);
  assert.equal(task, hydrate.wikilink_task);
});

test("hydrate missing files", () => {
  const root = tempDir("guilds-prompts-");
  const agent = path.join(root, "agent");
  mkdirSync(agent);
  const systemPath = path.join(root, "system.md");
  assert.throws(
    () => hydratePrompts(agent, { systemPath, includeTask: true }),
    (error: Error) => error instanceof PromptError && error.message === hydrate.missing_system,
  );
  writeFileSync(systemPath, "# Guidelines\n\nBe brief.\n");
  assert.throws(
    () => hydratePrompts(agent, { systemPath, includeTask: true }),
    (error: Error) => error instanceof PromptError && error.message === hydrate.missing_task,
  );
  const [systemOnly, missing] = hydratePrompts(agent, { systemPath, includeTask: false });
  assert.equal(systemOnly, "# Guidelines\n\nBe brief.\n");
  assert.equal(missing, null);
});

test("hydrate compose is exact against the R0 fixture", () => {
  const root = tempDir("guilds-prompts-");
  const agent = path.join(root, "agent");
  mkdirSync(agent);
  writeFileSync(path.join(agent, "task.md"), "Do the work.\n");
  const systemPath = path.join(root, "system.md");
  writeFileSync(systemPath, "# Guidelines\n\nBe brief.\n");
  const [standing, task] = hydratePrompts(agent, {
    systemPath,
    includeTask: true,
    agentName: "researcher",
    agentId: "a_1",
  });
  const composed = composeSystemPrompt(
    standing,
    task ?? "",
    { group: { members: [], history: [] } },
    EMPTY_MEMORY,
  );
  assert.equal(task, "Do the work.\n");
  assert.equal(composed, loadTextFixture("prompts/compose.txt"));
  assert.equal(promptHash(composed), hashes.composed);
  assert.equal(hashes.task_intro_present, composed.includes(TASK_INTRO));
  assert.equal(hashes.state_intro_present, composed.includes(STATE_INTRO));
});

test("system template explains special messages", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  assert.ok(text.startsWith("You are an agent in a work guild"));
  assert.ok(text.includes("opening\nsystem message"));
  assert.ok(text.includes("last 10 public group"));
  assert.ok(text.includes("one canonical home"));
  assert.ok(text.includes("search the likely destination"));
  assert.ok(text.includes("Run history and group history are the canonical record"));
  assert.ok(text.includes("Do not `group_post` unless"));
  assert.ok(text.includes("Call `report_issue` when"));
  assert.ok(text.includes("compare the requested action with your Task"));
  assert.ok(text.includes("A public reply or update requires"));
  assert.ok(text.includes("shortest text that finishes your Task"));
  assert.ok(text.includes("ELI5"));
  assert.ok(text.includes("focused coordination surface"));
  assert.ok(text.includes("Group Chat info:"));
  assert.ok(text.includes('"youWereTagged"'));
  assert.ok(text.includes("Schedule wake-up:"));
  assert.ok(text.includes('"cron"'));
  assert.ok(text.includes('"instruction"'));
  assert.ok(text.includes("one-line label"));
  assert.ok(text.includes("schedule_create_cron"));
  assert.ok(text.includes("schedule_create_window"));
  assert.ok(text.includes("script_create"));
  assert.ok(text.includes("browser_navigate"));
  assert.ok(text.includes("browser_scroll"));
  assert.ok(text.includes("browser_eval"));
  assert.ok(text.includes("note_find"));
  assert.ok(text.includes("note_get"));
  assert.ok(text.includes("record_search"));
  assert.ok(text.includes("record_list"));
  assert.ok(text.includes("record_add"));
  assert.ok(text.includes("record_update"));
  assert.ok(text.includes("record_remove"));
  assert.ok(!text.includes("object_put"));
  assert.ok(!text.includes("collection_create"));
  assert.ok(!text.includes("observed_at"));
  assert.ok(text.includes("Never\ninvent an id") || text.includes("Never invent an id"));
  assert.ok(text.includes("must end in"));
  assert.ok(text.includes("Notes have no folders"));
  assert.ok(!text.includes("history-archive"));
  assert.ok(text.includes("max_tool_calls"));
  assert.ok(text.includes("utc_now"));
  assert.ok(text.includes("utc_date"));
  assert.ok(text.includes("Do not guess the current date"));
  assert.ok(text.includes("remaining_tool_calls: N"));
  assert.ok(text.includes(`${LOW_TOOL_CALL_BUDGET} or fewer`));
  assert.ok(text.includes("Do not fire a batch larger"));
  assert.ok(text.includes("Call only the tools this run offered"));
  assert.ok(text.includes("When this run offers script tools"));
  assert.ok(text.includes("json.load(sys.stdin)"));
  assert.ok(text.includes('<capability name="notes">'));
  assert.ok(text.includes('<capability name="scripts">'));
  assert.ok(text.includes('<capability name="browser_standard">'));
  assert.ok(text.includes('<capability name="browser_optimized">'));
  assert.ok(text.includes('<capability name="memory">'));
});

test("standing omits script notes and browser guides when those capabilities are off", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const off = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
    coding: false,
  });
  assert.ok(!off.includes("script_create"));
  assert.ok(!off.includes("browser_navigate"));
  assert.ok(!off.includes("note_find"));
  assert.ok(!off.includes("note_write"));
  assert.ok(!off.includes("<capability"));
  assert.ok(off.includes("record_search"));
  const on = standingForCapabilities(text, {
    scripts: true,
    notes: true,
    browser: true,
    coding: false,
  });
  assert.ok(on.includes("script_create"));
  assert.ok(on.includes("note_find"));
  assert.ok(on.includes("browser_navigate"));
  assert.ok(on.includes("browser_scroll"));
  assert.ok(on.includes("browser_eval"));
  assert.ok(on.includes("A script is the only way to execute code"));
  assert.ok(!on.includes("shell_status"));
  assert.ok(!on.includes("<capability"));
});

test("the browser renders the block of its mode and never both", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const caps = { scripts: false, notes: false, browser: true, coding: false };
  const standard = standingForCapabilities(text, caps);
  assert.ok(standard.includes("browser_navigate"));
  assert.ok(standard.includes("browser_eval"));
  assert.ok(!standard.includes("`browse`"));
  assert.ok(!standard.includes("needs_confirmation"));
  assert.ok(!standard.includes("<capability"));
  assert.equal(standingForCapabilities(text, { ...caps, browserOptimized: false }), standard);
  const optimized = standingForCapabilities(text, { ...caps, browserOptimized: true });
  assert.ok(optimized.includes("`browse`"));
  assert.ok(optimized.includes("browser_eval"));
  assert.ok(optimized.includes("`authorize: true`"));
  assert.ok(optimized.includes("needs_confirmation"));
  assert.ok(optimized.includes("needs_login"));
  assert.ok(!optimized.includes("browser_navigate"));
  assert.ok(!optimized.includes("browser_scroll"));
  assert.ok(!optimized.includes("<capability"));
  const off = standingForCapabilities(text, { ...caps, browser: false, browserOptimized: true });
  assert.ok(!off.includes("`browse`"));
  assert.ok(!off.includes("browser_eval"));
});

test("the coding block replaces the scripts-only line for coding agents", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const coding = standingForCapabilities(text, {
    scripts: true,
    notes: true,
    browser: false,
    coding: true,
  });
  assert.ok(coding.includes("shell_status"));
  assert.ok(coding.includes("code_task"));
  assert.ok(!coding.includes("file_edit"));
  assert.ok(coding.includes("run one-off commands with `shell`"));
  assert.ok(!coding.includes("A script is the only way to execute code"));
  assert.ok(!coding.includes("<capability"));
  const noScripts = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
    coding: true,
  });
  assert.ok(noScripts.includes("shell_status"));
  assert.ok(!noScripts.includes("script_create"));
  assert.ok(!noScripts.includes("<capability"));
});

test("standing omits memory guides when memory is off", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const off = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
    coding: false,
    memory: false,
  });
  assert.ok(!off.includes("memory_write"));
  assert.ok(!off.includes("private place for what your future runs need"));
  assert.ok(off.includes("Task and State are supplied"));
  assert.ok(!off.includes("Task, State, and Memory"));
  assert.ok(!off.includes("<capability"));
  const on = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
    coding: false,
    memory: true,
  });
  assert.ok(on.includes("memory_write"));
  assert.ok(on.includes("private place for what your future runs need"));
  assert.ok(on.includes("Task, State, and Memory"));
  const writeOff = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
    coding: false,
    memory: true,
    memoryWrite: false,
  });
  assert.ok(!writeOff.includes("memory_write"));
  assert.ok(writeOff.includes("private place for what your future runs need"));
  assert.ok(writeOff.includes("Task, State, and Memory"));
  assert.ok(!writeOff.includes("<capability"));
});

test("compose omits the memory section when memory is off", () => {
  const caps = {
    scripts: true,
    notes: true,
    browser: false,
    coding: false,
    memory: false,
  };
  const composed = composeSystemPrompt(
    "You are an agent in a guild.\n",
    "Assist the user.\n",
    { group: { members: [], history: [] } },
    EMPTY_MEMORY,
    caps,
  );
  assert.ok(!composed.includes("<memory>"));
  assert.ok(!composed.includes("memory_write"));
  assert.ok(composed.includes("<task>"));
  assert.equal(taskIntroForCapabilities(caps), TASK_INTRO.replace("; it is not yours to edit with memory_write", ""));
  assert.equal(taskIntroForCapabilities({ ...caps, memory: true }), TASK_INTRO);
});

test("compose keeps memory but omits memory_write when the write tool is off", () => {
  const caps = {
    scripts: true,
    notes: true,
    browser: false,
    coding: false,
    memory: true,
    memoryWrite: false,
  };
  const composed = composeSystemPrompt(
    "You are an agent in a guild.\n",
    "Assist the user.\n",
    { group: { members: [], history: [] } },
    EMPTY_MEMORY,
    caps,
  );
  assert.ok(composed.includes("<memory>"));
  assert.ok(!composed.includes("memory_write"));
  assert.ok(composed.includes("private place for whatever"));
  assert.equal(taskIntroForCapabilities(caps), TASK_INTRO.replace("; it is not yours to edit with memory_write", ""));
});

test("state intro omits note and script lines when those capabilities are off", () => {
  const off = stateIntroForCapabilities({
    scripts: false,
    notes: false,
    browser: false,
    coding: false,
  });
  assert.ok(off.includes("initial record_list"));
  assert.ok(!off.includes("note_find"));
  assert.ok(!off.includes("file_find"));
  assert.ok(!off.includes("script_list"));
  assert.ok(!off.includes("scripts/<name>.py"));
  const on = stateIntroForCapabilities({
    scripts: true,
    notes: true,
    files: true,
    browser: true,
    coding: false,
  });
  assert.equal(on, STATE_INTRO);
});

test("compose_system_prompt has four parts", () => {
  const composed = composeSystemPrompt(
    "You are an agent in a guild.\n",
    "Assist the user.\n",
    {
      group: { members: [], history: [] },
      shared: [],
      notes: [],
      scripts: [],
      environment: [],
    },
    EMPTY_MEMORY,
  );
  assert.ok(composed.startsWith("<guidelines>"));
  assert.ok(composed.includes("</guidelines>"));
  assert.ok(composed.includes("<task>"));
  assert.ok(composed.includes("Assist the user."));
  assert.ok(composed.includes("<state>"));
  assert.ok(composed.includes('"group"'));
  assert.ok(composed.includes('"history"'));
  assert.ok(composed.includes('"shared"'));
  assert.ok(composed.includes('"notes"'));
  assert.ok(composed.includes('"scripts"'));
  assert.ok(composed.includes('"environment"'));
  assert.ok(composed.includes("max_tool_calls"));
  assert.ok(composed.includes("utc_now"));
  assert.ok(composed.includes("utc_date"));
  assert.equal(composed.split("<memory>").length - 1, 1);
  assert.ok(composed.includes("memory_write"));
  assert.ok(composed.indexOf("<task>") < composed.indexOf("<state>"));
  assert.ok(composed.indexOf("<state>") < composed.indexOf("<memory>"));
  assert.ok(composed.includes("There is no required format"));
  assert.ok(!composed.includes("## Rules"));
  assert.ok(!composed.includes("## Facts"));
  assert.ok(!composed.includes("## Pending"));
  assert.ok(renderMemorySection(EMPTY_MEMORY).includes("<memory>"));
});
