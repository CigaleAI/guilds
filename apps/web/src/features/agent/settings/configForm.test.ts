import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessCatalog, Machine } from "../../../api/types";
import {
  configErrors,
  configFormOf,
  configOf,
  defaultAgentConfig,
  withCoding,
  withHarnessModel,
} from "./configForm";

test("switching coding on moves default limits to the coding budgets and back", () => {
  const form = configFormOf(defaultAgentConfig);
  assert.equal(form.scripting, true);
  assert.equal(form.memory, true);
  assert.equal(form.browser, false);
  assert.equal(form.browser_language, "en-US");
  assert.equal(form.max_workspace_mib, "10240");
  const coding = withCoding(form, true);
  assert.equal(coding.coding, true);
  assert.equal(coding.browser, false);
  assert.equal(coding.scripting, true);
  assert.equal(coding.max_steps, "200");
  assert.equal(coding.max_tool_calls, "200");
  const off = withCoding(coding, false);
  assert.equal(off.coding, false);
  assert.equal(off.browser, false);
  assert.equal(off.max_steps, "30");
  assert.equal(off.max_tool_calls, "50");
  assert.equal(configOf(coding, undefined).coding, true);
});

test("a config sent from the form carries no CLI flag", () => {
  const coding = withCoding(configFormOf(defaultAgentConfig), true);
  assert.equal("cli" in configOf(coding, undefined), false);
});

test("turning coding off drops a Kimi Code model for the organisation's default, or nothing", () => {
  const form = { ...configFormOf(defaultAgentConfig), model: "kimi/kimi-for-coding", coding: true };
  const off = withCoding(form, false);
  assert.equal(off.model, "");
  assert.equal(off.coding, false);
  const models = { default: "openai/gpt-5", providers: [], models: [] };
  assert.equal(withCoding(form, false, models).model, "openai/gpt-5");
  assert.equal(
    withCoding({ ...form, model: "openai/gpt-5-mini" }, false, models).model,
    "openai/gpt-5-mini",
  );
});

test("a model is required, must fit the coding flag, and must have its provider connected", () => {
  const form = configFormOf(defaultAgentConfig);
  assert.equal(configErrors(form).model, "Choose a model.");
  const models = {
    default: null,
    providers: [
      {
        id: "openai" as const,
        label: "OpenAI",
        kind: "marketplace" as const,
        connected: true,
        key_hint: "abcd",
        base_url: null,
      },
      {
        id: "kimi" as const,
        label: "Kimi Code",
        kind: "coding" as const,
        connected: false,
        key_hint: null,
        base_url: null,
      },
    ],
    models: [],
  };
  assert.equal(configErrors({ ...form, model: "openai/gpt-5" }, { models }).model, undefined);
  assert.equal(
    configErrors({ ...form, model: "kimi/k3" }, { models }).model,
    "Turn Coding on to use this model.",
  );
  assert.equal(
    configErrors({ ...form, model: "kimi/k3", coding: true }, { models }).model,
    "Connect a Kimi Code key on Model keys first.",
  );
  assert.equal(
    configErrors({ ...form, model: "xai/grok" }, { models }).model,
    "Connect a xai key on Model keys first.",
  );
});

test("limits the operator already changed stay as typed", () => {
  const form = { ...configFormOf(defaultAgentConfig), max_steps: "80" };
  const coding = withCoding(form, true);
  assert.equal(coding.max_steps, "80");
  assert.equal(coding.max_tool_calls, "200");
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
  const form = configFormOf(defaultAgentConfig, "mach_a");
  assert.equal(form.machine_id, "mach_a");
  assert.equal(configFormOf(defaultAgentConfig).machine_id, "");
  const sent = configOf(form, undefined);
  assert.equal("machine_id" in sent, false);
  assert.equal("box" in sent, false);
  assert.equal("cpu" in sent, false);
  assert.equal("memory_mib" in sent, false);
});

test("the only machine stands in for a choice; among several one must be picked", () => {
  const form = { ...configFormOf(defaultAgentConfig), model: "openai/gpt-5" };
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
  const form = { ...configFormOf(defaultAgentConfig), model: "openai/gpt-5" };
  assert.equal(configErrors(form, { machines: [] }).machine, "Choose a machine.");
});

test("a coding agent needs a harness, and turning coding off clears it", () => {
  const form = withCoding(configFormOf(defaultAgentConfig), true);
  assert.equal(form.harness, "");
  assert.equal(configErrors(form).harness, "Pick a harness.");
  const picked = { ...form, harness: "codex" as const };
  assert.equal(configErrors(picked).harness, undefined);
  assert.equal(configOf(picked, undefined).harness, "codex");
  const off = withCoding(picked, false);
  assert.equal(off.harness, "");
  assert.equal(configErrors(off).harness, undefined);
  assert.equal(configOf(off, undefined).harness, null);
  assert.equal(configOf({ ...off, harness: "cursor" }, undefined).harness, null);
});

test("a stored harness reaches the form and back", () => {
  const form = configFormOf({ ...defaultAgentConfig, coding: true, harness: "claude-code" });
  assert.equal(form.harness, "claude-code");
  assert.equal(configOf(form, undefined).harness, "claude-code");
  assert.equal(configFormOf({ ...defaultAgentConfig, coding: true, harness: null }).harness, "");
});

test("a harness model reaches the form and back, trimmed; empty sends the subscription's default", () => {
  const stored = {
    ...defaultAgentConfig,
    coding: true,
    harness: "claude-code" as const,
    harness_model: "opus",
  };
  const form = configFormOf(stored);
  assert.equal(form.harness_model, "opus");
  assert.equal(configOf(form, undefined).harness_model, "opus");
  assert.equal(
    configOf({ ...form, harness_model: "  sonnet " }, undefined).harness_model,
    "sonnet",
  );
  assert.equal(configOf({ ...form, harness_model: "  " }, undefined).harness_model, null);
  assert.equal(configFormOf({ ...stored, harness_model: null }).harness_model, "");
  assert.equal(
    configOf({ ...form, harness: "" }, undefined).harness_model,
    null,
    "no model without a harness",
  );
});

test("a harness effort reaches the form and back; empty sends the harness's default", () => {
  const stored = {
    ...defaultAgentConfig,
    coding: true,
    harness: "codex" as const,
    harness_model: "gpt-6-luna",
    harness_effort: "high" as const,
  };
  const form = configFormOf(stored);
  assert.equal(form.harness_effort, "high");
  assert.equal(configOf(form, undefined).harness_effort, "high");
  assert.equal(configOf({ ...form, harness_effort: "" }, undefined).harness_effort, null);
  assert.equal(configFormOf({ ...stored, harness_effort: null }).harness_effort, "");
  assert.equal(configOf({ ...form, harness: "" }, undefined).harness_effort, null, "no effort without a harness");
  assert.equal(withCoding(form, false).harness_effort, "");
});

const CODEX_CATALOG: HarnessCatalog[] = [
  {
    harness: "codex",
    label: "Codex",
    enabled: true,
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "high"], default_effort: "low" },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: ["low", "ultra"], default_effort: "low" },
    ],
    unlisted_efforts: ["low", "high", "ultra"],
  },
];

test("another harness model keeps the effort while it runs at it, else goes back to the default", () => {
  const form = configFormOf({
    ...defaultAgentConfig,
    coding: true,
    harness: "codex",
    harness_model: "gpt-6-luna",
    harness_effort: "high",
  });
  assert.equal(withHarnessModel(form, "gpt-5.6-terra", CODEX_CATALOG).harness_effort, "");
  assert.equal(withHarnessModel(form, "gpt-custom", CODEX_CATALOG).harness_effort, "high");
  assert.equal(withHarnessModel(form, "", CODEX_CATALOG).harness_model, "");
  assert.equal(withHarnessModel(form, "gpt-5.6-terra", undefined).harness_effort, "high", "left to the server");
});

test("a harness model must be a model name, and turning coding off clears it", () => {
  const form = configFormOf({ ...defaultAgentConfig, coding: true, harness: "cursor" });
  assert.equal(
    configErrors({ ...form, harness_model: "claude-opus-4-8[context=1m]" }).harness_model,
    undefined,
  );
  assert.match(
    String(configErrors({ ...form, harness_model: "--force" }).harness_model),
    /Up to 120/,
  );
  assert.match(String(configErrors({ ...form, harness_model: "a b" }).harness_model), /Up to 120/);
  const off = withCoding({ ...form, harness_model: "gpt-5" }, false);
  assert.equal(off.harness_model, "");
  assert.equal(
    configErrors({ ...off, harness_model: "--force" }).harness_model,
    undefined,
    "only a coding agent is checked",
  );
});

test("secret aliases reach the form and back, and turning coding off keeps them", () => {
  const stored = {
    ...defaultAgentConfig,
    secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" },
  };
  const form = configFormOf(stored);
  assert.deepEqual(form.secret_aliases, { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" });
  assert.notEqual(form.secret_aliases, stored.secret_aliases, "the form holds its own copy");
  assert.deepEqual(configOf(form, undefined).secret_aliases, {
    CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN",
  });
  assert.deepEqual(
    withCoding({ ...form, coding: true }, false).secret_aliases,
    form.secret_aliases,
  );
});
