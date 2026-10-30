import assert from "node:assert/strict";
import { test } from "node:test";
import { externalCard } from "./planActions";
import { planFromRecipe } from "./planModel";
import { filledPlanSections } from "./planSections";
import { secretCard } from "./planConnectors";
import { deskRecipe } from "./planFixtures";

test("apply secrets replace recipe secrets and reused or skipped ones are not required", () => {
  const plan = planFromRecipe(deskRecipe(), {
    secrets: [
      { name: "API_KEY", dest_name: "FEED_KEY", action: "rename", description: "" },
      { name: "OLD", action: "reuse", recommended_scope: "guild" },
      { name: "SKIP", action: "skip" },
    ],
  });
  const secrets = plan.actions.filter((item) => item.kind === "secret");
  assert.deepEqual(
    secrets.map((item) => [item.title, item.detail, item.required]),
    [
      ["Provide FEED_KEY", "", true],
      ["Provide OLD", "guild", false],
      ["Provide SKIP", "", false],
    ],
  );
  assert.deepEqual(secretCard(plan.secrets[0]!), { name: "FEED_KEY", snippet: "" });
});

test("browser and external actions name the site and fall back on generic titles", () => {
  const plan = planFromRecipe(deskRecipe());
  const browser = plan.actions.find((item) => item.kind === "browser");
  assert.equal(browser?.title, "Take control and log desk-watcher into feed.example");
  assert.match(browser?.detail ?? "", /No native connector/);
  assert.equal(browser?.path, "roles.watcher.browser");
  const external = plan.actions.find((item) => item.kind === "external");
  assert.equal(external?.title, "dns");
  assert.equal(external?.path, "external[0]");
  assert.deepEqual(externalCard(plan.external[0]!), { title: "dns", setup: "Add a TXT record" });
});

test("a recipe's repositories become a section and steps to connect GitHub and add each", () => {
  const plan = planFromRecipe({
    ...deskRecipe(),
    roles: [
      {
        role: "dev",
        name_suggestion: "dev",
        focus: "",
        config: { model: "m", coding: true },
        task: { body: "Fix bugs.", embeds: [], author: null },
      },
    ],
    repositories: [{ name: "api", purpose: "The HTTP service." }],
  });
  assert.equal(plan.agents[0]?.coding, true);
  assert.deepEqual(plan.repositories, [{ name: "api", purpose: "The HTTP service." }]);
  assert.deepEqual(
    plan.actions
      .filter((action) => action.kind === "repository" || action.server === "github")
      .map((action) => action.title),
    ["Connect GitHub", "Add the api repository"],
  );
  const sections = filledPlanSections(plan).map((section) => section.id);
  assert.ok(sections.includes("repositories"));
});

test("a recipe that connects GitHub itself gets no separate GitHub step", () => {
  const plan = planFromRecipe({
    connections: [{ server: "github", setup: "Install the app" }],
    repositories: [{ name: "api" }],
  });
  assert.deepEqual(
    plan.actions.map((action) => [action.kind, action.title]),
    [
      ["connect", "Connect github"],
      ["repository", "Add the api repository"],
    ],
  );
});
