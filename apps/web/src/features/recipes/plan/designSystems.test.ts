import assert from "node:assert/strict";
import { test } from "node:test";
import type { SystemDraft } from "./recipeDraft";
import {
  isOperatorSystem,
  isPendingQuestion,
  operatorActions,
  operatorSystemsForRole,
  pendingDesignQuestions,
  systemCards,
} from "./designSystems";
import { planFromRecipe } from "./planModel";
import { deskRecipe } from "./planFixtures";

test("operator and pending-question systems are told apart", () => {
  assert.equal(isOperatorSystem({ resolution: "browser" }), true);
  assert.equal(isOperatorSystem({ kind: "script", resolution: "decision" }), true);
  assert.equal(
    isOperatorSystem({ resolution: "decision", reason: "Operator must take control" }),
    true,
  );
  assert.equal(isOperatorSystem({ resolution: "catalog", reason: "take-control" }), false);
  assert.equal(isPendingQuestion({ resolution: "decision" }), true);
  assert.equal(isPendingQuestion({ resolution: "decision", accepted: true }), false);
  assert.equal(
    isPendingQuestion({ resolution: "refused", reason: "Open question: which CRM?" }),
    true,
  );
  assert.equal(isPendingQuestion({ resolution: "browser" }), false);
  assert.equal(isPendingQuestion({ resolution: "native" }), false);
  assert.equal(isPendingQuestion({ kind: "catalog", resolution: "decision" }), false);
  assert.equal(isPendingQuestion({ kind: "composition" }), true);
  assert.equal(isOperatorSystem({ kind: "browser" }), true);
  assert.equal(isOperatorSystem({ kind: "native", resolution: "browser" }), false);
  const recipe = deskRecipe();
  recipe.design = {
    systems: [
      { name: "a", resolution: "composition" },
      { name: "b", resolution: "catalog" },
    ],
  };
  assert.deepEqual(
    pendingDesignQuestions({ body: recipe }).map((item) => item.name),
    ["a"],
  );
});

test("operator systems attach by explicit roles, by role name in the text, or to browser roles", () => {
  const recipe = deskRecipe();
  const systems: SystemDraft[] = [
    { name: "Scraper", resolution: "script", roles: ["writer"], reason: "Run the scraper" },
    { name: "Portal", resolution: "browser", reason: "The watcher logs into the portal" },
    { name: "Kiosk", resolution: "browser", reason: "" },
    { name: "Board", resolution: "catalog", server: "crm", reason: "" },
    { name: "Wiki", resolution: "native", reason: "Native notes" },
    { name: "Choice", resolution: "decision", reason: "" },
  ];
  recipe.design = { ...recipe.design, systems };
  const plan = planFromRecipe(recipe);
  assert.deepEqual(
    operatorSystemsForRole(plan, "writer").map((item) => item.name),
    ["Scraper"],
  );
  assert.deepEqual(
    operatorSystemsForRole(plan, "watcher").map((item) => item.name),
    ["Portal", "Kiosk"],
  );
  assert.deepEqual(operatorSystemsForRole(plan, " "), []);

  const watcher = operatorActions(plan.agents[0]!, plan);
  assert.equal(
    watcher?.browser?.instructions,
    "Take control of this agent's browser and log into the intended account.",
  );
  assert.deepEqual(watcher?.browser?.notes, ["The watcher logs into the portal", "Kiosk"]);
  assert.deepEqual(watcher?.cards, []);
  const writer = operatorActions(plan.agents[1]!, plan);
  assert.equal(writer?.browser, null);
  assert.deepEqual(writer?.cards, [{ title: "Scraper", text: "Run the scraper" }]);

  assert.deepEqual(
    systemCards(plan).map((item) => [item.name, item.resolution]),
    [["Wiki", "native"]],
  );
  const withoutCrm = { ...plan, connections: [] };
  assert.deepEqual(
    systemCards(withoutCrm).map((item) => item.name),
    ["Board", "Wiki"],
  );
});
