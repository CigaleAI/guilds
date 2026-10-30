import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecipeDraft } from "./recipeDraft";
import { cadenceLabel, routineView, scheduleCadence } from "./planRoutines";
import { planFromRecipe } from "./planModel";
import { deskRecipe } from "./planFixtures";

test("cadenceLabel describes cron expressions without the UTC suffix", () => {
  assert.equal(cadenceLabel("5 * * * *"), "At minute 05 past every hour");
  assert.equal(cadenceLabel("35 */3 * * *"), "At minute 35 past every 3 hours");
  assert.equal(cadenceLabel("*/15 * * * *"), "Every 15 minutes");
  assert.equal(cadenceLabel("0 * * * *"), "Every hour");
  assert.equal(cadenceLabel("* * * * *"), "Every minute");
  assert.equal(cadenceLabel("0 9 * * 1"), "At 09:00 on Monday");
  assert.equal(cadenceLabel("0 9,18 * * *"), "At 09:00 and 18:00 every day");
  assert.equal(cadenceLabel("*/0 * * * *"), "Every 0 minutes");
  assert.equal(cadenceLabel("  every   day "), "every day");
  assert.equal(cadenceLabel(""), "Unspecified cadence");
  assert.equal(cadenceLabel(null), "Unspecified cadence");
});

test("scheduleCadence prefers the wake window over the cron", () => {
  const window = { timezone: "Europe/Paris", start: "09:00", end: "17:00", max_wakes: 2 };
  assert.equal(
    scheduleCadence(window, "0 * * * *"),
    "Up to 2 random wake-ups between 09:00 and 17:00 every day (Europe/Paris)",
  );
  assert.equal(scheduleCadence(null, "0 * * * *"), "Every hour");
});

test("design routines surface only with a five-field cadence and when the role has no schedules", () => {
  const recipe: RecipeDraft = {
    roles: [{ role: "reader" }],
    design: {
      routines: [
        { key: "read-mail", role: "reader", cadence: "*/15 * * * *", dedupe_collection: "seen" },
        { key: "prose", role: "reader", cadence: "every 15 minutes" },
      ],
    },
  };
  const plan = planFromRecipe(recipe);
  assert.deepEqual(plan.routines, [
    {
      role: "reader",
      key: "read-mail",
      cron: "*/15 * * * *",
      window: null,
      description: "read-mail",
      instruction: "",
      author: null,
      source: "design",
      dedupe_collection: "seen",
    },
  ]);
  assert.equal(routineView(plan.routines[0]!).status, "from design");
});

test("apply routines replace the plan's routine list and fill roles without schedules", () => {
  const plan = planFromRecipe(deskRecipe(), {
    creates: {
      routines: [
        {
          role: "watcher",
          key: "watch-feed",
          cron: "*/15 * * * *",
          window: null,
          description: "",
          instruction: "Look",
        },
        {
          role: "writer",
          key: "write",
          cron: "0 9 * * *",
          window: null,
          description: "Write",
          instruction: "",
        },
      ],
    },
  });
  assert.deepEqual(
    plan.routines.map((item) => [item.key, item.source]),
    [
      ["watch-feed", "apply"],
      ["write", "apply"],
    ],
  );
  assert.equal(plan.agents[0]?.routines[0]?.source, "schedule");
  assert.equal(plan.agents[1]?.routines[0]?.source, "apply");
  const row = routineView(plan.routines[1]!);
  assert.equal(row.cadence, "At 09:00 every day");
  assert.equal(row.status, "paused at create");
  assert.equal(routineView(plan.routines[0]!).description, "Look");
});
