import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findHarnessModel,
  HARNESS_MODELS,
  harnessCatalog,
  harnessEffortOf,
  harnessEffortsFor,
  harnessLaunch,
} from "../../src/coding/harness-models.js";
import { HARNESS_MODEL_RE } from "../../src/coding/harnesses.js";
import { HARNESSES, EFFORTS } from "../../src/db/schema/index.js";

test("every listed model id, and every CLI name it starts under, is a model name the driver passes", () => {
  for (const harness of HARNESSES) {
    for (const entry of HARNESS_MODELS[harness]) {
      assert.match(entry.id, HARNESS_MODEL_RE);
      for (const name of Object.values(entry.ids ?? {})) assert.match(name, HARNESS_MODEL_RE);
    }
  }
});

test("a listed model's efforts are known efforts, and its default effort is one of them", () => {
  for (const harness of HARNESSES) {
    for (const entry of HARNESS_MODELS[harness]) {
      for (const effort of entry.efforts) assert.ok(EFFORTS.includes(effort), `${entry.id}: ${effort}`);
      if (entry.default_effort !== null) assert.ok(entry.efforts.includes(entry.default_effort), entry.id);
    }
  }
});

test("a Cursor model with a name per effort has one for each effort it lists", () => {
  for (const entry of HARNESS_MODELS.cursor.filter((item) => item.ids)) {
    assert.deepEqual(Object.keys(entry.ids!), [...entry.efforts], entry.id);
    assert.notEqual(entry.default_effort, null, entry.id);
  }
});

test("Cursor starts a listed model under the CLI name for its effort, with no effort apart", () => {
  assert.deepEqual(harnessLaunch("cursor", "claude-opus-5-5", "high"), { model: "claude-opus-5-5-high", effort: null });
  assert.deepEqual(harnessLaunch("cursor", "gpt-5.6-sol", "none"), { model: "gpt-5.6-sol-none", effort: null });
  assert.deepEqual(harnessLaunch("cursor", "claude-fable-5-1-thinking", "max"), {
    model: "claude-fable-5-1-thinking-max",
    effort: null,
  });
});

test("Cursor starts a listed model without an effort, or at one it does not list, under its default effort's name", () => {
  assert.deepEqual(harnessLaunch("cursor", "gpt-5.6-terra", null), { model: "gpt-5.6-terra-medium", effort: null });
  assert.deepEqual(harnessLaunch("cursor", "grok-4.7", "max"), { model: "grok-4.7-medium", effort: null });
});

test("Cursor starts a model without effort names, or a custom one, under its own name", () => {
  assert.deepEqual(harnessLaunch("cursor", "composer-2.5", null), { model: "composer-2.5", effort: null });
  assert.deepEqual(harnessLaunch("cursor", "claude-opus-4-8-high", "high"), { model: "claude-opus-4-8-high", effort: null });
  assert.deepEqual(harnessLaunch("cursor", null, null), { model: null, effort: null });
});

test("Claude Code and Codex start the model by its name, with the effort apart", () => {
  assert.deepEqual(harnessLaunch("claude-code", "opus", "xhigh"), { model: "opus", effort: "xhigh" });
  assert.deepEqual(harnessLaunch("codex", "gpt-5.6-terra", "ultra"), { model: "gpt-5.6-terra", effort: "ultra" });
  assert.deepEqual(harnessLaunch("claude-code", null, "low"), { model: null, effort: "low" });
  assert.deepEqual(harnessLaunch("codex", "custom-model", null), { model: "custom-model", effort: null });
});

test("a harness runs a listed model at its efforts, and any other at the efforts the harness takes", () => {
  assert.deepEqual(harnessEffortsFor("codex", "gpt-6-luna"), ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(harnessEffortsFor("codex", "gpt-5.6-terra").includes("ultra"));
  assert.deepEqual(harnessEffortsFor("claude-code", null), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(harnessEffortsFor("codex", "custom-model"), [...EFFORTS]);
  assert.deepEqual(harnessEffortsFor("cursor", "composer-2.5"), []);
  assert.deepEqual(harnessEffortsFor("cursor", "claude-opus-4-8-high"), []);
});

test("an agent's harness effort is a known effort, else none", () => {
  assert.equal(harnessEffortOf({ harness_effort: "high" }), "high");
  assert.equal(harnessEffortOf({ harness_effort: "turbo" }), null);
  assert.equal(harnessEffortOf({}), null);
  assert.equal(harnessEffortOf(null), null);
});

test("a listed model is found by its id; any other name is custom", () => {
  assert.equal(findHarnessModel("claude-code", "fable")?.label, "Fable");
  assert.equal(findHarnessModel("claude-code", "claude-opus-5-5"), null);
  assert.equal(findHarnessModel("codex", null), null);
});

test("the catalogue lists every harness's models without the CLI names they start under", () => {
  const catalog = harnessCatalog();
  assert.deepEqual(
    catalog.map((item) => item.harness),
    [...HARNESSES],
  );
  const cursor = catalog.find((item) => item.harness === "cursor")!;
  assert.equal(cursor.label, "Cursor");
  assert.deepEqual(cursor.unlisted_efforts, []);
  assert.ok(cursor.models.every((entry) => !("ids" in entry)));
  assert.deepEqual(cursor.models.find((entry) => entry.id === "grok-4.7"), {
    id: "grok-4.7",
    label: "Grok 4.7",
    efforts: ["low", "medium", "high", "xhigh"],
    default_effort: "medium",
  });
});
