import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_MEMORY } from "../../src/artifacts/memory.js";
import { renderMemorySection } from "../../src/memory/index.js";
import {
  OWN_TOOL_NAMES,
  PromptError,
  STATE_INTRO,
  TASK_INTRO,
  composeSystemPrompt,
  nameTools,
  formatStateRoster,
  hydratePrompts,
  promptHash,
  standingForCapabilities,
  stateIntroForCapabilities,
  taskIntroForCapabilities,
} from "../../src/prompts/index.js";
import { LOW_TOOL_CALL_BUDGET } from "../../src/toolbox/index.js";
import { loadJsonFixture, loadTextFixture, templatesRoot } from "../helpers/fixtures.js";
import { tempDir } from "../helpers/env.js";
import { emptyRunState } from "../helpers/state.js";

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
    return text.replace(
      "[[hello-guild]]",
      `[[orgs/${orgSlug}/guilds/${guildName}/shared/hello-guild]]`,
    );
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
  const composed = composeSystemPrompt(standing, task ?? "", emptyRunState(), EMPTY_MEMORY);
  assert.equal(task, "Do the work.\n");
  assert.equal(composed, loadTextFixture("prompts/compose.txt"));
  assert.equal(promptHash(composed), hashes.composed);
  assert.equal(hashes.task_intro_present, composed.includes(nameTools(TASK_INTRO, OWN_TOOL_NAMES)));
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
  assert.ok(text.includes("It is only for coordination"));
  assert.ok(text.includes("handing a task to another agent"));
  assert.ok(text.includes("asking another agent for help"));
  assert.ok(text.includes("asking another agent a question"));
  assert.ok(text.includes("talking with an operator"));
  assert.ok(text.includes("Call `<tool>report_issue</tool>` when"));
  assert.ok(text.includes("compare the requested action with your Task"));
  assert.ok(text.includes("Work products stay in their canonical artifact"));
  assert.ok(text.includes("ELI5"));
  assert.ok(text.includes("every agent in this guild with its purpose"));
  assert.ok(text.includes("Work toward that goal relentlessly"));
  assert.ok(text.includes("group.about"));
  assert.ok(text.includes("group.description"));
  assert.ok(text.includes("Group Chat info:"));
  assert.ok(text.includes('"youWereTagged"'));
  assert.ok(text.includes("Schedule wake-up:"));
  assert.ok(text.includes('"cron"'));
  assert.ok(text.includes('"instruction"'));
  assert.ok(!text.includes("object_put"));
  assert.ok(!text.includes("collection_create"));
  assert.ok(!text.includes("observed_at"));
  assert.ok(!text.includes("history-archive"));
  assert.ok(!text.includes("note_find"));
  assert.ok(!text.includes("note_write"));
  assert.ok(!text.includes("record_search"));
  assert.ok(!text.includes("record_list"));
  assert.ok(!text.includes("schedule_create_cron"));
  assert.ok(!text.includes("browser_navigate"));
  assert.ok(!text.includes("browser_snapshot"));
  assert.ok(!text.includes("script_create"));
  assert.ok(text.includes("max_tool_calls"));
  assert.ok(text.includes("utc_now"));
  assert.ok(text.includes("utc_date"));
  assert.ok(text.includes("Do not guess the current date"));
  assert.ok(text.includes("remaining_tool_calls: N"));
  assert.ok(text.includes(`${LOW_TOOL_CALL_BUDGET} or fewer`));
  assert.ok(text.includes("Do not fire a batch larger"));
  assert.ok(text.includes("Call only the tools this run offered"));
  assert.ok(text.includes('<capability name="notes">'));
  assert.ok(text.includes('<capability name="scripts">'));
  assert.ok(text.includes('<capability name="memory">'));
  assert.ok(!text.includes('<capability name="browser_standard">'));
  assert.ok(!text.includes('<capability name="browser_optimized">'));
  assert.ok(!text.includes('<capability name="files">'));
});

test("standing omits script and note guides when those capabilities are off", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const off = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
  });
  assert.ok(!off.includes("A script is the only way to execute code"));
  assert.ok(!off.includes("display paths returned by note tools"));
  assert.ok(!off.includes("<capability"));
  const on = standingForCapabilities(text, {
    scripts: true,
    notes: true,
    browser: true,
  });
  assert.ok(on.includes("A script is the only way to execute code"));
  assert.ok(on.includes("display paths returned by note tools"));
  assert.ok(!on.includes("code_task"));
  assert.ok(!on.includes("<capability"));
});

test("standing omits memory guides when memory is off", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const off = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
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
    memory: true,
  });
  assert.ok(on.includes("memory_write"));
  assert.ok(on.includes("private place for what your future runs need"));
  assert.ok(on.includes("Task, State, and Memory"));
  const writeOff = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
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
    memory: false,
  };
  const composed = composeSystemPrompt(
    "You are an agent in a guild.\n",
    "Assist the user.\n",
    emptyRunState(),
    EMPTY_MEMORY,
    caps,
  );
  assert.ok(!composed.includes("<memory>"));
  assert.ok(!composed.includes("memory_write"));
  assert.ok(composed.includes("<task>"));
  assert.equal(
    taskIntroForCapabilities(caps),
    TASK_INTRO.replace("; it is not yours to edit with <tool>memory_write</tool>", ""),
  );
  assert.equal(taskIntroForCapabilities({ ...caps, memory: true }), TASK_INTRO);
});

test("compose keeps memory but omits memory_write when the write tool is off", () => {
  const caps = {
    scripts: true,
    notes: true,
    browser: false,
    memory: true,
    memoryWrite: false,
  };
  const composed = composeSystemPrompt(
    "You are an agent in a guild.\n",
    "Assist the user.\n",
    emptyRunState(),
    EMPTY_MEMORY,
    caps,
  );
  assert.ok(composed.includes("<memory>"));
  assert.ok(!composed.includes("memory_write"));
  assert.ok(composed.includes("private place for whatever"));
  assert.equal(
    taskIntroForCapabilities(caps),
    TASK_INTRO.replace("; it is not yours to edit with <tool>memory_write</tool>", ""),
  );
});

test("state intro omits the scripts line when scripting is off", () => {
  const off = stateIntroForCapabilities({
    scripts: false,
    notes: false,
    browser: false,
  });
  assert.ok(off.includes("Call listing tools later"));
  assert.ok(!off.includes("note_find"));
  assert.ok(!off.includes("file_find"));
  assert.ok(!off.includes("`scripts` are this agent's reusable"));
  const on = stateIntroForCapabilities({
    scripts: true,
    notes: true,
    files: true,
    browser: true,
  });
  assert.equal(on, STATE_INTRO);
});

test("a run that offers no tool drops the tool budget and every part on a tool it does not offer", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const bare = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
    memory: true,
    memoryWrite: false,
    tools: false,
    artifacts: false,
    groupPost: false,
    schedules: false,
    issues: false,
  });
  for (const gone of [
    "remaining_tool_calls",
    "max_tool_calls",
    "listing tools",
    "Call only the tools",
    "memory_write",
    "one canonical home",
    "Use collections for structured records",
    "It is only for coordination",
    "decide who to tag",
    "tag the agent",
    "Schedule wake-up:",
    "report_issue",
    "`shell`",
    "A script",
    "code_task",
    "<capability",
  ]) {
    assert.ok(!bare.includes(gone), gone);
  }
  assert.ok(bare.includes("Use it as your initial context."));
  assert.ok(bare.includes("do the part your domain owns. When those fields are empty"));
  assert.ok(bare.includes("Group Chat info:"), "a group run's opening message is still explained");
  assert.ok(!bare.includes("$GUILDS_PORTS"), "the harness part is for a subscription agent");
});

test("a key agent without group_post, schedules, or report_issue loses only those parts", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const caps = { scripts: false, notes: true, browser: false, coding: false };
  const all = standingForCapabilities(text, caps);
  const without = standingForCapabilities(text, { ...caps, groupPost: false, schedules: false, issues: false });
  assert.ok(all.includes("It is only for coordination") && !without.includes("It is only for coordination"));
  assert.ok(all.includes("Schedule wake-up:") && !without.includes("Schedule wake-up:"));
  assert.ok(all.includes("Call `<tool>report_issue</tool>`") && !without.includes("report_issue"));
  assert.ok(without.includes("remaining_tool_calls: N"));
  assert.ok(without.includes("one canonical home"));
});

test("a subscription agent's harness reads where it runs, its home, and its ports", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const harness = standingForCapabilities(text, {
    scripts: false,
    notes: false,
    browser: false,
    tools: false,
    artifacts: false,
    groupPost: false,
    schedules: false,
    issues: false,
    harness: true,
  });
  assert.ok(harness.includes("in your own Linux container, as root, with\nyour own tools"));
  assert.ok(harness.includes("Your home (`$HOME`) stays between runs"));
  assert.ok(harness.includes("Your turn\n  starts in it."), "without repositories the turn starts in the home");
  assert.ok(harness.includes("A server you start listens on a port of `$GUILDS_PORTS`"));
  assert.ok(harness.includes("Never print their values"));
  assert.ok(!harness.includes("code_task"));
  assert.ok(!harness.includes("State `repositories` lists"), "the repositories part is for an agent that has some");
  assert.ok(!harness.includes("<capability"));
});

const HARNESS_CAPS = {
  scripts: false,
  notes: false,
  browser: false,
  tools: true,
  harness: true,
  repositories: true,
  toolNaming: { prefix: "mcp__guilds__" },
};

test("a subscription agent with repositories reads where they are, how it branches, commits and pushes, and the tool that opens a pull request", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const standing = standingForCapabilities(text, { ...HARNESS_CAPS, pullRequestTool: "github_create_pull_request" });
  assert.ok(standing.includes("You work in the git repositories State `repositories` lists"));
  assert.ok(standing.includes("named `agent/<your name>/<topic>`"));
  assert.ok(standing.includes("Push the branch with `git push origin <branch>`"));
  assert.ok(standing.includes("no `gh` login, and no\n  API token"));
  assert.ok(!standing.includes("Your turn\n  starts in it."), "the repositories part says where the turn starts");
  assert.ok(!standing.includes("<pull_request_tool/>") && !standing.includes("<capability"));
  const composed = composeSystemPrompt(standing, "Ship it.\n", emptyRunState(), EMPTY_MEMORY, HARNESS_CAPS);
  assert.ok(composed.includes("Open the branch's pull request with `mcp__guilds__github_create_pull_request`"), "named as the harness calls it");
  assert.ok(!composed.includes("You have no tool that opens a pull request"));
});

test("a subscription agent with repositories and no pull request tool is told its part ends with the pushed branch, and names no tool", () => {
  const text = readFileSync(path.join(templatesRoot(), "system.md"), "utf8");
  const standing = standingForCapabilities(text, { ...HARNESS_CAPS, pullRequestTool: null });
  assert.ok(standing.includes("You have no tool that opens a pull request: your part ends with the\n  pushed branch."));
  assert.ok(!standing.includes("Open the branch's pull request"));
  assert.ok(!standing.includes("<pull_request_tool/>") && !standing.includes("<capability"));
});

test("the state intro of a run that offers no tool says nothing of listing tools or a tool budget", () => {
  const intro = stateIntroForCapabilities({ scripts: false, notes: false, browser: false, tools: false });
  assert.ok(!intro.includes("listing tools"));
  assert.ok(!intro.includes("tool-invocation budget"));
  assert.ok(intro.startsWith("A snapshot of the guild at the start of this run. Use it as your initial context.\n"));
  assert.ok(intro.includes("`utc_now` is the UTC instant"));
});

test("the State section lists each agent and its purpose", () => {
  const state = emptyRunState();
  state.group.members = [{ name: "researcher", focus: "reads papers" }, { name: "writer" }];
  state.group.operators = [{ name: "alice", role: "admin" }];
  assert.equal(
    formatStateRoster(state),
    [
      "Agents in this guild, each with its purpose (`focus`):",
      "- researcher: reads papers",
      "- writer",
      "",
      "Operators:",
      "- alice (admin)",
    ].join("\n"),
  );
  const composed = composeSystemPrompt("Be brief.\n", "Do the work.\n", state, EMPTY_MEMORY);
  assert.ok(composed.includes("- researcher: reads papers"));
  assert.ok(composed.includes("- alice (admin)"));
  assert.equal(formatStateRoster(emptyRunState()), "");
});

test("compose_system_prompt has four parts", () => {
  const composed = composeSystemPrompt(
    "You are an agent in a guild.\n",
    "Assist the user.\n",
    emptyRunState({ shared: [], notes: [] }),
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

test("a key run's prompt names each tool by its own name, and a subscription run's as its harness calls it", () => {
  const standing = "Call `<tool>report_issue</tool>` when a tool fails.\n";
  const caps = { scripts: false, notes: false, browser: false, coding: false, memory: true };
  const own = composeSystemPrompt(standing, "Assist.\n", emptyRunState(), EMPTY_MEMORY, caps, ["Use `<tool>tavily_search</tool>`."]);
  assert.ok(own.includes("Call `report_issue` when"));
  assert.ok(own.includes("Use `tavily_search`."));
  assert.ok(own.includes("edit with memory_write."), "the Task's intro");
  assert.ok(own.includes("Rewrite it with memory_write."), "the Memory section's");
  assert.ok(!own.includes("<tool>"));
  const harness = composeSystemPrompt(standing, "Assist.\n", emptyRunState(), EMPTY_MEMORY, {
    ...caps,
    toolNaming: { prefix: "mcp__guilds__" },
  }, ["Use `<tool>tavily_search</tool>`."]);
  assert.ok(harness.includes("Call `mcp__guilds__report_issue` when"));
  assert.ok(harness.includes("Use `mcp__guilds__tavily_search`."));
  assert.ok(harness.includes("edit with mcp__guilds__memory_write."));
  assert.ok(harness.includes("Rewrite it with mcp__guilds__memory_write."));
  assert.ok(!harness.includes("<tool>"));
});

test("a tool tag names one tool; other text is left as it is", () => {
  const naming = { prefix: "mcp__guilds__" };
  assert.equal(nameTools("`<tool>note_write</tool>` and <tool>group_post</tool>", naming), "`mcp__guilds__note_write` and mcp__guilds__group_post");
  assert.equal(nameTools("<tool>not a name</tool> <tool></tool>", naming), "<tool>not a name</tool> <tool></tool>");
  assert.equal(nameTools("<tool>my-server_open-pr</tool>", naming), "mcp__guilds__my-server_open-pr", "a connection tool's name keeps its dashes");
  assert.equal(nameTools("`<tool>note_write</tool>`", OWN_TOOL_NAMES), "`note_write`");
});
