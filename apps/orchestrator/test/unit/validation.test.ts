import assert from "node:assert/strict";
import { test } from "node:test";
import { secretPayload } from "../../src/credentials/validate.js";
import {
  assertCodingAgent,
  secretAliasesOf,
  AgentValidationError,
  addMissingFlags,
  CONFIG_KEYS,
  DEFAULT_KEEP_TOOL_RESULT_GENERATIONS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_SCRIPTS,
  DEFAULT_MAX_WORKSPACE_MIB,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  keepToolResultGenerationsOf,
  validateAvatarColor,
  validateAvatarShape,
  validateConfig,
  validateFocus,
  validateAgentName,
  validateThinkingLevel,
  validateWakeTriggers,
} from "../../src/agents/validation.js";
import {
  GuildValidationError,
  canSeeGuild,
  guildRole,
  validateGuildOperatorRole,
  assertGuildAgentRoom,
  validateAbout,
  validateGuildDescription,
  validateGitAuthorEmail,
  validateGuildName,
  validateMaxAgents,
  validateRoutinesEnabled,
  validateVisibility,
} from "../../src/guilds/validation.js";

const VALID_CONFIG = {
  model: "openrouter/openai/gpt-5.6-luna",
  temperature: 1.0,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
};

test("names match spec", () => {
  assert.equal(validateAgentName("researcher"), "researcher");
  assert.equal(validateGuildName("research"), "research");
  assert.throws(() => validateAgentName("Research"), AgentValidationError);
  assert.throws(() => validateAgentName("user"), /reserved/);
  assert.throws(() => validateGuildName("Research"), GuildValidationError);
});

test("about and focus are optional and capped", () => {
  assert.equal(validateAbout(null), "");
  assert.equal(validateAbout("  weekly synthesis  "), "weekly synthesis");
  assert.equal(validateFocus(null), "");
  assert.equal(validateFocus("  papers  "), "papers");
  assert.equal(validateFocus("x".repeat(150)).length, 150);
  assert.throws(() => validateAbout("x".repeat(201)), /200/);
  assert.throws(() => validateFocus("x".repeat(151)), /150/);
});

test("wake triggers are optional and capped", () => {
  assert.equal(validateWakeTriggers(undefined), "");
  assert.equal(validateWakeTriggers("  a new paper is shared  "), "a new paper is shared");
  assert.equal(validateWakeTriggers("x".repeat(500)).length, 500);
  assert.throws(() => validateWakeTriggers("x".repeat(501)), /wake_triggers must be at most 500/);
});

test("description is optional and capped", () => {
  assert.equal(validateGuildDescription(null), "");
  assert.equal(validateGuildDescription("  longer brief  "), "longer brief");
  assert.throws(() => validateGuildDescription("x".repeat(8001)), /8000/);
});

test("git_author_email is optional, a single address, and not .invalid", () => {
  assert.equal(validateGitAuthorEmail(null), "");
  assert.equal(validateGitAuthorEmail(""), "");
  assert.equal(validateGitAuthorEmail("  dev@example.com  "), "dev@example.com");
  assert.throws(() => validateGitAuthorEmail(1), /must be a string/);
  assert.throws(() => validateGitAuthorEmail("not-an-email"), /single email address/);
  assert.throws(() => validateGitAuthorEmail("a@b@c.com"), /single email address/);
  assert.throws(() => validateGitAuthorEmail("dev@localhost"), /single email address/);
  assert.throws(() => validateGitAuthorEmail("dev@example.invalid"), /\.invalid/);
  assert.throws(() => validateGitAuthorEmail("a_1@agents.guilds.invalid"), /\.invalid/);
  assert.throws(() => validateGitAuthorEmail(`${"a".repeat(250)}@b.co`), /254/);
});

test("max_agents is a positive integer", () => {
  assert.equal(validateMaxAgents(5), 5);
  assert.equal(validateMaxAgents("12"), 12);
  assert.throws(() => validateMaxAgents(0), /max_agents/);
  assert.throws(() => validateMaxAgents(1.5), /max_agents/);
});

test("guild agent room refuses past max_agents", async () => {
  const full = {
    async getGuild() {
      return { max_agents: 5 };
    },
    async countGuildAgents() {
      return 5;
    },
  };
  await assert.rejects(() => assertGuildAgentRoom(full, "guild_1", 1), /limited to 5/);
  await assertGuildAgentRoom(full, "guild_1", 0);
  await assert.rejects(
    () =>
      assertGuildAgentRoom(
        {
          async getGuild() {
            return null;
          },
          async countGuildAgents() {
            return 0;
          },
        },
        null,
        16,
      ),
    /limited to 15/,
  );
});

test("guild routines switch is a boolean", () => {
  assert.equal(validateRoutinesEnabled(true), true);
  assert.equal(validateRoutinesEnabled(false), false);
  assert.throws(() => validateRoutinesEnabled("false"), /routines_enabled must be a boolean/);
});

test("guild visibility defaults to org and rejects unknown", () => {
  assert.equal(validateVisibility(undefined), "org");
  assert.equal(validateVisibility("private"), "private");
  assert.throws(() => validateVisibility("secret"), /visibility must be/);
});

test("private guilds are visible only to their operators", () => {
  const operators = [
    { user_id: "user_admin", name: "ada", role: "admin" },
    { user_id: "user_op", name: "otto", role: "operator" },
  ];
  assert.equal(canSeeGuild({ visibility: "org", operators: [] }, "user_other"), true);
  assert.equal(canSeeGuild({ visibility: "private", operators }, "user_admin"), true);
  assert.equal(canSeeGuild({ visibility: "private", operators }, "user_op"), true);
  assert.equal(canSeeGuild({ visibility: "private", operators }, "user_other"), false);
});

test("guild roles come from the operators on the row", () => {
  const guild = { operators: JSON.stringify([{ user_id: "user_admin", name: "ada", role: "admin" }]) };
  assert.equal(guildRole(guild, "user_admin"), "admin");
  assert.equal(guildRole(guild, "user_other"), null);
  assert.equal(validateGuildOperatorRole("operator"), "operator");
  assert.throws(() => validateGuildOperatorRole("owner"), /role must be admin or operator/);
});

test("avatar defaults and rejects unknown", () => {
  assert.equal(validateAvatarShape(null), "teardrop");
  assert.equal(validateAvatarShape("  Star  "), "star");
  assert.equal(validateAvatarShape("clay-7k2m9p"), "clay-7k2m9p");
  assert.equal(validateAvatarShape("critters:bell-123"), "critters:bell-123");
  assert.equal(validateAvatarShape("cameo:profile"), "cameo:profile");
  assert.equal(validateAvatarShape("pixelbot:99"), "pixelbot:99");
  assert.equal(validateAvatarShape("cutouts:paper-1"), "cutouts:paper-1");
  assert.equal(validateAvatarShape("voxel-bot:cube-9"), "voxel-bot:cube-9");
  assert.equal(validateAvatarShape("bottts-neutral:sparky"), "bottts-neutral:sparky");
  assert.equal(validateAvatarColor(null), "#7c5cff");
  assert.equal(validateAvatarColor("  #FF4D8D  "), "#ff4d8d");
  assert.throws(() => validateAvatarShape("no spaces"), /avatar_shape/);
  assert.throws(() => validateAvatarShape("x".repeat(64)), /avatar_shape/);
  assert.throws(() => validateAvatarColor("#fff"), /hex/);
  assert.throws(() => validateAvatarColor("red"), /hex/);
});

test("config requires a model with a provider prefix, whatever the catalog lists", () => {
  assert.equal(validateConfig(VALID_CONFIG).model, "openrouter/openai/gpt-5.6-luna");
  assert.equal(validateConfig({ ...VALID_CONFIG, model: "openai/gpt-4o" }).model, "openai/gpt-4o");
  assert.equal(validateConfig({ ...VALID_CONFIG, model: "local/qwen3-8b" }).model, "local/qwen3-8b");
  assert.throws(() => validateConfig({ ...VALID_CONFIG, model: "anthropic/claude" }), /unknown model provider/);
  assert.throws(() => validateConfig({ ...VALID_CONFIG, model: "openrouter/" }), /unknown model provider/);
  assert.throws(() => validateConfig({ ...VALID_CONFIG, model: "gpt-4o" }), /unknown model provider/);
  assert.throws(() => validateConfig({ model: "" }), /non-empty/);
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, model: "kimi/kimi-for-coding", coding: false }),
    /coding API models are only for coding agents/,
  );
  assert.equal(
    validateConfig({ ...VALID_CONFIG, model: "kimi/kimi-for-coding", coding: true }).model,
    "kimi/kimi-for-coding",
  );
});

test("config defaults missing generation keys", () => {
  const filled = validateConfig({
    model: "openrouter/openai/gpt-5.6-luna",
    browser: true,
  });
  assert.equal(filled.temperature, DEFAULT_TEMPERATURE);
  assert.equal(filled.max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(filled.max_steps, DEFAULT_MAX_STEPS);
  assert.equal(filled.browser, true);
});

test("config keeps explicit generation limits", () => {
  const filled = validateConfig({
    ...VALID_CONFIG,
    temperature: 0,
    max_tokens: 32,
    max_steps: 7,
  });
  assert.equal(filled.temperature, 0);
  assert.equal(filled.max_tokens, 32);
  assert.equal(filled.max_steps, 7);
});

test("config rejects legacy tool keys", () => {
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, tools: ["bash"], secrets: [] }),
    /unknown keys/,
  );
});

test("config requires browser boolean", () => {
  assert.equal(validateConfig(VALID_CONFIG).browser, false);
  assert.equal(validateConfig({ ...VALID_CONFIG, browser: true }).browser, true);
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, browser: "yes" }),
    /browser must be a boolean/,
  );
  const without = { ...VALID_CONFIG } as Record<string, unknown>;
  delete without.browser;
  assert.equal(validateConfig(without).browser, false, "a missing flag is off");
});

test("an agent config has no box: box, cpu, and memory_mib are unknown keys", () => {
  const model = VALID_CONFIG.model;
  for (const key of ["box", "cpu", "memory_mib"]) {
    assert.equal(CONFIG_KEYS.has(key), false, key);
  }
  assert.equal(CONFIG_KEYS.size, 18);
  assert.throws(() => validateConfig({ model, box: "standard" }), /unknown keys: box/);
  assert.throws(() => validateConfig({ model, cpu: 2, memory_mib: 3072 }), /unknown keys: cpu, memory_mib/);
  assert.equal("box" in validateConfig({ model }), false);
  assert.deepEqual(addMissingFlags({}), {
    browser: false,
    coding: false,
    harness: null,
    harness_model: null,
    secret_aliases: {},
  });
  assert.deepEqual(addMissingFlags({ coding: true }), {
    coding: true,
    browser: false,
    harness: null,
    harness_model: null,
    secret_aliases: {},
  });
});

test("harness is one of the coding harnesses, and only a coding agent has one", () => {
  const model = VALID_CONFIG.model;
  assert.equal(validateConfig({ model }).harness, null);
  assert.equal(validateConfig({ model, coding: true, harness: "codex" }).harness, "codex");
  assert.throws(() => validateConfig({ model, coding: true, harness: "opencode" }), /harness must be one of/);
  assert.throws(() => validateConfig({ model, coding: false, harness: "cursor" }), /only for coding agents/);
});

test("harness_model is a model name for a set harness; blank or missing leaves the subscription's default", () => {
  const model = VALID_CONFIG.model;
  const coder = { model, coding: true, harness: "claude-code" };
  assert.equal(validateConfig(coder).harness_model, null);
  assert.equal(validateConfig({ ...coder, harness_model: "  " }).harness_model, null);
  assert.equal(validateConfig({ ...coder, harness_model: " opus " }).harness_model, "opus");
  assert.equal(
    validateConfig({ ...coder, harness_model: "claude-opus-4-8[context=1m,effort=high]" }).harness_model,
    "claude-opus-4-8[context=1m,effort=high]",
  );
  assert.throws(() => validateConfig({ ...coder, harness_model: "--dangerous" }), /harness_model must be a model name/);
  assert.throws(() => validateConfig({ ...coder, harness_model: "opus; rm -rf /" }), /harness_model must be a model name/);
  assert.throws(() => validateConfig({ ...coder, harness_model: 4 }), /harness_model must be a model name/);
  assert.throws(() => validateConfig({ ...coder, harness_model: "x".repeat(121) }), /harness_model must be a model name/);
  assert.throws(() => validateConfig({ model, harness_model: "opus" }), /harness_model needs a harness/);
});

test("secret_aliases maps variable names to other secrets' names, at most 32 of them", () => {
  const model = VALID_CONFIG.model;
  assert.deepEqual(validateConfig({ model }).secret_aliases, {});
  const aliased = validateConfig({ model, secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN", GH_PAT: "BOB_GH" } });
  assert.deepEqual(aliased.secret_aliases, { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN", GH_PAT: "BOB_GH" });
  assert.throws(() => validateConfig({ model, secret_aliases: [] }), /must be an object/);
  assert.throws(() => validateConfig({ model, secret_aliases: "x" }), /must be an object/);
  assert.throws(() => validateConfig({ model, secret_aliases: { "1BAD": "X" } }), /variable names to secret names/);
  assert.throws(() => validateConfig({ model, secret_aliases: { GOOD: "not a name" } }), /variable names to secret names/);
  assert.throws(() => validateConfig({ model, secret_aliases: { GOOD: 4 } }), /variable names to secret names/);
  assert.throws(() => validateConfig({ model, secret_aliases: { SAME: "SAME" } }), /SAME must name another secret/);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`A${i}`, `S${i}`]));
  assert.throws(() => validateConfig({ model, secret_aliases: many }), /at most 32 entries/);
  assert.deepEqual(secretAliasesOf({ secret_aliases: { A: "B" } }), { A: "B" });
  assert.deepEqual(secretAliasesOf({ secret_aliases: { A: "A" } }), {}, "a map that does not validate reads as none");
  assert.deepEqual(secretAliasesOf({}), {});
  assert.deepEqual(secretAliasesOf(null), {});
});

test("a coding agent needs a harness to save; a stored one without it still validates", () => {
  const model = VALID_CONFIG.model;
  const unharnessed = validateConfig({ model, coding: true });
  assert.equal(unharnessed.harness, null);
  assert.throws(() => assertCodingAgent(unharnessed), /coding agents need a harness: claude-code, codex, cursor/);
  const coding = { model, coding: true, harness: "cursor" };
  assert.doesNotThrow(() => assertCodingAgent(validateConfig(coding)));
  assert.doesNotThrow(() => assertCodingAgent(validateConfig({ ...coding, browser: true })));
  assert.doesNotThrow(() => assertCodingAgent(validateConfig({ model })));
});

test("an update cannot switch a coding agent's coding off", () => {
  const model = VALID_CONFIG.model;
  assert.throws(() => assertCodingAgent(validateConfig({ model }), { coding: true }), /coding cannot be switched off/);
  assert.doesNotThrow(() => assertCodingAgent(validateConfig({ model }), { coding: false }));
  assert.doesNotThrow(() =>
    assertCodingAgent(validateConfig({ model, coding: true, harness: "codex" }), { coding: false }),
  );
});

test("config defaults missing run limits", () => {
  assert.equal(validateConfig(VALID_CONFIG).max_tool_calls, 50);
  assert.equal(validateConfig(VALID_CONFIG).max_input_tokens, 100000);
  const withoutLimits = { ...VALID_CONFIG } as Record<string, unknown>;
  delete withoutLimits.max_tool_calls;
  delete withoutLimits.max_input_tokens;
  const filled = validateConfig(withoutLimits);
  assert.equal(filled.max_tool_calls, DEFAULT_MAX_TOOL_CALLS);
  assert.equal(filled.max_input_tokens, DEFAULT_MAX_INPUT_TOKENS);
  assert.equal(filled.keep_tool_result_generations, DEFAULT_KEEP_TOOL_RESULT_GENERATIONS);
  assert.equal(filled.max_scripts, DEFAULT_MAX_SCRIPTS);
  assert.equal(filled.max_workspace_mib, DEFAULT_MAX_WORKSPACE_MIB);
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, max_tool_calls: 0 }),
    /max_tool_calls must be a positive/,
  );
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, max_input_tokens: 0 }),
    /max_input_tokens must be a positive/,
  );
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, keep_tool_result_generations: 0 }),
    /keep_tool_result_generations must be a positive/,
  );
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, max_scripts: 0 }),
    /max_scripts must be a positive/,
  );
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, max_workspace_mib: 0 }),
    /max_workspace_mib must be a positive/,
  );
});

test("keepToolResultGenerationsOf uses a valid integer and otherwise the default", () => {
  assert.equal(keepToolResultGenerationsOf({ keep_tool_result_generations: 3 }), 3);
  assert.equal(keepToolResultGenerationsOf({ keep_tool_result_generations: 0 }), DEFAULT_KEEP_TOOL_RESULT_GENERATIONS);
  assert.equal(keepToolResultGenerationsOf({}), DEFAULT_KEEP_TOOL_RESULT_GENERATIONS);
});

test("config defaults missing scripting and memory to on, and has no CLI flag", () => {
  const filled = validateConfig(VALID_CONFIG);
  assert.equal(filled.scripting, true);
  assert.equal(filled.memory, true);
  assert.equal(validateConfig({ ...VALID_CONFIG, scripting: false }).scripting, false);
  assert.equal(validateConfig({ ...VALID_CONFIG, memory: false }).memory, false);
  assert.throws(() => validateConfig({ ...VALID_CONFIG, cli: true }), /unknown keys: cli/);
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, scripting: "yes" }),
    /scripting must be a boolean/,
  );
  assert.throws(() => validateConfig({ ...VALID_CONFIG, memory: "yes" }), /memory must be a boolean/);
});

test("validateThinkingLevel accepts valid levels and normalizes", () => {
  assert.equal(validateThinkingLevel("none"), "none");
  assert.equal(validateThinkingLevel("off"), "none");
  assert.equal(validateThinkingLevel("disabled"), "none");
  assert.equal(validateThinkingLevel(""), "none");
  assert.equal(validateThinkingLevel("low"), "low");
  assert.equal(validateThinkingLevel("medium"), "medium");
  assert.equal(validateThinkingLevel("high"), "high");
  assert.equal(validateThinkingLevel("MEDIUM"), "medium");
  assert.throws(() => validateThinkingLevel("ultra"), /thinking_level must be one of/);
});

test("config supports thinking_level and defaults missing to none", () => {
  assert.equal(validateConfig(VALID_CONFIG).thinking_level, "none");
  assert.equal(
    validateConfig({ ...VALID_CONFIG, thinking_level: "high" }).thinking_level,
    "high",
  );
  assert.equal(
    validateConfig({ ...VALID_CONFIG, thinking_level: "low" }).thinking_level,
    "low",
  );
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, thinking_level: "invalid" }),
    /thinking_level must be one of/,
  );
});

test("config defaults browser_language to en-US", () => {
  assert.equal(validateConfig(VALID_CONFIG).browser_language, "en-US");
  assert.equal(
    validateConfig({ ...VALID_CONFIG, browser_language: "fr-FR" }).browser_language,
    "fr-FR",
  );
  assert.throws(
    () => validateConfig({ ...VALID_CONFIG, browser_language: "xx" }),
    /browser_language must be a supported Chrome language/,
  );
});



test("secretPayload keeps a value without the whitespace around it and refuses one of only whitespace", () => {
  assert.deepEqual(secretPayload(" sk-token\n"), { value: "sk-token" });
  assert.deepEqual(secretPayload("correct horse battery"), { value: "correct horse battery" });
  assert.throws(() => secretPayload(" \t\n"), /value must contain non-whitespace text/);
  assert.throws(() => secretPayload(42), /value must contain non-whitespace text/);
});
