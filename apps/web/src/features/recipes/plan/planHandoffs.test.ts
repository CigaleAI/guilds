import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffChart } from "./planHandoffs";
import { planFromRecipe } from "./planModel";
import { deskRecipe } from "./planFixtures";

test("handoffChart groups handoffs per pair and falls back on the role for unknown agents", () => {
  const chart = handoffChart(planFromRecipe(deskRecipe()));
  assert.deepEqual(
    chart.nodes.map((node) => [node.role, node.name, Boolean(node.agent)]),
    [
      ["watcher", "desk-watcher", true],
      ["writer", "writer", true],
      ["editor", "editor", false],
    ],
  );
  assert.deepEqual(
    chart.rows.map((row) => [row.from.role, row.to.role, row.vias.map((via) => via.label)]),
    [
      ["watcher", "writer", ["post-queue", "tagged · 3"]],
      ["writer", "editor", ["tagged"]],
    ],
  );
});
