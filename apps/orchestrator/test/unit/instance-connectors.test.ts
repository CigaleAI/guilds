import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTORS } from "../../src/connectors/index.js";
import { instanceCredentials, instanceKey } from "../../src/connectors/instance.js";
import { loadManifest } from "../../src/connectors/manifest.js";
import { connectorIntegration, ownInstanceKind } from "../../src/connectors/instance.js";
import { CORE_INTEGRATIONS, connectorIntegrationId, integrationForConnector } from "../../src/instance/integrations.js";
import { storeKeys } from "../helpers/env.js";
import { endpointManifest } from "../helpers/registry.js";

const OWN_KEY = loadManifest(
  endpointManifest("acme", {
    display_name: "Acme",
    auth: {
      kind: "token",
      fields: [
        { name: "api_key", label: "Acme key" },
        { name: "region", label: "Region", secret: false, optional: true, placeholder: "eu" },
        { name: "cert", label: "Certificate", multiline: true },
      ],
      instance: { own: true },
    },
  }),
);
const BARE_KEY = loadManifest(endpointManifest("bare", { auth: { kind: "token", instance: { own: true } } }));
const OWN_CLIENT = loadManifest(endpointManifest("portal", { display_name: "Portal", auth: { kind: "oauth", oauth: { strategy: "configured" } } }));
const PLAIN = loadManifest(endpointManifest("plain"));
const DYNAMIC = loadManifest(endpointManifest("dyn", { auth: { kind: "oauth", oauth: { strategy: "dynamic" } } }));
const TAVILY = CONNECTORS.bySlug("tavily")!.manifest;
const GMAIL = CONNECTORS.bySlug("gmail")!.manifest;
const GITHUB = CONNECTORS.bySlug("github")!.manifest;

test("a connector holds a key or a client of its own, or nothing at instance level", () => {
  assert.equal(ownInstanceKind(OWN_KEY), "key");
  assert.equal(ownInstanceKind(BARE_KEY), "key");
  assert.equal(ownInstanceKind(OWN_CLIENT), "client");
  assert.equal(ownInstanceKind(PLAIN), null);
  assert.equal(ownInstanceKind(DYNAMIC), null);
  assert.equal(ownInstanceKind(TAVILY), null, "a shipped integration's key is not the connector's own");
  assert.equal(ownInstanceKind(GMAIL), null, "the box's Google client is not the connector's own");
  assert.equal(ownInstanceKind(GITHUB), null);
});

test("an own key becomes an integration under connector:<slug> with the login fields, secret unless said otherwise", () => {
  assert.equal(connectorIntegrationId("acme"), "connector:acme");
  assert.deepEqual(connectorIntegration(OWN_KEY), {
    id: "connector:acme",
    label: "Acme",
    enables: "Acme's platform login, for every organisation without a login of its own",
    source: "store",
    fields: [
      { name: "api_key", label: "Acme key", secret: true },
      { name: "region", label: "Region", secret: false, optional: true, placeholder: "eu" },
      { name: "cert", label: "Certificate", secret: true, multiline: true },
    ],
    provides: { connectors: ["acme"] },
  });
  assert.deepEqual(connectorIntegration(BARE_KEY)?.fields, [{ name: "token", label: "API key", secret: true }]);
});

test("an own configured client becomes an integration holding a client id and secret", () => {
  assert.deepEqual(connectorIntegration(OWN_CLIENT), {
    id: "connector:portal",
    label: "Portal OAuth client",
    enables: "Portal logins, through an OAuth client registered for this box",
    source: "store",
    fields: [
      { name: "client_id", label: "Client ID" },
      { name: "client_secret", label: "Client secret", secret: true },
    ],
    provides: { connectors: ["portal"] },
  });
  for (const manifest of [PLAIN, DYNAMIC, TAVILY, GMAIL, GITHUB]) {
    assert.equal(connectorIntegration(manifest), null, manifest.slug);
  }
});

test("integrationForConnector resolves a connector's own integration when it is listed", () => {
  const listed = [...CORE_INTEGRATIONS, connectorIntegration(OWN_KEY)!, connectorIntegration(OWN_CLIENT)!];
  assert.equal(integrationForConnector(OWN_KEY, listed)?.id, "connector:acme");
  assert.equal(integrationForConnector(OWN_CLIENT, listed)?.id, "connector:portal");
  assert.equal(integrationForConnector(PLAIN, listed), null);
  assert.equal(integrationForConnector(DYNAMIC, listed), null);
  assert.equal(integrationForConnector(TAVILY, listed)?.id, "web-search");
  assert.equal(integrationForConnector(GMAIL, listed)?.id, "google-connectors");
  assert.equal(integrationForConnector(OWN_KEY, CORE_INTEGRATIONS), null, "not before the box lists it");
  assert.equal(integrationForConnector(OWN_CLIENT, CORE_INTEGRATIONS), null);
});

test("a platform login on an own key reads every field from connector:<slug>, keyed by its first field", () => {
  const off = { keys: {} };
  assert.equal(instanceKey(OWN_KEY, off), null);
  assert.deepEqual(instanceCredentials(OWN_KEY, off), {});
  const on = { keys: storeKeys({ "connector:acme": { api_key: " k ", cert: "pem" } }) };
  assert.equal(instanceKey(OWN_KEY, on), "k");
  assert.deepEqual(instanceCredentials(OWN_KEY, on), { api_key: "k", region: "", cert: "pem" });
  const partial = { keys: storeKeys({ "connector:acme": { api_key: "k" } }) };
  assert.equal(instanceKey(OWN_KEY, partial), null, "a required field missing keeps the login off");
  assert.deepEqual(instanceCredentials(OWN_KEY, partial), {});
  const bare = { keys: storeKeys({ "connector:bare": { token: "t" } }) };
  assert.equal(instanceKey(BARE_KEY, bare), "t");
  assert.deepEqual(instanceCredentials(BARE_KEY, bare), { token: "t" });
  assert.equal(instanceKey(BARE_KEY, on), null, "another connector's key is not this one's");
  assert.deepEqual(instanceCredentials(PLAIN, on), {});
  assert.equal(instanceKey(OWN_CLIENT, { keys: storeKeys({ "connector:portal": { client_id: "a", client_secret: "b" } }) }), null, "a client serves logins, not a platform login");
});
