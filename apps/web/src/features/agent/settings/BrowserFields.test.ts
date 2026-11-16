import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CatalogModel,
  ModelProvider,
  OrgModelProvider,
  OrgModels,
} from "../../../api/types/models";
import { configFormOf, defaultAgentConfig } from "./configForm";
import { withBrowser, withBrowserOptimized } from "./BrowserFields";

function provider(id: OrgModelProvider["id"], connected: boolean): OrgModelProvider {
  return { id, label: id, connected, source: null, key_hint: null, base_url: null };
}

function model(id: string): CatalogModel {
  return {
    id,
    model: id.slice(id.indexOf("/") + 1),
    provider: providerOf(id),
    label: id,
    thinking: false,
    temperature: true,
    attachments: false,
    context: null,
    price: null,
  };
}

function providerOf(id: string): ModelProvider {
  const prefix = id.slice(0, id.indexOf("/"));
  const known: readonly ModelProvider[] = ["openai", "xai"];
  const found = known.find((item) => item === prefix);
  if (!found) throw new RangeError(`no test provider for ${id}`);
  return found;
}

const catalog: OrgModels = {
  default: "openai/gpt-5",
  providers: [provider("openai", true)],
  models: [model("openai/gpt-5-mini"), model("openai/gpt-5")],
};

const browsing = { ...configFormOf(defaultAgentConfig, "key"), browser: true };

test("switching the browser off turns off the agent-optimized browser and clears its model", () => {
  const form = { ...browsing, browser_optimized: true, browser_model: "openai/gpt-5-mini" };
  const off = withBrowser(form, false);
  assert.equal(off.browser, false);
  assert.equal(off.browser_optimized, false);
  assert.equal(off.browser_model, "");
  const on = withBrowser(off, true);
  assert.equal(on.browser, true);
  assert.equal(on.browser_optimized, false);
  assert.deepEqual(withBrowser(form, true), form, "switching it on keeps the rest");
});

test("turning the agent-optimized browser on starts on the organisation's default model", () => {
  const on = withBrowserOptimized(browsing, true, catalog);
  assert.equal(on.browser_optimized, true);
  assert.equal(on.browser_model, "openai/gpt-5");
});

test("a default the organisation does not offer gives way to the first model it offers", () => {
  const on = withBrowserOptimized(browsing, true, { ...catalog, default: "xai/grok" });
  assert.equal(on.browser_model, "openai/gpt-5-mini");
});

test("a default whose provider is not connected gives way to the first connected model", () => {
  const models: OrgModels = {
    default: "openai/gpt-5",
    providers: [provider("openai", false), provider("xai", true)],
    models: [model("openai/gpt-5"), model("xai/grok")],
  };
  assert.equal(withBrowserOptimized(browsing, true, models).browser_model, "xai/grok");
});

test("without a model to offer, the browser model stays unpicked", () => {
  const none: OrgModels = { default: null, providers: [provider("openai", true)], models: [] };
  assert.equal(withBrowserOptimized(browsing, true, none).browser_model, "");
  assert.equal(withBrowserOptimized(browsing, true, undefined).browser_model, "");
});

test("turning the agent-optimized browser on keeps a model already picked", () => {
  const form = { ...browsing, browser_model: "openai/gpt-5-mini" };
  assert.equal(withBrowserOptimized(form, true, catalog).browser_model, "openai/gpt-5-mini");
});

test("turning the agent-optimized browser off clears its model", () => {
  const form = { ...browsing, browser_optimized: true, browser_model: "openai/gpt-5" };
  const off = withBrowserOptimized(form, false, catalog);
  assert.equal(off.browser_optimized, false);
  assert.equal(off.browser_model, "");
  assert.equal(off.browser, true, "the browser stays on");
});
