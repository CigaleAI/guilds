import assert from "node:assert/strict";
import { test } from "node:test";
import { accessSection } from "./planConnectors";
import { guildHero, planMachineMinimum, planSections, planTally } from "./planSections";
import { planFromRecipe } from "./planModel";
import { deskRecipe } from "./planFixtures";

test("planTally, planSections, accessSection, and guildHero summarise the plan", () => {
  const plan = planFromRecipe(deskRecipe());
  assert.deepEqual(
    planTally(plan).map((item) => [item.label, item.count, item.section]),
    [
      ["Agents", 2, "agents"],
      ["Connectors", 1, "connectors"],
      ["Routines", 1, "routines"],
      ["Tables", 1, "collections"],
      ["Secrets", 1, "connectors"],
    ],
  );
  assert.deepEqual(accessSection(plan), { count: 2, systems: [], empty: false });
  assert.deepEqual(
    planSections(plan).map((section) => [section.id, section.count, section.open]),
    [
      ["agents", 2, true],
      ["routines", 1, false],
      ["connectors", 2, false],
      ["collections", 1, false],
      ["notes", 1, true],
      ["handoffs", 3, true],
      ["external", 1, true],
    ],
  );

  const empty = planFromRecipe({ roles: [] });
  assert.deepEqual(
    planTally(empty).map((item) => item.label),
    ["Agents"],
  );
  assert.deepEqual(
    planSections(empty).map((section) => [section.id, section.count, section.empty]),
    [
      ["agents", 0, true],
      ["routines", 0, true],
      ["connectors", null, true],
      ["collections", null, true],
      ["notes", null, true],
    ],
  );
  assert.deepEqual(
    planSections(empty, true).map((section) => section.id),
    ["agents"],
  );

  assert.equal(guildHero(plan).goal, "Draft replies");
  const same = planFromRecipe({ guild: { about: "Same", objective: "Same" } });
  assert.deepEqual(guildHero(same), {
    name: "Untitled guild",
    about: "Same",
    groupLimit: 200,
    goal: null,
  });
});

test("a plan needs the largest minimum of its agents, not their sum", () => {
  const plan = planFromRecipe(deskRecipe());
  assert.equal(planMachineMinimum(plan), "1 CPU · 2 GiB");
  assert.equal(planMachineMinimum({ agents: [] }), null);
});
