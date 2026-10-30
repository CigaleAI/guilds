import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTORS } from "../../src/connectors/index.js";
import { installedManifests } from "../../src/connectors/servers.js";
import {
  auditedIntegrationStatuses,
  CORE_INTEGRATIONS,
  ERROR_REPORTING,
  GITHUB_APP,
  REGISTRY,
  SYSTEM_ONE,
  SystemOneProviderError,
  WEB_SEARCH,
  instanceKeys,
  integrationForConnector,
  integrationState,
  integrationStatuses,
  integrationValue,
  integrationValues,
  missingFields,
  setInstanceKeys,
} from "../../src/instance/integrations.js";
import { storeKeys } from "../helpers/env.js";

const GITHUB_VALUES = { app_id: "1", slug: "guilds", private_key: "pem-value", client_id: "client-value", client_secret: "secret-value" };

function github(values: Record<string, string>) {
  return { keys: storeKeys({ "github-app": values }) };
}

test("a store integration is on only with every required field set, and reads nothing from the environment", () => {
  assert.equal(integrationState(GITHUB_APP, { keys: {} }), "off");
  assert.equal(integrationState(GITHUB_APP, github(GITHUB_VALUES)), "on");
  assert.equal(integrationState(GITHUB_APP, github({ ...GITHUB_VALUES, slug: "  " })), "incomplete");
  assert.deepEqual(
    missingFields(GITHUB_APP, github({ app_id: "1", slug: "guilds" })).map((field) => field.name),
    ["private_key", "client_id", "client_secret"],
  );
  assert.equal(
    integrationState(WEB_SEARCH, { env: { api_key: "tvly", TAVILY_API_KEY: "tvly" }, keys: {} }),
    "off",
    "a variable named like a store field is not a value",
  );
});

test("an env integration reads its variables; a default keeps it on without counting as set", () => {
  assert.equal(integrationState(REGISTRY, { env: {} }), "on");
  assert.equal(integrationValue(REGISTRY, "REGISTRY_URL", { env: {} }), "https://registry.guilds.run");
  assert.equal(integrationState(REGISTRY, { env: { REGISTRY_URL: "" } }), "off");
  assert.equal(integrationValue(REGISTRY, "REGISTRY_URL", { env: { REGISTRY_URL: " https://r.example " } }), "https://r.example");
  assert.deepEqual(missingFields(ERROR_REPORTING, { env: {} }), [{ name: "SENTRY_DSN", label: "Sentry DSN" }]);
  assert.equal(integrationState(ERROR_REPORTING, { env: { SENTRY_DSN: "https://k@sentry.example/1" } }), "on");
  assert.equal(
    integrationState(ERROR_REPORTING, { env: {}, keys: storeKeys({ "error-reporting": { SENTRY_DSN: "x" } }) }),
    "off",
    "a store row is not a value for an env integration",
  );
});

test("an optional field tunes an integration without switching it", () => {
  const systemOne = (values: Record<string, string>) => ({ keys: storeKeys({ "system-one": values }) });
  assert.equal(integrationState(SYSTEM_ONE, systemOne({ model: "jev-next" })), "off");
  assert.equal(integrationState(SYSTEM_ONE, systemOne({ api_key: "key" })), "on");
  assert.deepEqual(integrationValues(SYSTEM_ONE, systemOne({ api_key: " key " })), { provider: "", api_key: "key", model: "" });
  assert.equal(integrationValue(SYSTEM_ONE, "model", systemOne({ model: "jev-next" })), "jev-next");
});

test("System One accepts a blank or listed provider and refuses any other", () => {
  const validate = SYSTEM_ONE.validate;
  assert.ok(validate);
  validate({ api_key: "key" });
  validate({ api_key: "key", provider: "typesafe" });
  assert.throws(
    () => validate({ api_key: "key", provider: "other" }),
    (error: unknown) =>
      error instanceof SystemOneProviderError && /"other"/.test(error.message) && /typesafe/.test(error.message),
  );
});

test("values come back only while the integration is on, typed by field name", () => {
  assert.equal(integrationValues(GITHUB_APP, github({ app_id: "1" })), null);
  const values = integrationValues(GITHUB_APP, github(GITHUB_VALUES));
  assert.equal(values?.client_secret, "secret-value");
  assert.equal(values?.app_id, "1");
  assert.equal(integrationValues(WEB_SEARCH, { keys: {} }), null);
});

test("readers resolve store fields from the process snapshot unless given other keys", () => {
  setInstanceKeys(storeKeys({ "web-search": { api_key: "tvly-snapshot" } }));
  try {
    assert.equal(integrationValue(WEB_SEARCH, "api_key"), "tvly-snapshot");
    assert.equal(integrationState(WEB_SEARCH), "on");
    assert.equal(integrationState(WEB_SEARCH, { keys: {} }), "off");
    assert.equal(integrationState(WEB_SEARCH, { env: {} }), "on", "an env override leaves the keys alone");
    assert.equal(instanceKeys()["web-search"]?.set_by, "operator");
  } finally {
    setInstanceKeys({});
  }
  assert.equal(integrationState(WEB_SEARCH), "off");
});

test("statuses name each integration, its source and its fields with labels, never a value", () => {
  const sources = {
    env: { REGISTRY_PUBLIC_KEY: "pk" },
    keys: storeKeys({
      "web-search": { api_key: "tvly-secret-value" },
      "github-app": { ...GITHUB_VALUES, private_key: "" },
    }),
  };
  const statuses = integrationStatuses(CORE_INTEGRATIONS, installedManifests(), sources);
  assert.deepEqual(
    statuses.map((item) => [item.id, item.source, item.state]),
    [
      ["web-search", "store", "on"],
      ["system-one", "store", "off"],
      ["github-app", "store", "incomplete"],
      ["google-connectors", "store", "off"],
      ["error-reporting", "env", "off"],
      ["registry", "env", "on"],
      ["connector-code", "env", "off"],
    ],
  );
  const githubStatus = statuses.find((item) => item.id === "github-app")!;
  assert.equal(githubStatus.setup, "github-app-manifest");
  assert.deepEqual(githubStatus.fields.filter((field) => !field.set).map((field) => field.name), ["private_key"]);
  assert.deepEqual(githubStatus.fields.find((field) => field.name === "private_key"), {
    name: "private_key",
    label: "Private key (PEM)",
    optional: false,
    secret: true,
    multiline: true,
    set: false,
  });
  const registry = statuses.find((item) => item.id === "registry")!;
  assert.equal(registry.setup, null);
  assert.deepEqual(
    registry.fields.map((field) => [field.name, field.optional, field.set]),
    [
      ["REGISTRY_URL", false, false],
      ["REGISTRY_PUBLIC_KEY", true, true],
    ],
    "the default URL keeps the registry on, but the variable itself is unset",
  );
  assert.ok(statuses.every((item) => item.updated_at === null && item.set_by === null), "no audit unless asked");
  const text = JSON.stringify(statuses);
  for (const value of ["tvly-secret-value", "secret-value", "client-value", "pem-value", "pk"]) {
    assert.equal(text.includes(`"${value}"`), false, `${value} must not appear`);
  }
});

test("audit adds when and by whom a store row was written; the environment has no audit", () => {
  const sources = {
    env: { SENTRY_DSN: "dsn" },
    keys: storeKeys({ "web-search": { api_key: "k" } }, "2026-10-09T08:00:00.000Z"),
  };
  const audited = auditedIntegrationStatuses(CORE_INTEGRATIONS, installedManifests(), sources);
  const web = audited.find((item) => item.id === "web-search")!;
  assert.equal(web.updated_at, "2026-10-09T08:00:00.000Z");
  assert.equal(web.set_by, "operator");
  const systemOne = audited.find((item) => item.id === "system-one")!;
  assert.equal(systemOne.updated_at, null);
  assert.equal(systemOne.set_by, null);
  const errors = audited.find((item) => item.id === "error-reporting")!;
  assert.equal(errors.state, "on");
  assert.equal(errors.updated_at, null);
  assert.equal(errors.set_by, null);
  const plain = integrationStatuses(CORE_INTEGRATIONS, installedManifests(), sources).find((item) => item.id === "web-search")!;
  assert.equal(plain.updated_at, null);
  assert.equal(plain.set_by, null);
});

test("a connector names the integration it requires or takes its platform key from", () => {
  assert.equal(integrationForConnector(CONNECTORS.bySlug("tavily")!.manifest)?.id, "web-search");
  assert.equal(integrationForConnector(CONNECTORS.bySlug("github")!.manifest)?.id, "github-app");
  assert.equal(integrationForConnector(CONNECTORS.bySlug("gmail")!.manifest)?.id, "google-connectors");
  assert.equal(integrationForConnector(CONNECTORS.bySlug("drive")!.manifest)?.id, "google-connectors");
  assert.equal(integrationForConnector(CONNECTORS.bySlug("notion")!.manifest), null);
  assert.equal(integrationForConnector(CONNECTORS.bySlug("tavily")!.manifest, [GITHUB_APP]), null, "only among the given integrations");
});

test("no two integrations share an id, and no integration two field names", () => {
  const ids = CORE_INTEGRATIONS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const integration of CORE_INTEGRATIONS) {
    const names = integration.fields.map((field) => field.name);
    assert.equal(new Set(names).size, names.length, integration.id);
  }
});

test("statuses say which tools and connectors each integration switches on, and none serves a model", () => {
  const provides = Object.fromEntries(
    integrationStatuses(CORE_INTEGRATIONS, installedManifests(), { keys: {} }).map((item) => [item.id, item.provides]),
  );
  assert.equal("openrouter" in provides, false);
  assert.equal("deepinfra" in provides, false);
  assert.deepEqual(provides["web-search"], { native_tools: [], connectors: ["tavily"] });
  assert.deepEqual(provides["github-app"], { native_tools: [], connectors: ["github"] });
  assert.deepEqual(provides["google-connectors"], { native_tools: [], connectors: ["gmail", "drive"] });
  assert.deepEqual(provides["system-one"], { native_tools: ["browse"], connectors: [] });
});
