import assert from "node:assert/strict";
import { test } from "node:test";
import { configErrors, configFormOf, configOf, defaultAgentConfig, withBox, withCoding } from "./configForm";

test("switching coding on moves default limits to the coding budgets and back", () => {
  const form = configFormOf(defaultAgentConfig);
  assert.equal(form.cli, true);
  assert.equal(form.scripting, true);
  assert.equal(form.memory, true);
  assert.equal(form.browser, false);
  assert.equal(form.browser_language, "en-US");
  assert.equal(form.max_workspace_mib, "10240");
  const coding = withCoding(form, true);
  assert.equal(coding.coding, true);
  assert.equal(coding.cli, true);
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

test("turning coding off drops a Kimi Code model for the organisation's default, or nothing", () => {
  const form = { ...configFormOf(defaultAgentConfig), model: "kimi/kimi-for-coding", coding: true };
  const off = withCoding(form, false);
  assert.equal(off.model, "");
  assert.equal(off.coding, false);
  const models = { default: "openai/gpt-5", providers: [], models: [] };
  assert.equal(withCoding(form, false, models).model, "openai/gpt-5");
  assert.equal(withCoding({ ...form, model: "openai/gpt-5-mini" }, false, models).model, "openai/gpt-5-mini");
});

test("a model is required, must fit the coding flag, and must have its provider connected", () => {
  const form = configFormOf(defaultAgentConfig);
  assert.equal(configErrors(form).model, "Choose a model.");
  const models = {
    default: null,
    providers: [
      { id: "openai" as const, label: "OpenAI", kind: "marketplace" as const, connected: true, key_hint: "abcd", base_url: null },
      { id: "kimi" as const, label: "Kimi Code", kind: "coding" as const, connected: false, key_hint: null, base_url: null },
    ],
    models: [],
  };
  assert.equal(configErrors({ ...form, model: "openai/gpt-5" }, { models }).model, undefined);
  assert.equal(configErrors({ ...form, model: "kimi/k3" }, { models }).model, "Turn Coding on to use this model.");
  assert.equal(
    configErrors({ ...form, model: "kimi/k3", coding: true }, { models }).model,
    "Connect a Kimi Code key on Model keys first.",
  );
  assert.equal(configErrors({ ...form, model: "xai/grok" }, { models }).model, "Connect a xai key on Model keys first.");
});

test("limits the operator already changed stay as typed", () => {
  const form = { ...configFormOf(defaultAgentConfig), max_steps: "80" };
  const coding = withCoding(form, true);
  assert.equal(coding.max_steps, "80");
  assert.equal(coding.max_tool_calls, "200");
});

test("a new agent starts on the lite box; each box settles the flags it owns", () => {
  const form = configFormOf(defaultAgentConfig);
  assert.equal(form.box, "lite");
  assert.equal(form.cpu, "");
  assert.equal(configOf(form, undefined).box, "lite");
  assert.equal("cpu" in configOf(form, undefined), false);
  const standard = withBox(form, "standard");
  assert.equal(standard.box, "standard");
  assert.equal(standard.browser, true);
  assert.equal(standard.coding, false);
  assert.equal(standard.max_steps, "30");
  assert.equal(configOf(standard, undefined).box, "standard");
  const code = withBox(standard, "code");
  assert.equal(code.box, "code");
  assert.equal(code.browser, true);
  assert.equal(code.coding, true);
  assert.equal(code.cli, true);
  assert.equal(code.scripting, true);
  assert.equal(code.max_steps, "200");
  assert.equal(code.max_tool_calls, "200");
  assert.equal(configOf(code, undefined).box, "code");
  const lite = withBox({ ...code, model: "kimi/kimi-for-coding" }, "lite");
  assert.equal(lite.box, "lite");
  assert.equal(lite.browser, false);
  assert.equal(lite.coding, false);
  assert.equal(lite.max_steps, "30");
  assert.equal(lite.max_tool_calls, "50");
  assert.equal(lite.model, "");
  // The browser is the operator's on every box but lite: switching it off keeps the box.
  const quiet = { ...code, browser: false };
  assert.equal(configErrors(quiet).box, undefined);
  assert.equal(configOf(quiet, undefined).browser, false);
});

test("a custom box keeps the coding switch, starts its size from the tier it leaves, and sends it", () => {
  const form = configFormOf(defaultAgentConfig);
  const custom = withBox(form, "custom");
  assert.equal(custom.box, "custom");
  assert.equal(custom.browser, true);
  assert.equal(custom.coding, false);
  assert.equal(custom.cpu, "1");
  assert.equal(custom.memory_mib, "2048");
  const fromCode = withBox(withBox(form, "code"), "custom");
  assert.equal(fromCode.coding, true);
  assert.equal(fromCode.cpu, "2");
  assert.equal(fromCode.memory_mib, "4096");
  assert.equal(fromCode.max_steps, "200");
  const sent = configOf({ ...custom, cpu: "2.5", memory_mib: "6144" }, undefined);
  assert.equal(sent.cpu, 2.5);
  assert.equal(sent.memory_mib, 6144);
  // Leaving custom drops the size.
  const back = withBox({ ...custom, cpu: "2.5", memory_mib: "6144" }, "standard");
  assert.equal(back.cpu, "");
  assert.equal("cpu" in configOf(back, undefined), false);
  // A stored size comes back into the form.
  const stored = configFormOf({ ...defaultAgentConfig, box: "custom", browser: true, cpu: 1.75, memory_mib: 3072 });
  assert.equal(stored.cpu, "1.75");
  assert.equal(stored.memory_mib, "3072");
});

test("a stored config without a box reads the box its flags call for", () => {
  const { box: _box, ...stored } = defaultAgentConfig;
  assert.equal(configFormOf(stored as typeof defaultAgentConfig).box, "lite");
  assert.equal(configFormOf({ ...stored, coding: true } as typeof defaultAgentConfig).box, "code");
  assert.equal(configFormOf({ ...stored, browser: true } as typeof defaultAgentConfig).box, "standard");
  assert.equal(configFormOf({ ...stored, browser: true, coding: true } as typeof defaultAgentConfig).box, "code");
});

test("the box refuses the flags it settles, and a custom size out of bounds", () => {
  const form = configFormOf(defaultAgentConfig);
  assert.equal(configErrors(form).box, undefined);
  assert.match(configErrors({ ...form, browser: true }).box ?? "", /lite box/);
  const standard = withBox(form, "standard");
  assert.equal(configErrors(standard).box, undefined);
  assert.equal(configErrors({ ...standard, browser: false }).box, undefined);
  assert.match(configErrors({ ...standard, coding: true }).box ?? "", /Pick Code or Custom/);
  const code = withBox(form, "code");
  assert.equal(configErrors(code).box, undefined);
  assert.match(configErrors({ ...code, coding: false }).box ?? "", /code box has coding on/);
  const custom = withBox(form, "custom");
  assert.equal(configErrors(custom).box, undefined);
  assert.equal(configErrors(custom).cpu, undefined);
  assert.equal(configErrors(custom).memory_mib, undefined);
  assert.equal(configErrors({ ...custom, coding: true }).box, undefined);
  assert.match(configErrors({ ...custom, cpu: "" }).cpu ?? "", /0.5 to 4 CPUs/);
  assert.match(configErrors({ ...custom, cpu: "0.25" }).cpu ?? "", /0.5 to 4 CPUs/);
  assert.match(configErrors({ ...custom, cpu: "4.5" }).cpu ?? "", /0.5 to 4 CPUs/);
  assert.match(configErrors({ ...custom, cpu: "1.1" }).cpu ?? "", /steps of 0.25/);
  assert.equal(configErrors({ ...custom, cpu: "3.75" }).cpu, undefined);
  assert.match(configErrors({ ...custom, memory_mib: "256" }).memory_mib ?? "", /512 to 8192/);
  assert.match(configErrors({ ...custom, memory_mib: "8193" }).memory_mib ?? "", /512 to 8192/);
  assert.match(configErrors({ ...custom, memory_mib: "1024.5" }).memory_mib ?? "", /whole number/);
  assert.equal(configErrors({ ...custom, memory_mib: "8192" }).memory_mib, undefined);
  // The size is not checked on the other boxes.
  assert.equal(configErrors({ ...standard, cpu: "99" }).cpu, undefined);
});
