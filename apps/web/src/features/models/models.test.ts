import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogModel, OrgModels } from "../../api/types";
import { modelOptions, preselectedModel, setupProgress } from "./models";

function model(id: string, kind: "marketplace" | "coding" = "marketplace"): CatalogModel {
  const [provider, ...rest] = id.split("/");
  return {
    id,
    model: rest.join("/"),
    provider: provider as CatalogModel["provider"],
    label: rest.join("/"),
    thinking: true,
    temperature: true,
    attachments: false,
    context: null,
    price: null,
    kind,
    coding_only: kind === "coding",
  };
}

const models: OrgModels = {
  default: "openai/gpt-5",
  providers: [
    { id: "openai", label: "OpenAI", kind: "marketplace", connected: true, source: "own", key_hint: "abcd", base_url: null },
    { id: "xai", label: "xAI", kind: "marketplace", connected: false, source: null, key_hint: null, base_url: null },
    { id: "kimi", label: "Kimi Code", kind: "coding", connected: true, source: "own", key_hint: "efgh", base_url: null },
  ],
  models: [model("openai/gpt-5"), model("openai/gpt-5-mini"), model("kimi/k3", "coding")],
};

test("the picker lists chosen models by connected provider, coding rows only for a coding agent", () => {
  const plain = modelOptions(models, { coding: false });
  assert.deepEqual(plain.map((group) => [group.label, group.options.map((option) => option.value)]), [
    ["OpenAI", ["openai/gpt-5", "openai/gpt-5-mini"]],
  ]);
  const coding = modelOptions(models, { coding: true });
  assert.deepEqual(coding.map((group) => group.label), ["OpenAI", "Kimi Code"]);
  assert.deepEqual(modelOptions(models, { coding: true, marketplaceOnly: true }).map((group) => group.label), ["OpenAI"]);
  const kept = modelOptions(models, { current: "deepinfra/old" });
  assert.deepEqual(kept[0], { label: "Not offered", options: [{ value: "deepinfra/old", label: "deepinfra/old" }] });
  assert.deepEqual(modelOptions(undefined, { current: "openai/gpt-5" }), [
    { label: "Current", options: [{ value: "openai/gpt-5", label: "openai/gpt-5" }] },
  ]);
  assert.deepEqual(modelOptions(undefined), []);
});

test("the default is preselected where the picker lists it, else nothing", () => {
  assert.equal(preselectedModel(models), "openai/gpt-5");
  assert.equal(preselectedModel({ ...models, default: "kimi/k3" }, { coding: false }), "");
  assert.equal(preselectedModel({ ...models, default: "kimi/k3" }, { coding: true }), "kimi/k3");
  assert.equal(preselectedModel({ ...models, default: null }), "");
  assert.equal(preselectedModel(undefined), "");
});

test("setup progress follows a connected provider, chosen models, and a default", () => {
  assert.deepEqual(setupProgress(undefined).map((step) => step.done), [false, false, false]);
  const empty: OrgModels = {
    default: null,
    providers: models.providers.map((p) => ({ ...p, connected: false, source: null })),
    models: [],
  };
  assert.deepEqual(setupProgress(empty).map((step) => step.done), [false, false, false]);
  assert.deepEqual(setupProgress({ ...models, default: null, models: [] }).map((step) => step.done), [true, false, false]);
  assert.deepEqual(setupProgress(models).map((step) => step.done), [true, true, true]);
});
