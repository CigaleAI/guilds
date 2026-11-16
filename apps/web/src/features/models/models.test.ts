import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogModel, OrgModelProvider, OrgModels } from "../../api/types/models";
import { formatProviderState, modelOptions, preselectedModel, setupProgress } from "./models";

function model(id: string): CatalogModel {
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
  };
}

const models: OrgModels = {
  default: "openai/gpt-5",
  providers: [
    { id: "openai", label: "OpenAI", connected: true, source: "own", key_hint: "abcd", base_url: null },
    { id: "xai", label: "xAI", connected: false, source: null, key_hint: null, base_url: null },
  ],
  models: [model("openai/gpt-5"), model("openai/gpt-5-mini"), model("xai/grok")],
};

test("the picker lists chosen models by connected provider", () => {
  const plain = modelOptions(models);
  assert.deepEqual(plain.map((group) => [group.label, group.options.map((option) => option.value)]), [
    ["OpenAI", ["openai/gpt-5", "openai/gpt-5-mini"]],
  ]);
  const kept = modelOptions(models, { current: "deepinfra/old" });
  assert.deepEqual(kept[0], { label: "Not offered", options: [{ value: "deepinfra/old", label: "deepinfra/old" }] });
  assert.deepEqual(modelOptions(undefined, { current: "openai/gpt-5" }), [
    { label: "Current", options: [{ value: "openai/gpt-5", label: "openai/gpt-5" }] },
  ]);
  assert.deepEqual(modelOptions(undefined), []);
});

test("the default is preselected where the picker lists it, else nothing", () => {
  assert.equal(preselectedModel(models), "openai/gpt-5");
  assert.equal(preselectedModel({ ...models, default: "xai/grok" }), "", "a provider that is not connected");
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

const provider = (patch: Partial<OrgModelProvider>): OrgModelProvider => ({
  id: "openai",
  label: "OpenAI",
  connected: false,
  source: null,
  key_hint: null,
  base_url: null,
  ...patch,
});

test("a connected provider's state names its key, and a local one its endpoint", () => {
  assert.equal(
    formatProviderState(provider({ connected: true, source: "own", key_hint: "abcd" })),
    "Connected · key ends in abcd",
  );
  assert.equal(
    formatProviderState(provider({ connected: true, source: "own" })),
    "Connected · key ends in …",
  );
  const local = { id: "local" as const, connected: true, source: "own" as const, base_url: "http://box:11434/v1" };
  assert.equal(formatProviderState(provider(local)), "Connected · http://box:11434/v1");
  assert.equal(
    formatProviderState(provider({ ...local, key_hint: "wxyz" })),
    "Connected · http://box:11434/v1 · key ends in wxyz",
  );
});

test("a provider not connected with the organisation's key says how to connect it", () => {
  assert.equal(formatProviderState(provider({})), "Not connected. Paste the organisation's key.");
  assert.equal(
    formatProviderState(provider({ connected: true, source: "platform" })),
    "Provided by the platform. Paste the organisation's key to run on it instead.",
  );
  assert.equal(
    formatProviderState(provider({ id: "local" })),
    "Not connected. Save the endpoint's URL, and a key when it needs one.",
  );
});
