import assert from "node:assert/strict";
import { test } from "node:test";
import { blockingApplySteps, browserLoginAgentIds, checklistFromPlan, configFromRecipeRole, deferLaunchSteps, prepareRecipeForApply, skipApplyChecklistStep } from "../../src/recipes/apply.js";
import { TEST_MODEL } from "../helpers/models.js";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "../../src/agents/validation.js";
import { operatorAuthor, linkedInNotionRecipe, huskLeadMatcherRecipe } from "../helpers/recipe-docs.js";
import { parseRecipe } from "../../src/recipes/schema.js";
import { validateRecipe } from "../../src/recipes/validate.js";

test("ready apply names agents whose browser login was deferred", () => {
  const deferred = deferLaunchSteps([
    { id: "browser:watcher", kind: "browser", role: "watcher", status: "open" },
    { id: "browser:writer", kind: "browser", role: "writer", status: "confirmed", resolution: "done" },
    { id: "activate", kind: "activate", status: "open" },
  ]);
  assert.deepEqual(
    browserLoginAgentIds({
      status: "ready",
      plan: { names: [{ role: "watcher", agent_id: "a_watch" }, { role: "writer", agent_id: "a_write" }] },
      checklist: deferred,
    }),
    ["a_watch"],
  );
  assert.deepEqual(
    browserLoginAgentIds({
      status: "checklist",
      plan: { names: [{ role: "watcher", agent_id: "a_watch" }] },
      checklist: deferred,
    }),
    [],
  );
  assert.deepEqual(browserLoginAgentIds(null), []);
});

test("apply checklist defers browser login until after apply", () => {
  const recipe = linkedInNotionRecipe(operatorAuthor());
  const steps = checklistFromPlan(recipe, {
    connections: [{ server: "notion", action: "create", setup: "Connect Notion." }],
    secrets: [],
  });
  const browser = steps.find((item) => item.id === "browser:watcher");
  assert.ok(browser);
  assert.equal(browser.kind, "browser");
  assert.equal(browser.deferrable, true);
  assert.equal(browser.phase, "post_apply");
  assert.equal(browser.closure, "confirmed");
  assert.equal(browser.site, "linkedin.com");
  assert.match(String(browser.title), /Take control and log into linkedin\.com/);
  assert.match(String(browser.setup), /Log into LinkedIn/);
  assert.equal(steps.some((item) => item.id === "conn:notion"), true);
  assert.equal(steps.some((item) => item.id === "activate"), true);
  assert.equal(
    blockingApplySteps(steps).map((item) => item.id).join(","),
    "conn:notion,overlays:notion",
  );
  assert.equal(
    blockingApplySteps(deferLaunchSteps(steps)).length,
    2,
  );
});

test("skipping a connection also skips its overlays and does not block launch", () => {
  const recipe = linkedInNotionRecipe(operatorAuthor());
  const steps = checklistFromPlan(recipe, {
    connections: [{ server: "notion", action: "create", setup: "Connect Notion." }],
    secrets: [],
  });
  const skipped = skipApplyChecklistStep(steps, "conn:notion");
  const notion = skipped.checklist.find((item) => item.id === "conn:notion");
  const overlays = skipped.checklist.find((item) => item.id === "overlays:notion");
  assert.equal(notion?.status, "skipped");
  assert.equal(overlays?.status, "skipped");
  assert.equal(skipped.warning.code, "step.skipped");
  assert.match(String(skipped.warning.message), /Connect Notion|Connect notion/i);
  assert.equal(blockingApplySteps(deferLaunchSteps(skipped.checklist)).length, 0);
  assert.throws(() => skipApplyChecklistStep(steps, "activate"), /cannot be skipped/);
});

test("apply fills sparse builder config so the browser can start", () => {
  const sparse = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  sparse.roles[0]!.config = { browser: true };
  sparse.roles[0]!.browser.required = true;
  assert.equal(configFromRecipeRole(sparse.roles[0]!).model, "");
  const filled = configFromRecipeRole(sparse.roles[0]!, TEST_MODEL);
  assert.equal(filled.model, TEST_MODEL);
  assert.equal(filled.browser, true);
  assert.equal(filled.temperature, DEFAULT_TEMPERATURE);
  assert.equal(filled.max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(filled.max_steps, DEFAULT_MAX_STEPS);
  const prepared = prepareRecipeForApply(sparse);
  assert.equal(prepared.roles[0]!.config.temperature, DEFAULT_TEMPERATURE);
  assert.equal(prepared.roles[0]!.config.browser, true);
});

test("a recipe's repositories add a GitHub login and a check per repository", () => {
  const recipe = parseRecipe({
    ...huskLeadMatcherRecipe(operatorAuthor()),
    repositories: [
      { name: "api", purpose: "The HTTP service." },
      { name: "web", purpose: "" },
    ],
  });
  const steps = checklistFromPlan(recipe, { connections: [], secrets: [] });
  const github = steps.find((item) => item.id === "conn:github");
  assert.equal(github?.kind, "connection");
  assert.equal(github?.closure, "verified");
  assert.match(String(github?.setup), /Commit author email/);
  const api = steps.find((item) => item.id === "repo:api");
  assert.equal(api?.kind, "repository");
  assert.equal(api?.closure, "verified");
  assert.match(
    String(api?.setup),
    /^The HTTP service\. Add it in the guild's Settings under Repositories, named api\./,
  );
  assert.match(
    String(steps.find((item) => item.id === "repo:web")?.setup),
    /^Add it in the guild's Settings/,
  );
  assert.deepEqual(
    blockingApplySteps(steps).map((item) => item.id),
    ["conn:github", "repo:api", "repo:web"],
  );
  const skipped = skipApplyChecklistStep(steps, "repo:api");
  assert.equal(skipped.checklist.find((item) => item.id === "repo:api")?.status, "skipped");

  // A recipe that already lists GitHub among its connections keeps that one step.
  const listed = checklistFromPlan(recipe, {
    connections: [{ server: "github", action: "create", setup: "Install the App." }],
    secrets: [],
  });
  assert.equal(listed.filter((item) => item.id === "conn:github").length, 1);
  assert.equal(listed.find((item) => item.id === "conn:github")?.setup, "Install the App.");
});

test("apply carries the coding flag and turns a missing one off", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  recipe.roles[0]!.config = { coding: true };
  assert.equal(configFromRecipeRole(recipe.roles[0]!).coding, true);
  recipe.roles[0]!.config = {};
  assert.equal(configFromRecipeRole(recipe.roles[0]!).coding, false);
});

test("a connector the box lacks is installable from the registry or the recipe, else unknown", () => {
  const ctx = {
    publishedServers: new Set<string>(),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
    registryConnectors: new Map([["notion", { version: "1.2.0", verified: true }]]),
  };
  const codeFor = (recipe: ReturnType<typeof linkedInNotionRecipe>) =>
    validateRecipe(recipe, ctx).find((item) => item.path === "connections.notion")?.code;

  const recipe = linkedInNotionRecipe(operatorAuthor());
  assert.equal(codeFor(recipe), "server.registry");
  assert.match(
    String(validateRecipe(recipe, ctx).find((item) => item.code === "server.registry")?.message),
    /notion@1\.2\.0/,
  );
  assert.equal(codeFor(recipe), codeFor(parseRecipe(JSON.parse(JSON.stringify(recipe)))));

  const carried = parseRecipe({
    ...JSON.parse(JSON.stringify(recipe)),
    connections: recipe.connections.map((connection) => ({
      ...connection,
      manifest: {
        slug: "notion",
        display_name: "Our Notion bridge",
        endpoint: { url: "https://mcp.notion-bridge.example.com/mcp" },
        auth: { kind: "token" },
        description: "",
      },
    })),
  });
  assert.equal(codeFor(carried), "server.organisation");

  const offline = validateRecipe(recipe, { ...ctx, registryConnectors: new Map() });
  assert.equal(offline.find((item) => item.path === "connections.notion")?.code, "server.unknown");
  assert.equal(validateRecipe(recipe, { ...ctx, publishedServers: new Set(["notion"]) }).some((item) => item.path === "connections.notion" && item.code.startsWith("server.")), false);
});

test("a carried manifest must be an endpoint-only connector under the connection's slug", () => {
  const recipe = JSON.parse(JSON.stringify(linkedInNotionRecipe(operatorAuthor())));
  const carrying = (manifest: Record<string, unknown>) => ({
    ...recipe,
    connections: recipe.connections.map((connection: Record<string, unknown>) => ({ ...connection, manifest })),
  });
  const base = { slug: "notion", display_name: "Notion", endpoint: { url: "https://mcp.example.com/mcp" }, auth: { kind: "token" }, description: "" };
  assert.throws(() => parseRecipe(carrying({ ...base, slug: "other" })), /does not match its folder/);
  assert.throws(
    () => parseRecipe(carrying({ ...base, auth: { kind: "token", instance: { integration: "web-search", variable: "TAVILY_API_KEY" } } })),
    /instance key/,
  );
  assert.throws(() => parseRecipe(carrying({ ...base, endpoint: { url: "http://10.0.0.5/mcp" } })), /connections\[0\]\.manifest/);
});
