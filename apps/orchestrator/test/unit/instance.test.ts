import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CORE_INTEGRATIONS,
  GITHUB_APP,
  GROUP_ROUTING,
  WEB_SEARCH,
  integrationState,
  integrationStatuses,
  integrationValues,
  integrationVariable,
  missingVariables,
} from "../../src/instance/integrations.js";

const GITHUB_ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "guilds",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_CLIENT_ID: "client",
  GITHUB_APP_CLIENT_SECRET: "secret",
};

test("an integration is on only with every required variable set", () => {
  assert.equal(integrationState(GITHUB_APP, {}), "off");
  assert.equal(integrationState(GITHUB_APP, GITHUB_ENV), "on");
  assert.equal(integrationState(GITHUB_APP, { ...GITHUB_ENV, GITHUB_APP_SLUG: "  " }), "incomplete");
  assert.deepEqual(missingVariables(GITHUB_APP, { GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "guilds" }), [
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
  ]);
});

test("an optional variable tunes an integration without switching it", () => {
  assert.equal(integrationState(GROUP_ROUTING, { TYPESAFE_MODEL: "jev-next" }), "off");
  assert.equal(integrationState(GROUP_ROUTING, { TYPESAFE_API_KEY: "key" }), "on");
  assert.deepEqual(integrationValues(GROUP_ROUTING, { TYPESAFE_API_KEY: " key " }), {
    TYPESAFE_API_KEY: "key",
    TYPESAFE_MODEL: "",
  });
  assert.equal(integrationVariable(GROUP_ROUTING, "TYPESAFE_MODEL", { TYPESAFE_MODEL: "jev-next" }), "jev-next");
});

test("values come back only while the integration is on", () => {
  assert.equal(integrationValues(GITHUB_APP, { GITHUB_APP_ID: "1" }), null);
  assert.equal(integrationValues(GITHUB_APP, GITHUB_ENV)?.GITHUB_APP_CLIENT_SECRET, "secret");
  assert.equal(integrationValues(WEB_SEARCH, {}), null);
});

test("statuses name each integration and its variables without a value", () => {
  const env = { ...GITHUB_ENV, TAVILY_API_KEY: "tvly-secret-value", GITHUB_APP_PRIVATE_KEY: "" };
  const statuses = integrationStatuses(CORE_INTEGRATIONS, env);
  assert.deepEqual(
    statuses.map((item) => [item.id, item.state]),
    [
      ["web-search", "on"],
      ["group-routing", "off"],
      ["github-app", "incomplete"],
      ["google-connectors", "off"],
      ["error-reporting", "off"],
      ["registry", "on"],
      ["connector-code", "off"],
    ],
  );
  const github = statuses.find((item) => item.id === "github-app");
  assert.deepEqual(
    github?.variables.filter((variable) => !variable.set).map((variable) => variable.name),
    ["GITHUB_APP_PRIVATE_KEY"],
  );
  const text = JSON.stringify(statuses);
  for (const value of ["tvly-secret-value", "secret", "client"]) {
    assert.equal(text.includes(`"${value}"`), false, `${value} must not appear`);
  }
});

test("no two integrations share an id or a variable", () => {
  const ids = CORE_INTEGRATIONS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const names = CORE_INTEGRATIONS.flatMap((item) => item.variables.map((variable) => variable.name));
  assert.equal(new Set(names).size, names.length);
});

test("statuses say which tools and connectors each integration switches on, and none serves a model", () => {
  const provides = Object.fromEntries(
    integrationStatuses(CORE_INTEGRATIONS, {}).map((item) => [item.id, item.provides]),
  );
  assert.equal("openrouter" in provides, false);
  assert.equal("deepinfra" in provides, false);
  assert.deepEqual(provides["web-search"], { native_tools: [], connectors: ["tavily"] });
  assert.deepEqual(provides["github-app"], { native_tools: [], connectors: ["github"] });
  assert.deepEqual(provides["google-connectors"], { native_tools: [], connectors: ["gmail", "drive"] });
  assert.deepEqual(provides["group-routing"], { native_tools: [], connectors: [] });
});
