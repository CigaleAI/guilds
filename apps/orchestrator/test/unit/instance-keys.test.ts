import assert from "node:assert/strict";
import { test } from "node:test";
import { replacesGithubApp } from "../../src/instance/changes.js";
import { GITHUB_APP, GROUP_ROUTING, REGISTRY, WEB_SEARCH } from "../../src/instance/integrations.js";
import { InstanceKeyError, validateKeyValues } from "../../src/instance/keys.js";

function refused(work: () => unknown, pattern: RegExp): void {
  assert.throws(
    work,
    (error: unknown) => error instanceof InstanceKeyError && error.status === 400 && pattern.test(error.message),
  );
}

test("a write keeps each field trimmed and needs every required one", () => {
  assert.deepEqual(validateKeyValues(WEB_SEARCH, { api_key: "  tvly-key \n" }), { api_key: "tvly-key" });
  refused(() => validateKeyValues(WEB_SEARCH, {}), /Web search needs Tavily API key/);
  refused(() => validateKeyValues(WEB_SEARCH, { api_key: "   " }), /needs Tavily API key/);
  refused(
    () => validateKeyValues(GITHUB_APP, { app_id: "1", slug: "s" }),
    /GitHub App needs Private key \(PEM\), Client ID, Client secret/,
  );
});

test("an optional field is left out when empty and kept trimmed when given", () => {
  assert.deepEqual(validateKeyValues(GROUP_ROUTING, { api_key: "k", model: "" }), { api_key: "k" });
  assert.deepEqual(validateKeyValues(GROUP_ROUTING, { api_key: "k", model: "  " }), { api_key: "k" });
  assert.deepEqual(validateKeyValues(GROUP_ROUTING, { api_key: "k" }), { api_key: "k" });
  assert.deepEqual(validateKeyValues(GROUP_ROUTING, { api_key: "k", model: " jev-next " }), { api_key: "k", model: "jev-next" });
});

test("a field the integration lacks, an env-sourced integration, and a value that is not a string are refused", () => {
  refused(() => validateKeyValues(WEB_SEARCH, { api_key: "k", token: "x" }), /Web search has no field token/);
  refused(() => validateKeyValues(REGISTRY, { REGISTRY_URL: "https://r.example" }), /Registry is read from the environment/);
  refused(() => validateKeyValues(WEB_SEARCH, { api_key: 42 }), /Tavily API key must be a string/);
  refused(() => validateKeyValues(WEB_SEARCH, { api_key: null }), /must be a string/);
  refused(() => validateKeyValues(WEB_SEARCH, "api_key=k"), /values must be an object/);
  refused(() => validateKeyValues(WEB_SEARCH, [["api_key", "k"]]), /values must be an object/);
  refused(() => validateKeyValues(WEB_SEARCH, null), /values must be an object/);
});

test("a GitHub App write replaces the App when its id changes or the row goes away, not when a secret rotates", () => {
  const app = { app_id: "1", slug: "a", private_key: "p", client_id: "c", client_secret: "s" };
  assert.equal(replacesGithubApp(null, app), false);
  assert.equal(replacesGithubApp(app, app), false);
  assert.equal(replacesGithubApp(app, { ...app, private_key: "rotated", client_secret: "rotated" }), false);
  assert.equal(replacesGithubApp(app, { ...app, app_id: "2" }), true);
  assert.equal(replacesGithubApp(app, null), true);
  assert.equal(replacesGithubApp({ slug: "a" }, null), false);
  assert.equal(replacesGithubApp(null, null), false);
});
