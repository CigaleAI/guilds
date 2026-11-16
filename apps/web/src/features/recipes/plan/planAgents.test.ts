import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoleDraft } from "./recipeDraft";
import { agentCard, promptBadge } from "./planAgents";
import { planFromRecipe } from "./planModel";
import { deskRecipe, finding } from "./planFixtures";

test("planFromRecipe reads a task's body and author", () => {
  const role: RoleDraft = { role: "solo", task: { body: "Do the thing." } };
  const [agent] = planFromRecipe({ roles: [role] }).agents;
  assert.equal(agent?.task, "Do the thing.");
  assert.equal(agent?.taskAuthor, null);
  const [authored] = planFromRecipe({
    roles: [{ role: "solo", task: { body: "", author: { by: "operator", reviewed: true } } }],
  }).agents;
  assert.equal(authored?.task, "");
  assert.deepEqual(authored?.taskAuthor, { by: "operator", reviewed: true });
});

test("apply agents stand in when the recipe has no roles", () => {
  const plan = planFromRecipe(
    { roles: [] },
    {
      creates: {
        agents: [
          {
            role: "scout",
            name: "scout-1",
            focus: "",
            model: "m",
            browser: true,
            task: "Scout",
            native_tools: ["web_fetch"],
          },
        ],
        routines: [
          {
            role: "scout",
            key: "scan",
            cron: "0 * * * *",
            window: null,
            description: "",
            instruction: "",
          },
        ],
      },
    },
  );
  const [scout] = plan.agents;
  assert.equal(scout?.name, "scout-1");
  assert.equal(scout?.model, "m");
  assert.equal(scout?.browser, true);
  assert.equal(scout?.task, "Scout");
  assert.deepEqual(scout?.nativeTools, ["web_fetch"]);
  assert.equal(scout?.routines[0]?.source, "schedule");
  assert.equal(plan.routines[0]?.source, "apply");
});

test("agentCard gathers connectors, metrics, prompt, routines, operator steps, and scripts", () => {
  const plan = planFromRecipe(deskRecipe());
  const findings = [
    finding("schedule.missing", "roles.writer.schedules", "warning", "Add a routine"),
  ];
  const watcher = agentCard(plan.agents[0]!, plan, findings);
  assert.deepEqual(watcher.connectors, []);
  assert.equal(watcher.metrics.connectors.label, "0 connectors");
  assert.equal(watcher.metrics.connectors.empty, true);
  assert.deepEqual(
    watcher.capabilities.map((item) => [item.id, item.label]),
    [["browser", "Browser"]],
  );
  assert.equal(watcher.metrics.routines.label, "1 routine");
  assert.deepEqual(watcher.metrics.routines.entries, [
    { key: "watch-feed", cadence: "Every 15 minutes", description: "Check the feed" },
  ]);
  assert.equal(watcher.metrics.tools.label, "1 tool");
  assert.deepEqual(watcher.prompt, {
    text: "Watch the feed and queue posts.",
    badge: "31 chars",
    reviewer: null,
  });
  assert.equal(watcher.routines[0]?.cron, "*/15 * * * *");
  assert.equal(watcher.operator?.browser?.notes.length, 0);
  assert.deepEqual(watcher.scripts, [{ name: "scrape", source: "print(1)", reviewer: "operator" }]);

  const writer = agentCard(plan.agents[1]!, plan, findings);
  assert.equal(writer.connectors.length, 1);
  assert.equal(writer.metrics.connectors.label, "1 connector");
  assert.deepEqual(writer.metrics.connectors.entries, [
    { server: "crm", detail: "oauth · guild · tools: crm_write" },
  ]);
  assert.deepEqual(writer.capabilities, []);
  assert.equal(writer.metrics.routines.warning, "Add a routine");
  assert.equal(writer.metrics.routines.label, "0 routines");
  assert.equal(writer.metrics.tools.empty, true);
  assert.deepEqual(writer.prompt, { text: "", badge: "empty", reviewer: "operator" });
  assert.equal(writer.operator, null);
});

test("promptBadge counts trimmed characters and marks empty", () => {
  assert.equal(promptBadge("  hi  "), "2 chars");
  assert.equal(promptBadge(""), "empty");
});

test("a coding agent lists its harness as a capability, pending until one is named", () => {
  const coder = (harness?: string) =>
    planFromRecipe({
      ...deskRecipe(),
      roles: [
        {
          role: "dev",
          name_suggestion: "dev",
          focus: "",
          config: { model: "m", coding: true, ...(harness ? { harness } : {}) },
          task: { body: "", embeds: [], author: null },
        },
      ],
    });
  const named = coder("codex");
  assert.deepEqual(agentCard(named.agents[0]!, named, []).capabilities, [
    {
      id: "coding",
      label: "Coding · Codex",
      hint: ["Code tasks run on Codex."],
      reviewer: null,
      pending: false,
    },
  ]);
  const unnamed = coder();
  const [coding] = agentCard(unnamed.agents[0]!, unnamed, []).capabilities;
  assert.equal(coding?.label, "Coding · no harness yet");
  assert.equal(coding?.pending, true);
  assert.equal(coder("vim").agents[0]?.harness, null);
  const writer = planFromRecipe({
    roles: [{ role: "w", config: { model: "m", harness: "codex" } }],
  });
  assert.equal(writer.agents[0]?.harness, null);
  assert.equal(writer.agents[0]?.model_source, "key");
});

test("a role with a harness, no model, and no coding runs on a subscription, its harness listed as a capability", () => {
  const plan = planFromRecipe({ roles: [{ role: "w", config: { harness: "codex" } }] });
  const [agent] = plan.agents;
  assert.equal(agent?.model_source, "subscription");
  assert.equal(agent?.harness, "codex");
  assert.deepEqual(agentCard(agent!, plan, []).capabilities, [
    {
      id: "subscription",
      label: "Subscription · Codex",
      hint: ["Every turn runs on Codex, on your own subscription."],
      reviewer: null,
      pending: false,
    },
  ]);
  const coder = planFromRecipe({
    roles: [{ role: "c", config: { coding: true, harness: "codex" } }],
  });
  assert.equal(coder.agents[0]?.model_source, "key", "a coding role is on a key");
});

test("a role's agent lists the repositories its config names, and none for a list that is not one of names", () => {
  const plan = planFromRecipe({
    roles: [
      { role: "w", config: { harness: "cursor", repositories: ["app", "site"] } },
      { role: "x", config: { harness: "cursor", repositories: "app" } },
      { role: "y", config: { harness: "codex" } },
    ],
  });
  assert.deepEqual(plan.agents.map((agent) => agent.repositories), [["app", "site"], [], []]);
});
