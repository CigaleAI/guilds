import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogModel, ModelProvider, OrgModelProvider, OrgModels } from "../../../api/types";
import { configFormOf, defaultAgentConfig } from "./configForm";
import { withBrowser, withBrowserOptimized } from "./BrowserFields";

function provider(
  id: OrgModelProvider["id"],
  kind: OrgModelProvider["kind"],
  connected: boolean,
): OrgModelProvider {
  return { id, label: id, kind, connected, source: null, key_hint: null, base_url: null };
}

function model(id: string, kind: CatalogModel["kind"]): CatalogModel {
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
    kind,
    coding_only: kind === "coding",
  };
}

function providerOf(id: string): ModelProvider {
  const prefix = id.slice(0, id.indexOf("/"));
  const known: readonly ModelProvider[] = ["openai", "xai", "kimi"];
  const found = known.find((item) => item === prefix);
  if (!found) throw new RangeError(`no test provider for ${id}`);
  return found;
}

const catalog: OrgModels = {
  default: "openai/gpt-5",
  providers: [provider("kimi", "coding", true), provider("openai", "marketplace", true)],
  models: [
    model("kimi/k3", "coding"),
    model("openai/gpt-5-mini", "marketplace"),
    model("openai/gpt-5", "marketplace"),
  ],
};

const browsing = { ...configFormOf(defaultAgentConfig), browser: true };

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

test("a default that is a coding plan's model gives way to the first marketplace model", () => {
  const on = withBrowserOptimized(browsing, true, { ...catalog, default: "kimi/k3" });
  assert.equal(on.browser_model, "openai/gpt-5-mini");
});

test("a default whose provider is not connected gives way to the first connected model", () => {
  const models: OrgModels = {
    default: "openai/gpt-5",
    providers: [provider("openai", "marketplace", false), provider("xai", "marketplace", true)],
    models: [model("openai/gpt-5", "marketplace"), model("xai/grok", "marketplace")],
  };
  assert.equal(withBrowserOptimized(browsing, true, models).browser_model, "xai/grok");
});

test("without a marketplace model to offer, the browser model stays unpicked", () => {
  const codingOnly: OrgModels = {
    default: "kimi/k3",
    providers: [provider("kimi", "coding", true)],
    models: [model("kimi/k3", "coding")],
  };
  assert.equal(withBrowserOptimized(browsing, true, codingOnly).browser_model, "");
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
