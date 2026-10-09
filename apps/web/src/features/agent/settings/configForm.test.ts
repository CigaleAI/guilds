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

test("turning coding off resets a Kimi Code model", () => {
  const form = { ...configFormOf(defaultAgentConfig), model: "kimi/kimi-for-coding", coding: true };
  const off = withCoding(form, false);
  assert.equal(off.model, defaultAgentConfig.model);
  assert.equal(off.coding, false);
});

test("limits the operator already changed stay as typed", () => {
  const form = { ...configFormOf(defaultAgentConfig), max_steps: "80" };
  const coding = withCoding(form, true);
  assert.equal(coding.max_steps, "80");
  assert.equal(coding.max_tool_calls, "200");
});

test("a new agent starts on the lite box; standard turns both flags on with the coding budgets", () => {
  const form = configFormOf(defaultAgentConfig);
  assert.equal(form.box, "lite");
  assert.equal(configOf(form, undefined).box, "lite");
  const standard = withBox(form, "standard");
  assert.equal(standard.box, "standard");
  assert.equal(standard.browser, true);
  assert.equal(standard.coding, true);
  assert.equal(standard.cli, true);
  assert.equal(standard.scripting, true);
  assert.equal(standard.max_steps, "200");
  assert.equal(standard.max_tool_calls, "200");
  assert.equal(configOf(standard, undefined).box, "standard");
  const lite = withBox({ ...standard, model: "kimi/kimi-for-coding" }, "lite");
  assert.equal(lite.box, "lite");
  assert.equal(lite.browser, false);
  assert.equal(lite.coding, false);
  assert.equal(lite.max_steps, "30");
  assert.equal(lite.max_tool_calls, "50");
  assert.equal(lite.model, defaultAgentConfig.model);
});

test("a stored config without a box reads the box its flags call for", () => {
  const { box: _box, ...stored } = defaultAgentConfig;
  assert.equal(configFormOf(stored as typeof defaultAgentConfig).box, "lite");
  assert.equal(configFormOf({ ...stored, coding: true } as typeof defaultAgentConfig).box, "standard");
  assert.equal(configFormOf({ ...stored, browser: true } as typeof defaultAgentConfig).box, "standard");
});

test("a standard box with browser and coding both off is an error", () => {
  const standard = withBox(configFormOf(defaultAgentConfig), "standard");
  assert.equal(configErrors(standard).box, undefined);
  assert.equal(configErrors({ ...standard, browser: false }).box, undefined);
  assert.match(configErrors({ ...standard, browser: false, coding: false }).box ?? "", /Pick Lite/);
  assert.equal(configErrors(configFormOf(defaultAgentConfig)).box, undefined);
});
