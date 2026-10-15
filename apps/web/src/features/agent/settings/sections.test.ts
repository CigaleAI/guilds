import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openSection,
  problemSection,
  sectionErrors,
  sectionHasErrors,
  sectionLabel,
  settingsSections,
} from "./sections";

test("an agent's sections follow the create dialog's steps for its kind", () => {
  assert.deepEqual(settingsSections(false), ["identity", "model", "machine"]);
  assert.deepEqual(settingsSections(true), [
    "identity",
    "machine",
    "harness",
    "model",
    "repositories",
  ]);
  assert.equal(sectionLabel("model", false), "Model");
  assert.equal(sectionLabel("model", true), "Lead model");
});

test("a section link opens where its content lives for the agent's kind", () => {
  assert.equal(openSection(undefined, false), "identity");
  assert.equal(openSection("machine", false), "machine");
  assert.equal(openSection("machine", true), "machine");
  assert.equal(openSection("harness", true), "harness");
  assert.equal(openSection("harness", false), "model");
  assert.equal(openSection("repositories", false), "model");
  assert.equal(openSection("unknown", true), "identity");
});

test("a coding problem is fixed under Harness, or under Repositories when the guild has none", () => {
  assert.equal(problemSection({ kind: "harness" }), "harness");
  assert.equal(problemSection({ kind: "credential", label: "Claude Code" }), "harness");
  assert.equal(problemSection({ kind: "image", label: "Cursor" }), "harness");
  assert.equal(problemSection({ kind: "repositories" }), "repositories");
});

test("a section has errors when one of its fields does", () => {
  assert.equal(sectionHasErrors(sectionErrors.model, { max_steps: "bad" }), true);
  assert.equal(sectionHasErrors(sectionErrors.machine, { max_steps: "bad" }), false);
  assert.equal(sectionHasErrors(sectionErrors.harness, { harness: "bad" }), true);
  assert.equal(sectionHasErrors(sectionErrors.harness, { max_workspace_mib: "bad" }), false);
});
