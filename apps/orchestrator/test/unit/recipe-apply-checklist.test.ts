import assert from "node:assert/strict";
import { test } from "node:test";
import { blockingApplySteps, browserLoginAgentIds, checklistFromPlan, deferLaunchSteps, skipApplyChecklistStep } from "../../src/recipes/checklist.js";
import { installSubscriptionAgents } from "../../src/coding/harnesses.js";
import { parseRecipe } from "../../src/recipes/parse.js";
import {
  configFromRecipeRole,
  prepareRecipeForApply,
  roleRunsOnSubscription,
  roleTakesHarness,
  subscriptionLoopSettings,
} from "../../src/recipes/prepare.js";
import { TEST_MODEL } from "../helpers/models.js";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "../../src/agents/config.js";
import { validateAgentConfig } from "../../src/agents/validation.js";
import { operatorAuthor, linkedInNotionRecipe, huskLeadMatcherRecipe } from "../helpers/recipe-docs.js";
import { validateRecipe } from "../../src/recipes/validate.js";
import type { ApplyPlan, PlannedConnection, RecipeRole } from "../../src/db/schema/index.js";

function applyPlan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
  return { names: [], connections: [], secrets: [], collections: [], activate_keys: [], ...overrides };
}

/** A connection the operator still creates on its checklist step. */
function plannedConnection(server: string, setup: string): PlannedConnection {
  return {
    server,
    auth: "oauth",
    recommended_scope: "guild",
    reusable: [],
    action: "create",
    connection_id: null,
    setup,
    resources: [],
  };
}

test("ready apply names agents whose browser login was deferred", () => {
  const deferred = deferLaunchSteps([
    { id: "browser:watcher", kind: "browser", title: "Log in", closure: "confirmed", role: "watcher", status: "open" },
    { id: "browser:writer", kind: "browser", title: "Log in", closure: "confirmed", role: "writer", status: "confirmed", resolution: "done" },
    { id: "activate", kind: "activate", title: "Activate", closure: "confirmed", status: "open" },
  ]);
  assert.deepEqual(
    browserLoginAgentIds({
      status: "ready",
      plan: applyPlan({ names: [{ role: "watcher", name: "watch", agent_id: "a_watch" }, { role: "writer", name: "write", agent_id: "a_write" }] }),
      checklist: deferred,
    }),
    ["a_watch"],
  );
  assert.deepEqual(
    browserLoginAgentIds({
      status: "checklist",
      plan: applyPlan({ names: [{ role: "watcher", name: "watch", agent_id: "a_watch" }] }),
      checklist: deferred,
    }),
    [],
  );
  assert.deepEqual(browserLoginAgentIds(null), []);
});

test("apply checklist defers browser login until after apply", () => {
  const recipe = linkedInNotionRecipe(operatorAuthor());
  const steps = checklistFromPlan(recipe, applyPlan({ connections: [plannedConnection("notion", "Connect Notion.")] }));
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
  const steps = checklistFromPlan(recipe, applyPlan({ connections: [plannedConnection("notion", "Connect Notion.")] }));
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
  const filled = validateAgentConfig(configFromRecipeRole(sparse.roles[0]!, { model: TEST_MODEL }));
  assert.equal(filled.model, TEST_MODEL);
  assert.equal(filled.browser, true);
  assert.equal(filled.temperature, DEFAULT_TEMPERATURE);
  assert.equal(filled.max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(filled.max_steps, DEFAULT_MAX_STEPS);
  const prepared = prepareRecipeForApply(sparse, { models: new Map([[sparse.roles[0]!.role, TEST_MODEL]]) });
  assert.equal(validateAgentConfig(prepared.roles[0]!.config).temperature, DEFAULT_TEMPERATURE);
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
  const steps = checklistFromPlan(recipe, applyPlan());
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

  // A recipe that already lists GitHub among its connections keeps that one step, which also
  // says what the repositories need.
  const listed = checklistFromPlan(recipe, applyPlan({ connections: [plannedConnection("github", "Install the App.")] }));
  assert.equal(listed.filter((item) => item.id === "conn:github").length, 1);
  assert.match(String(listed.find((item) => item.id === "conn:github")?.setup), /^Install the App\. .*Commit author email/);
});

test("apply carries the coding flag and turns a missing one off", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  recipe.roles[0]!.config = { coding: true };
  assert.equal(configFromRecipeRole(recipe.roles[0]!).coding, true);
  recipe.roles[0]!.config = {};
  assert.equal(configFromRecipeRole(recipe.roles[0]!).coding, false);
});

test("a subscription role applies with no model, its harness, and none of the model loop's settings", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  const role = recipe.roles[0]!;
  role.config = { harness: "codex", harness_model: "gpt-6-luna", temperature: 0.2, max_tokens: 8192, max_steps: 5 };
  assert.equal(roleRunsOnSubscription(role), true);
  assert.equal(roleTakesHarness(role), true);
  assert.deepEqual(subscriptionLoopSettings(role), ["temperature"]);
  const config = configFromRecipeRole(role, { model: "deepinfra/zai-org/GLM-5.3-Flash" });
  assert.equal(config.model, null, "a chosen model does not apply to a subscription role");
  assert.equal(config.coding, false);
  assert.equal(config.harness, "codex");
  assert.equal(config.harness_model, "gpt-6-luna");
  assert.equal("temperature" in config, false);
  assert.equal(config.max_steps, 5);
  assert.equal(configFromRecipeRole(role, { harness: "claude-code" }).harness, "claude-code");
  role.config = { model: "deepinfra/zai-org/GLM-5.3-Flash", harness: "codex" };
  assert.equal(roleRunsOnSubscription(role), false, "a role with a model is on a key");
  assert.equal(roleTakesHarness(role), false);
  assert.deepEqual(subscriptionLoopSettings(role), []);
  role.config = { coding: true, harness: "codex" };
  assert.equal(roleRunsOnSubscription(role), false, "a coding role is on a key");
  role.config = { harness: "opencode" };
  assert.equal(roleRunsOnSubscription(role), false, "an unknown harness is no subscription");
});

test("apply gives a coding role the harness chosen, else the recipe's, and no other role one", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  const role = recipe.roles[0]!;
  role.config = { coding: true, harness: "codex" };
  assert.equal(configFromRecipeRole(role).harness, "codex");
  assert.equal(configFromRecipeRole(role, { harness: "cursor" }).harness, "cursor");
  role.config = { coding: true };
  assert.equal(configFromRecipeRole(role).harness, null);
  role.config = { model: "deepinfra/zai-org/GLM-5.3-Flash", coding: false, harness: "codex" };
  assert.equal(configFromRecipeRole(role, { harness: "cursor" }).harness, null);
  role.config = { coding: true, harness: "claude-code", harness_model: "opus" };
  assert.equal(configFromRecipeRole(role).harness_model, "opus");
  assert.equal(configFromRecipeRole(role, { harness: "claude-code" }).harness_model, "opus");
  assert.equal(configFromRecipeRole(role, { harness: "codex" }).harness_model, null, "another harness takes its default");
  role.config = { coding: true, harness: "codex", harness_model: "gpt-5.6-terra", harness_effort: "ultra" };
  assert.equal(configFromRecipeRole(role).harness_effort, "ultra");
  assert.equal(configFromRecipeRole(role, { harness: "claude-code" }).harness_effort, null, "another harness takes its default");
  role.config = { coding: true, harness: "codex", harness_model: "gpt-6-luna", harness_effort: "ultra" };
  assert.equal(configFromRecipeRole(role).harness_effort, null, "an effort its model does not run at");
  role.config = { coding: true, harness: "codex", harness_effort: "turbo" };
  assert.equal(configFromRecipeRole(role).harness_effort, null);
  role.config = { coding: true, harness: "claude-code", harness_model: "--bad" };
  assert.equal(configFromRecipeRole(role).harness_model, null);
  role.config = { coding: true };
  assert.equal(configFromRecipeRole(role).harness_model, null);
  role.config = { coding: true, harness: "codex" };
  assert.equal(configFromRecipeRole(role).browser, false, "a coding role has the browser only when it asks for it");
  role.config = { browser: true, browser_optimized: true, browser_model: TEST_MODEL };
  assert.equal(configFromRecipeRole(role).browser_optimized, false, "a role browses with the step-by-step browser tools");
  assert.equal(configFromRecipeRole(role).browser_model, null);
  role.config = { secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" } };
  assert.deepEqual(configFromRecipeRole(role).secret_aliases, { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" });
  role.config = { secret_aliases: { SAME: "SAME" } };
  assert.deepEqual(configFromRecipeRole(role).secret_aliases, {}, "aliases that do not validate are left out");
  const ctx = {
    publishedServers: new Set<string>(),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
  };
  const findings = (config: RecipeRole["config"]) => {
    role.config = config;
    return validateRecipe(recipe, ctx).filter((item) => item.code.startsWith("harness."));
  };
  const credential = findings({ coding: true, harness: "claude-code" });
  assert.deepEqual(credential.map((item) => [item.code, item.severity]), [["harness.credential", "warning"]]);
  assert.match(credential[0]!.message, /grant the secret CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(findings({ coding: true })[0]!.message, /apply asks for its harness/);
  assert.deepEqual(findings({ coding: true, harness: "pi" }).map((item) => item.code), ["harness.unknown", "harness.credential"]);
  assert.deepEqual(findings({ model: TEST_MODEL, coding: false, harness: "codex" }).map((item) => item.code), ["harness.coding"]);
  assert.deepEqual(findings({ coding: false, harness: "codex" }).map((item) => item.code), ["harness.credential"], "a subscription role's harness");
  assert.ok(findings({ coding: true, harness: "codex" }).every((item) => item.severity === "warning"));
});

test("a subscription role is refused while the box turns them off, warned on Cursor or a model-loop setting", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  const role = recipe.roles[0]!;
  const ctx = {
    publishedServers: new Set<string>(),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
  };
  const findings = (config: RecipeRole["config"]) => {
    role.config = config;
    return validateRecipe(recipe, ctx)
      .filter((item) => item.code.startsWith("subscription."))
      .map((item) => [item.code, item.severity, item.path, item.message]);
  };
  try {
    installSubscriptionAgents(false);
    assert.deepEqual(findings({ harness: "codex" }), [
      ["subscription.off", "error", `roles.${role.role}.config.harness`, "subscription agents are turned off on this box: give the role a model on a key"],
    ]);
    installSubscriptionAgents(true);
    assert.deepEqual(findings({ harness: "codex" }), []);
    assert.deepEqual(findings({ harness: "cursor" }), [
      [
        "subscription.harness",
        "warning",
        `roles.${role.role}.config.harness`,
        "Cursor cannot run a subscription agent: pick Claude Code or Codex, or give the agent a model; apply asks for another",
      ],
    ]);
    assert.deepEqual(findings({ harness: "codex", temperature: 1, thinking_level: "high" }), [
      [
        "subscription.setting",
        "warning",
        `roles.${role.role}.config.thinking_level`,
        "config.thinking_level sets the model loop, which a subscription role's harness replaces; apply leaves it out",
      ],
    ]);
    assert.deepEqual(findings({ model: TEST_MODEL, harness: "cursor", thinking_level: "high" }), [], "a role on a key is no subscription");
    const capacity = (config: RecipeRole["config"]) => {
      role.config = config;
      return validateRecipe(recipe, { ...ctx, remainingCodingAgents: 0 }).filter((item) => item.code === "capacity.coding");
    };
    assert.equal(capacity({ harness: "codex" }).length, 1, "a subscription role takes a coding agent");
    assert.equal(capacity({ model: TEST_MODEL }).length, 0);
  } finally {
    installSubscriptionAgents(false);
  }
});

test("a recipe's harness model that apply cannot use is a warning", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  const role = recipe.roles[0]!;
  const ctx = {
    publishedServers: new Set<string>(),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
  };
  const codes = (config: RecipeRole["config"]) => {
    role.config = config;
    return validateRecipe(recipe, ctx)
      .filter((item) => item.code.startsWith("harness_model."))
      .map((item) => [item.code, item.severity]);
  };
  assert.deepEqual(codes({ coding: true, harness: "claude-code", harness_model: "opus" }), []);
  assert.deepEqual(codes({ coding: true, harness: "claude-code" }), []);
  assert.deepEqual(codes({ coding: true, harness: "claude-code", harness_model: "--bad" }), [["harness_model.invalid", "warning"]]);
  assert.deepEqual(codes({ coding: true, harness_model: "opus" }), [["harness_model.harness", "warning"]]);
  const effortCodes = (config: RecipeRole["config"]) => {
    role.config = config;
    return validateRecipe(recipe, ctx)
      .filter((item) => item.code.startsWith("harness_effort."))
      .map((item) => [item.code, item.severity]);
  };
  assert.deepEqual(effortCodes({ coding: true, harness: "claude-code", harness_model: "opus", harness_effort: "high" }), []);
  assert.deepEqual(effortCodes({ coding: true, harness: "claude-code", harness_effort: "turbo" }), [["harness_effort.invalid", "warning"]]);
  assert.deepEqual(effortCodes({ coding: true, harness_effort: "high" }), [["harness_effort.harness", "warning"]]);
  assert.deepEqual(effortCodes({ coding: true, harness: "cursor", harness_model: "composer-2.5", harness_effort: "low" }), [
    ["harness_effort.model", "warning"],
  ]);
  const aliasCodes = (config: RecipeRole["config"]) => {
    role.config = config;
    return validateRecipe(recipe, ctx)
      .filter((item) => item.code.startsWith("secret_aliases."))
      .map((item) => [item.code, item.severity]);
  };
  assert.deepEqual(aliasCodes({ secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" } }), []);
  assert.deepEqual(aliasCodes({}), []);
  assert.deepEqual(aliasCodes({ secret_aliases: { SAME: "SAME" } }), [["secret_aliases.invalid", "warning"]]);
  assert.deepEqual(aliasCodes({ secret_aliases: "x" }), [["secret_aliases.invalid", "warning"]]);
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
    () => parseRecipe(carrying({ ...base, auth: { kind: "token", instance: { integration: "web-search", field: "api_key" } } })),
    /asks for the box's web-search key/,
  );
  assert.throws(
    () => parseRecipe(carrying({ ...base, auth: { kind: "token", instance: { own: true } } })),
    /asks for an instance key, which an organisation's server cannot hold/,
  );
  assert.throws(
    () => parseRecipe(carrying({ ...base, auth: { kind: "oauth", oauth: { strategy: "configured" } } })),
    /signs in with a configured client; an organisation's server registers its own/,
  );
  assert.throws(() => parseRecipe(carrying({ ...base, endpoint: { url: "http://10.0.0.5/mcp" } })), /connections\[0\]\.manifest/);
});

test("a role config with a key an agent config does not have is an error", () => {
  const recipe = parseRecipe(huskLeadMatcherRecipe(operatorAuthor()));
  const role = recipe.roles[0]!;
  const ctx = {
    publishedServers: new Set<string>(),
    remainingAgents: 20,
    remainingBrowserAgents: 5,
    remainingCodingAgents: 5,
    groupLimit: 20,
  };
  const unknown = () => validateRecipe(recipe, ctx).filter((item) => item.code === "config.unknown");
  role.config = { ...role.config, cli: true, box: "code" };
  assert.deepEqual(
    unknown().map((item) => [item.severity, item.path, item.message]),
    [["error", `roles.${role.role}.config`, "unknown keys: box, cli"]],
  );
  delete role.config.cli;
  delete role.config.box;
  assert.deepEqual(unknown(), []);
});
