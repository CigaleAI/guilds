import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openSection,
  problemSection,
  modelStepComplete,
  sectionErrorKeys,
  sectionErrors,
  sectionHasErrors,
  sectionLabel,
  settingsKindOf,
  settingsSections,
} from "./sections";

test("an agent's sections follow the create dialog's steps for its kind", () => {
  assert.deepEqual(settingsSections("key"), ["identity", "model", "machine"]);
  assert.deepEqual(settingsSections("subscription"), ["identity", "harness", "machine"]);
  assert.deepEqual(settingsSections("coding"), [
    "identity",
    "machine",
    "harness",
    "model",
    "repositories",
  ]);
  assert.equal(sectionLabel("model", "key"), "Model");
  assert.equal(sectionLabel("model", "coding"), "Lead model");
});

test("the form's kind is coding first, then its model source", () => {
  assert.equal(settingsKindOf({ coding: true, model_source: "key" }), "coding");
  assert.equal(settingsKindOf({ coding: false, model_source: "subscription" }), "subscription");
  assert.equal(settingsKindOf({ coding: false, model_source: "key" }), "key");
});

test("a section link opens where its content lives for the agent's kind", () => {
  assert.equal(openSection(undefined, "key"), "identity");
  assert.equal(openSection("machine", "key"), "machine");
  assert.equal(openSection("machine", "coding"), "machine");
  assert.equal(openSection("harness", "coding"), "harness");
  assert.equal(openSection("harness", "key"), "model");
  assert.equal(openSection("repositories", "key"), "model");
  assert.equal(openSection("unknown", "coding"), "identity");
  assert.equal(openSection("harness", "subscription"), "harness");
  assert.equal(openSection("model", "subscription"), "harness");
  assert.equal(openSection("repositories", "subscription"), "harness");
});

test("a coding problem is fixed under Harness, or under Repositories when the guild has none", () => {
  assert.equal(problemSection({ kind: "harness" }), "harness");
  assert.equal(problemSection({ kind: "credential", label: "Claude Code" }), "harness");
  assert.equal(problemSection({ kind: "image", label: "Cursor" }), "harness");
  assert.equal(problemSection({ kind: "repositories" }), "repositories");
});

test("a section has errors when one of its fields does", () => {
  assert.equal(sectionHasErrors(sectionErrors.model, { max_steps: "bad" }), true);
  assert.equal(sectionHasErrors(sectionErrors.model, { max_wake_ups: "bad" }), true);
  assert.equal(sectionHasErrors(sectionErrors.machine, { max_steps: "bad" }), false);
  assert.equal(sectionHasErrors(sectionErrors.harness, { harness: "bad" }), true);
  assert.equal(sectionHasErrors(sectionErrors.harness, { max_workspace_mib: "bad" }), false);
});

test("a subscription agent's Harness owns the run-limit errors its Model would on a key", () => {
  assert.equal(
    sectionHasErrors(sectionErrorKeys("harness", "subscription"), { max_steps: "bad" }),
    true,
  );
  assert.equal(
    sectionHasErrors(sectionErrorKeys("harness", "subscription"), { model: "bad" }),
    false,
  );
  assert.equal(
    sectionHasErrors(sectionErrorKeys("harness", "coding"), { max_steps: "bad" }),
    false,
  );
  assert.deepEqual(sectionErrorKeys("machine", "subscription"), sectionErrors.machine);
});

test("a new agent's model step is complete on a key with a provider, on a subscription with a harness", () => {
  const key = { coding: false, model_source: "key" as const };
  const subscription = { coding: false, model_source: "subscription" as const };
  assert.equal(modelStepComplete(key, {}, false), true);
  assert.equal(modelStepComplete(key, {}, true), false);
  assert.equal(modelStepComplete(key, { model: "Choose a model." }, false), false);
  assert.equal(modelStepComplete(subscription, {}, true), true, "a subscription needs no provider");
  assert.equal(modelStepComplete(subscription, { harness: "Pick a harness." }, false), false);
  assert.equal(modelStepComplete(subscription, { model: "Choose a model." }, false), true);
});
