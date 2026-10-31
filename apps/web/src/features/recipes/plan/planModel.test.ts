import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplyPreview, RecipeRow } from "../../../api/types/recipes";
import { planFromRecipe } from "./planModel";
import { builder, deskRecipe, operator } from "./planFixtures";

test("planFromRecipe shapes agents with defaults, enabled tools, and routines", () => {
  const plan = planFromRecipe(deskRecipe());
  const [watcher, writer] = plan.agents;
  assert.ok(watcher && writer);
  assert.equal(watcher.name, "desk-watcher");
  assert.equal(watcher.model, "fast-model");
  assert.equal(watcher.browser, true);
  assert.deepEqual(watcher.nativeTools, ["note_find"]);
  assert.deepEqual(watcher.taskAuthor, builder);
  assert.equal(watcher.routines[0]?.source, "schedule");
  assert.equal(watcher.routines[0]?.window, null);
  assert.equal(writer.name, "writer");
  assert.equal(writer.avatar_shape, "teardrop");
  assert.equal(writer.avatar_color, "#7c5cff");
  assert.equal(writer.model, "");
  assert.equal(writer.browser, false);
  assert.deepEqual(
    plan.routines.map((item) => item.key),
    ["watch-feed"],
  );
  assert.deepEqual(plan.scripts, [
    {
      role: "watcher",
      name: "scrape",
      description: "Scrape a page",
      author: operator,
      source: "print(1)",
    },
  ]);
  assert.deepEqual(plan.counts, {
    agents: 2,
    collections: 1,
    notes: 1,
    scripts: 1,
    routines: 1,
    connections: 1,
    secrets: 1,
  });
  assert.deepEqual(plan.guild, {
    name: "Desk",
    about: "Watches posts",
    objective: "Draft replies",
    groupLimit: 200,
  });
});

test("planFromRecipe falls back on the guild slug, the created guild, and the meta description", () => {
  const plan = planFromRecipe(
    {
      guild: { name_suggestion: "", about: "", objective: "", group_agent_message_limit: 5 },
      meta: { description: "From meta" },
    },
    { creates: { guild: { name: "created", about: "", objective: "Created goal" } } },
  );
  assert.deepEqual(plan.guild, {
    name: "created",
    about: "From meta",
    objective: "Created goal",
    groupLimit: 5,
  });
});

test("the API's row and preview shapes feed the plan directly", () => {
  const body = deskRecipe();
  const row = { id: "r1", status: "ready", body } as unknown as RecipeRow;
  const preview: Pick<ApplyPreview, "creates" | "connections" | "secrets"> = {
    creates: {
      guild: { name: "desk", about: "", objective: "" },
      agents: [],
      collections: [],
      notes: [],
      scripts: [],
      routines: [],
      repositories: [],
      connections: [
        {
          server: "crm",
          auth: "oauth",
          recommended_scope: "guild",
          reusable: [{ id: "conn_1", owner_scope: "org", status: "connected" }],
          action: "reuse",
          connection_id: "conn_1",
          setup: "",
          resources: [],
        },
      ],
      secrets: [
        {
          name: "API_KEY",
          description: "",
          collision: true,
          action: "reuse",
          dest_name: "API_KEY",
          recommended_scope: "guild",
        },
      ],
    },
    connections: [],
    secrets: [],
  };
  const plan = planFromRecipe(row, preview);
  assert.equal(plan.guild.name, "Desk");
  assert.equal(plan.actions.find((item) => item.server === "crm")?.kind, "reuse");
  assert.equal(plan.actions.find((item) => item.kind === "secret")?.required, false);
  assert.equal(plan.routines.length, 1);
});
