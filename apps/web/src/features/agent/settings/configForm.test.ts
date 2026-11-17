import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessCatalog, Machine } from "../../../api/types/agents";
import {
  configErrors,
  configFormOf,
  takesHarness,
  withModelSource,
  configOf,
  defaultAgentConfig,
  withHarnessModel,
  limitFieldsFor,
  missesRepository,
} from "./configForm";

test("a new agent's form starts with scripts and Memory on, no browser, and the default limits", () => {
  const form = configFormOf(defaultAgentConfig, "key");
  assert.equal(form.scripting, true);
  assert.equal(form.memory, true);
  assert.equal(form.browser, false);
  assert.equal(form.browser_language, "en-US");
  assert.equal(form.max_workspace_mib, "10240");
  assert.equal(form.max_steps, "30");
  assert.equal(form.max_tool_calls, "50");
  assert.equal("coding" in configOf(form, undefined), false, "no config carries a coding flag");
});

test("a new agent's form starts on the step-by-step browser with no browser model", () => {
  const form = configFormOf(defaultAgentConfig, "key");
  assert.equal(form.browser_optimized, false);
  assert.equal(form.browser_model, "");
  const sent = configOf(form, undefined);
  assert.equal(sent.browser_optimized, false);
  assert.equal(sent.browser_model, null);
});

test("the agent-optimized browser and its model round-trip through the form", () => {
  const stored = {
    ...defaultAgentConfig,
    model: "openai/gpt-5",
    browser: true,
    browser_optimized: true,
    browser_model: "openrouter/openai/gpt-5-mini",
  };
  const form = configFormOf(stored, "key");
  assert.equal(form.browser_optimized, true);
  assert.equal(form.browser_model, "openrouter/openai/gpt-5-mini");
  const sent = configOf(form, undefined);
  assert.equal(sent.browser_optimized, true);
  assert.equal(sent.browser_model, "openrouter/openai/gpt-5-mini");
  assert.equal(
    configOf({ ...form, browser_model: "  " }, undefined).browser_model,
    null,
    "blank sends null",
  );
  const plain = configOf({ ...form, browser_optimized: false }, undefined);
  assert.equal(plain.browser_model, null, "no model without the agent-optimized browser");
  const browserless = configOf({ ...form, browser: false }, undefined);
  assert.equal(
    browserless.browser_optimized,
    false,
    "no agent-optimized browser without the browser",
  );
  assert.equal(browserless.browser_model, null);
});

test("a config sent from the form carries no CLI flag", () => {
  assert.equal("cli" in configOf(configFormOf(defaultAgentConfig, "key"), undefined), false);
});

test("a model is required and must have its provider connected", () => {
  const form = configFormOf(defaultAgentConfig, "key");
  assert.equal(configErrors(form).model, "Choose a model.");
  const models = {
    default: null,
    providers: [
      {
        id: "openai" as const,
        label: "OpenAI",
        connected: true,
        source: "own" as const,
        key_hint: "abcd",
        base_url: null,
      },
    ],
    models: [],
  };
  assert.equal(configErrors({ ...form, model: "openai/gpt-5" }, { models }).model, undefined);
  assert.equal(
    configErrors({ ...form, model: "xai/grok" }, { models }).model,
    "Connect a xai key on Model keys first.",
  );
});

test("the agent-optimized browser needs a browser model the organisation's key runs", () => {
  const models = {
    default: null,
    providers: [
      {
        id: "openai" as const,
        label: "OpenAI",
        connected: true,
        source: "own" as const,
        key_hint: "abcd",
        base_url: null,
      },
    ],
    models: [],
  };
  const form = {
    ...configFormOf(defaultAgentConfig, "key"),
    model: "openai/gpt-5",
    browser: true,
    browser_optimized: true,
  };
  assert.equal(configErrors(form, { models }).browser_model, "Choose a browser model.");
  assert.equal(
    configErrors({ ...form, browser_model: "openai/gpt-5-mini" }, { models }).browser_model,
    undefined,
  );
  assert.equal(
    configErrors({ ...form, browser_model: "xai/grok" }, { models }).browser_model,
    "Connect a xai key on Model keys first.",
  );
  assert.equal(
    configErrors({ ...form, browser_optimized: false }, { models }).browser_model,
    undefined,
    "no model is needed without the agent-optimized browser",
  );
  assert.equal(
    configErrors({ ...form, browser: false }, { models }).browser_model,
    undefined,
    "no model is needed without the browser",
  );
});

test("max wake-ups starts at 10 for every agent, round-trips, and takes a whole number of 1 or more", () => {
  const form = configFormOf(defaultAgentConfig, "key");
  assert.equal(form.max_wake_ups, "10");
  assert.equal(configOf({ ...form, max_wake_ups: "4" }, undefined).max_wake_ups, 4);
  assert.equal(configFormOf({ ...defaultAgentConfig, max_wake_ups: 4 }, "key").max_wake_ups, "4");
  assert.equal(configErrors({ ...form, max_wake_ups: "0" }).max_wake_ups, "A whole number, 1 or more.");
  assert.equal(configErrors({ ...form, max_wake_ups: "2.5" }).max_wake_ups, "A whole number, 1 or more.");
  assert.equal(configErrors(form).max_wake_ups, undefined);
});

test("keep tool results starts empty for the guild's, round-trips, and takes a whole number of 1 or more", () => {
  const form = configFormOf(defaultAgentConfig, "key");
  assert.equal(form.keep_tool_result_generations, "");
  assert.equal(configOf(form, undefined).keep_tool_result_generations, null);
  assert.equal(configOf({ ...form, keep_tool_result_generations: " " }, undefined).keep_tool_result_generations, null);
  assert.equal(configOf({ ...form, keep_tool_result_generations: "3" }, undefined).keep_tool_result_generations, 3);
  assert.equal(
    configFormOf({ ...defaultAgentConfig, keep_tool_result_generations: 3 }, "key").keep_tool_result_generations,
    "3",
  );
  assert.equal(configErrors(form).keep_tool_result_generations, undefined);
  for (const refused of ["0", "2.5", "-1"]) {
    assert.equal(
      configErrors({ ...form, keep_tool_result_generations: refused }).keep_tool_result_generations,
      "A whole number, 1 or more, or empty.",
    );
  }
});

test("max turn minutes starts at 30, round-trips, takes a whole number of 1 or more, and shows only on a subscription", () => {
  const form = configFormOf(defaultAgentConfig, "subscription");
  assert.equal(form.max_turn_minutes, "30");
  assert.equal(configOf({ ...form, max_turn_minutes: "45" }, undefined).max_turn_minutes, 45);
  assert.equal(configFormOf({ ...defaultAgentConfig, max_turn_minutes: 45 }, "subscription").max_turn_minutes, "45");
  assert.equal(configErrors({ ...form, max_turn_minutes: "0" }).max_turn_minutes, "A whole number, 1 or more.");
  assert.deepEqual(
    limitFieldsFor("subscription").map((field) => field.key),
    ["max_steps", "max_tool_calls", "max_wake_ups", "max_turn_minutes"],
  );
  assert.ok(!limitFieldsFor("key").some((field) => field.key === "max_turn_minutes"));
  assert.ok(limitFieldsFor("key").some((field) => field.key === "max_input_tokens"));
});

test("an agent's repositories and those it only reads are sent, on a key as on a subscription", () => {
  const picked = { ...defaultAgentConfig, repositories: ["shop", "site"], read_only_repositories: ["site"] };
  for (const source of ["subscription", "key"] as const) {
    const config = configOf(configFormOf(picked, source), undefined);
    assert.deepEqual(config.repositories, ["shop", "site"], source);
    assert.deepEqual(config.read_only_repositories, ["site"], source);
  }
});

test("a read-only repository the form no longer picks is not sent", () => {
  const form = { ...configFormOf(defaultAgentConfig, "key"), repositories: ["shop"], read_only_repositories: ["shop", "site"] };
  assert.deepEqual(configOf(form, undefined).read_only_repositories, ["shop"]);
});

function machine(id: string, box: Machine["box"]): Machine {
  return {
    id,
    name: id,
    box,
    cpu: 1,
    memory_mib: 2048,
    max_workspace_mib: 10240,
    workspace_mib: null,
    allocated_workspace_mib: 0,
    planned_cpu: 0,
    planned_mib: 0,
    agents: [],
    hidden_agents: 0,
    harnesses: null,
  };
}

test("the form holds the agent's machine and the config sent carries no machine or box", () => {
  const form = configFormOf(defaultAgentConfig, "key", "mach_a");
  assert.equal(form.machine_id, "mach_a");
  assert.equal(configFormOf(defaultAgentConfig, "key").machine_id, "");
  const sent = configOf(form, undefined);
  assert.equal("machine_id" in sent, false);
  assert.equal("box" in sent, false);
  assert.equal("cpu" in sent, false);
  assert.equal("memory_mib" in sent, false);
});

test("the only machine stands in for a choice; among several one must be picked", () => {
  const form = { ...configFormOf(defaultAgentConfig, "key"), model: "openai/gpt-5" };
  assert.equal(configErrors(form).machine, undefined);
  assert.equal(configErrors(form, { machines: [machine("solo", "standard")] }).machine, undefined);
  const two = [machine("one", "standard"), machine("two", "code")];
  assert.equal(configErrors(form, { machines: two }).machine, "Choose a machine.");
  assert.equal(configErrors({ ...form, machine_id: "two" }, { machines: two }).machine, undefined);
  assert.equal(
    configErrors({ ...form, machine_id: "gone" }, { machines: two }).machine,
    "Choose a machine.",
  );
});

test("an organisation without machines leaves nothing to pick", () => {
  const form = { ...configFormOf(defaultAgentConfig, "key"), model: "openai/gpt-5" };
  assert.equal(configErrors(form, { machines: [] }).machine, "Choose a machine.");
});

test("an agent on a key sends no harness", () => {
  const form = configFormOf(defaultAgentConfig, "key");
  assert.equal(configErrors(form).harness, undefined);
  assert.equal(configOf({ ...form, harness: "cursor" }, undefined).harness, null);
});

test("a stored harness reaches the form and back", () => {
  const form = configFormOf({ ...defaultAgentConfig, model: null, harness: "claude-code" }, "subscription");
  assert.equal(form.harness, "claude-code");
  assert.equal(configOf(form, undefined).harness, "claude-code");
  assert.equal(configFormOf({ ...defaultAgentConfig, model: null, harness: null }, "subscription").harness, "");
});

test("a harness model reaches the form and back, trimmed; empty sends the subscription's default", () => {
  const stored = {
    ...defaultAgentConfig,
    model: null,
    harness: "claude-code" as const,
    harness_model: "opus",
  };
  const form = configFormOf(stored, "subscription");
  assert.equal(form.harness_model, "opus");
  assert.equal(configOf(form, undefined).harness_model, "opus");
  assert.equal(
    configOf({ ...form, harness_model: "  sonnet " }, undefined).harness_model,
    "sonnet",
  );
  assert.equal(configOf({ ...form, harness_model: "  " }, undefined).harness_model, null);
  assert.equal(configFormOf({ ...stored, harness_model: null }, "subscription").harness_model, "");
  assert.equal(
    configOf({ ...form, harness: "" }, undefined).harness_model,
    null,
    "no model without a harness",
  );
});

test("a harness effort reaches the form and back; empty sends the harness's default", () => {
  const stored = {
    ...defaultAgentConfig,
    model: null,
    harness: "codex" as const,
    harness_model: "gpt-6-luna",
    harness_effort: "high" as const,
  };
  const form = configFormOf(stored, "subscription");
  assert.equal(form.harness_effort, "high");
  assert.equal(configOf(form, undefined).harness_effort, "high");
  assert.equal(configOf({ ...form, harness_effort: "" }, undefined).harness_effort, null);
  assert.equal(configFormOf({ ...stored, harness_effort: null }, "subscription").harness_effort, "");
  assert.equal(
    configOf({ ...form, harness: "" }, undefined).harness_effort,
    null,
    "no effort without a harness",
  );
});

const CODEX_CATALOG: HarnessCatalog[] = [
  {
    harness: "codex",
    label: "Codex",
    enabled: true,
    needs_repository: false,
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "high"], default_effort: "low" },
      {
        id: "gpt-5.6-terra",
        label: "GPT-5.6-Terra",
        efforts: ["low", "ultra"],
        default_effort: "low",
      },
    ],
    unlisted_efforts: ["low", "high", "ultra"],
  },
];

test("another harness model keeps the effort while it runs at it, else goes back to the default", () => {
  const form = configFormOf({
    ...defaultAgentConfig,
    model: null,
    harness: "codex",
    harness_model: "gpt-6-luna",
    harness_effort: "high",
  }, "subscription");
  assert.equal(withHarnessModel(form, "gpt-5.6-terra", CODEX_CATALOG).harness_effort, "");
  assert.equal(withHarnessModel(form, "gpt-custom", CODEX_CATALOG).harness_effort, "high");
  assert.equal(withHarnessModel(form, "", CODEX_CATALOG).harness_model, "");
  assert.equal(
    withHarnessModel(form, "gpt-5.6-terra", undefined).harness_effort,
    "high",
    "left to the server",
  );
});

test("a harness model must be a model name, checked only on a subscription", () => {
  const form = configFormOf({ ...defaultAgentConfig, model: null, harness: "cursor" }, "subscription");
  assert.equal(
    configErrors({ ...form, harness_model: "claude-opus-4-8[context=1m]" }).harness_model,
    undefined,
  );
  assert.match(
    String(configErrors({ ...form, harness_model: "--force" }).harness_model),
    /Up to 120/,
  );
  assert.match(String(configErrors({ ...form, harness_model: "a b" }).harness_model), /Up to 120/);
  assert.equal(
    configErrors({ ...form, model_source: "key", harness_model: "--force" }).harness_model,
    undefined,
    "only a subscription agent is checked",
  );
});

test("secret aliases reach the form and back", () => {
  const stored = {
    ...defaultAgentConfig,
    secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" },
  };
  const form = configFormOf(stored, "key");
  assert.deepEqual(form.secret_aliases, { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" });
  assert.notEqual(form.secret_aliases, stored.secret_aliases, "the form holds its own copy");
  assert.deepEqual(configOf(form, undefined).secret_aliases, {
    CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN",
  });
});

test("an agent's repositories reach the form and back, and stay across a switch of model source", () => {
  const stored = {
    ...defaultAgentConfig,
    model: null,
    harness: "codex" as const,
    repositories: ["site", "shop"],
    read_only_repositories: ["shop"],
  };
  const form = configFormOf(stored, "subscription");
  assert.deepEqual(form.repositories, ["site", "shop"]);
  assert.deepEqual(form.read_only_repositories, ["shop"]);
  assert.notEqual(form.repositories, stored.repositories, "the form holds its own copy");
  assert.notEqual(form.read_only_repositories, stored.read_only_repositories);
  assert.deepEqual(configOf(form, undefined).repositories, ["site", "shop"]);
  const onKey = withModelSource(form, "key", undefined);
  assert.deepEqual(configOf(onKey, undefined).repositories, ["site", "shop"]);
  assert.deepEqual(configOf(onKey, undefined).read_only_repositories, ["shop"]);
  assert.deepEqual(configFormOf(defaultAgentConfig, "key").repositories, []);
});

const SUBSCRIPTION_CATALOG: HarnessCatalog[] = [
  { harness: "codex", label: "Codex", enabled: true, needs_repository: false, models: [], unlisted_efforts: [] },
  { harness: "cursor", label: "Cursor", enabled: true, needs_repository: true, models: [], unlisted_efforts: [] },
];

test("a stored subscription agent opens on its harness with no model", () => {
  const form = configFormOf({ ...defaultAgentConfig, model: null, harness: "codex" }, "subscription");
  assert.equal(form.model_source, "subscription");
  assert.equal(form.model, "");
  assert.equal(form.harness, "codex");
  assert.equal(takesHarness(form), true);
  assert.equal(takesHarness(configFormOf(defaultAgentConfig, "key")), false);
});

test("a subscription sends no model, its harness, and the model loop's settings at their defaults", () => {
  const form = {
    ...configFormOf(defaultAgentConfig, "subscription"),
    model: "openai/gpt-5",
    harness: "codex" as const,
    harness_model: "gpt-6-luna",
    harness_effort: "high" as const,
    temperature: "0.2",
    thinking: "high" as const,
    max_tokens: "100",
    max_input_tokens: "1000",
    keep_tool_result_generations: "3",
    max_steps: "12",
  };
  const config = configOf(form, undefined);
  assert.equal(config.model, null);
  assert.equal(config.harness, "codex");
  assert.equal(config.harness_model, "gpt-6-luna");
  assert.equal(config.harness_effort, "high");
  assert.equal(config.temperature, 1);
  assert.equal(config.thinking_level, "none");
  assert.equal(config.max_tokens, 8192);
  assert.equal(config.max_input_tokens, 100000);
  assert.equal(config.keep_tool_result_generations, null);
  assert.equal(config.max_steps, 12);
});

test("a subscription needs a harness and no model", () => {
  const form = configFormOf(defaultAgentConfig, "subscription");
  const errors = configErrors(form);
  assert.equal(errors.harness, "Pick a harness.");
  assert.equal(errors.model, undefined);
  assert.equal(configErrors({ ...form, harness: "codex" }).harness, undefined);
});

test("switching the model source keeps a harness only for a subscription that runs on it", () => {
  const keyed = { ...configFormOf(defaultAgentConfig, "key"), model: "openai/gpt-5" };
  const onCodex = withModelSource({ ...keyed, harness: "codex" }, "subscription", SUBSCRIPTION_CATALOG);
  assert.equal(onCodex.model_source, "subscription");
  assert.equal(onCodex.harness, "codex");
  assert.equal(onCodex.model, "openai/gpt-5", "the model stays for a switch back");
  assert.equal(withModelSource({ ...keyed, harness: "cursor" }, "subscription", SUBSCRIPTION_CATALOG).harness, "", "Cursor needs a repository it does not pick");
  assert.equal(
    withModelSource({ ...keyed, harness: "cursor", repositories: ["app"] }, "subscription", SUBSCRIPTION_CATALOG).harness,
    "cursor",
    "with one it keeps Cursor",
  );
  const back = withModelSource({ ...onCodex, harness_model: "gpt-6-luna" }, "key", SUBSCRIPTION_CATALOG);
  assert.equal(back.model_source, "key");
  assert.equal(back.harness, "");
  assert.equal(back.harness_model, "");
});

test("a subscription agent on a harness that needs a repository is an error until it picks one", () => {
  const form = { ...configFormOf({ ...defaultAgentConfig, model: null, harness: "cursor" }, "subscription") };
  const context = { harnesses: SUBSCRIPTION_CATALOG };
  assert.equal(
    configErrors(form, context).harness,
    "Cursor keeps its own system prompt, so it runs a subscription agent only with a repository.",
  );
  assert.equal(missesRepository(form, SUBSCRIPTION_CATALOG), true);
  assert.equal(configErrors({ ...form, repositories: ["app"] }, context).harness, undefined);
  assert.equal(configErrors({ ...form, harness: "codex" }, context).harness, undefined, "Codex needs none");
  assert.equal(configErrors(form).harness, undefined, "the server checks it before the catalogue loads");
  assert.equal(configErrors({ ...form, model_source: "key", model: "openai/gpt-5" }, context).harness, undefined, "an agent on a key has no harness");
});
