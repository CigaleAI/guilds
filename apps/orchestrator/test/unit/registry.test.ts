import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { boxWiringProblem, endpointOnlyProblem, loadManifest, recipeManifestProblem } from "../../src/connectors/manifest.js";
import { integrationState, REGISTRY } from "../../src/instance/integrations.js";
import { codeManifestProblem, registryUrl } from "../../src/registry/client.js";
import {
  assertSigned,
  canonicalJson,
  compareVersions,
  parseIndex,
  pickEntry,
  RegistryError,
  RegistryFetchError,
  RegistryIndexError,
  RegistryNotFoundError,
  RegistryPackageError,
  registryPublicKey,
  RegistrySignatureError,
  signIndex,
} from "../../src/registry/index.js";
import { readTarball } from "../../src/registry/tar.js";
import { endpointManifest, fakeRegistry, registryKeys, tarball } from "../helpers/registry.js";

test("the registry is the default one while REGISTRY_URL is unset, and offline when it is set empty", () => {
  assert.equal(registryUrl({}), "https://registry.guilds.run");
  assert.equal(registryUrl({ REGISTRY_URL: "https://registry.example.com/" }), "https://registry.example.com");
  assert.equal(registryUrl({ REGISTRY_URL: " " }), null);
  assert.equal(integrationState(REGISTRY, { env: {} }), "on");
  assert.equal(integrationState(REGISTRY, { env: { REGISTRY_URL: "" } }), "off");
});

test("versions order numerically and the newest is picked unless one is named", () => {
  assert.ok(compareVersions("1.10.0", "1.9.3") > 0);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  const entries = [{ version: "1.2.0" }, { version: "1.10.0" }, { version: "1.9.0" }];
  assert.equal(pickEntry(entries)?.version, "1.10.0");
  assert.equal(pickEntry(entries, "1.2.0")?.version, "1.2.0");
  assert.equal(pickEntry(entries, "3.0.0"), null);
});

test("an index that does not match the schema is refused as a bad gateway", () => {
  const isIndexError = (error: unknown) => error instanceof RegistryIndexError && error.status === 502;
  assert.throws(() => parseIndex({ generated_at: "x", connectors: [{ slug: "Bad" }], recipes: [] }), isIndexError);
  assert.throws(() => parseIndex([]), isIndexError);
});

test("a tarball reads back its files and refuses a path that leaves it", () => {
  const files = readTarball(tarball({ "acme/connector.json": "{}", "acme/logo.svg": "<svg/>" }));
  assert.deepEqual([...files.keys()], ["acme/connector.json", "acme/logo.svg"]);
  assert.equal(files.get("acme/logo.svg")?.toString(), "<svg/>");
  assert.throws(
    () => readTarball(tarball({ "../escape.json": "{}" })),
    (error: unknown) => error instanceof RegistryPackageError && /leaves the archive/.test(error.message),
  );
  assert.throws(() => readTarball(Buffer.from("not gzip")), /gzipped/);
});

test("a registry failure is a RegistryError answered with the status of what failed", () => {
  assert.ok(new RegistryIndexError("x") instanceof RegistryError);
  assert.deepEqual(
    [
      new RegistryIndexError("x"),
      new RegistrySignatureError("x"),
      new RegistryFetchError("x"),
      new RegistryPackageError("x"),
      new RegistryNotFoundError("x"),
    ].map((error) => [error.name, error.status]),
    [
      ["RegistryIndexError", 502],
      ["RegistrySignatureError", 502],
      ["RegistryFetchError", 502],
      ["RegistryPackageError", 422],
      ["RegistryNotFoundError", 404],
    ],
  );
});

test("the client reads a connector package under one top-level folder", async () => {
  const registry = fakeRegistry();
  registry.connector("acme", "1.0.0", {
    "acme/connector.json": JSON.stringify(endpointManifest("acme")),
    "acme/logo.svg": "<svg/>",
  });
  const index = await registry.client.index();
  const pkg = await registry.client.connectorPackage(index.connectors[0]!);
  assert.equal(pkg.manifest.slug, "acme");
  assert.equal(pkg.manifest.endpoint?.url, "https://mcp.acme.example.com/mcp");
  assert.equal(pkg.adapter, null);
  assert.equal(pkg.logo?.toString(), "<svg/>");
});

test("a package whose bytes do not match the index is refused", async () => {
  const registry = fakeRegistry();
  registry.connector("acme", "1.0.0", { "connector.json": JSON.stringify(endpointManifest("acme")) });
  const entry = registry.index.connectors[0]!;
  registry.files.set(entry.path, tarball({ "connector.json": JSON.stringify(endpointManifest("acme", { description: "x" })) }));
  entry.size = registry.files.get(entry.path)!.length;
  await assert.rejects(() => registry.client.connectorPackage(entry), /does not match the index's hash/);
  entry.size += 1;
  await assert.rejects(() => registry.client.connectorPackage(entry), /the index says/);
});

test("a manifest that claims the box's credentials is refused, with or without code", async () => {
  const registry = fakeRegistry();
  registry.connector("coded", "1.0.0", {
    "connector.json": JSON.stringify(
      endpointManifest("coded", { auth: { kind: "token", instance: { integration: "web-search", field: "api_key" } } }),
    ),
    "adapter.js": "export default {}",
  });
  registry.connector("keyed", "1.0.0", {
    "connector.json": JSON.stringify(
      endpointManifest("keyed", { auth: { kind: "token", instance: { integration: "openrouter", field: "api_key" } } }),
    ),
  });
  registry.connector("google", "1.0.0", {
    "connector.json": JSON.stringify(
      endpointManifest("google", { auth: { kind: "oauth", oauth: { strategy: "configured", provider: "google-connectors" } } }),
    ),
  });
  registry.connector("mismatch", "1.0.0", { "connector.json": JSON.stringify(endpointManifest("other")) });
  const [coded, keyed, google, mismatch] = registry.index.connectors;
  await assert.rejects(() => registry.client.connectorPackage(coded!), /asks for the box's web-search key/);
  await assert.rejects(() => registry.client.connectorPackage(keyed!), /asks for the box's openrouter key/);
  await assert.rejects(() => registry.client.connectorPackage(google!), /signs in with the box's google-connectors client/);
  await assert.rejects(() => registry.client.connectorPackage(mismatch!), /does not match its folder/);
});

test("an endpoint-only manifest names no endpoint-less tools, box credentials, or state hook", () => {
  assert.equal(endpointOnlyProblem(loadManifest(endpointManifest("acme"))), null);
  assert.match(
    String(endpointOnlyProblem(loadManifest({ ...endpointManifest("acme"), endpoint: undefined }))),
    /no endpoint/,
  );
  assert.match(
    String(endpointOnlyProblem(loadManifest(endpointManifest("acme", { state: { key: "acme", intro: "Acme." } })))),
    /state hook/,
  );
});

test("a key or a client of a connector's own passes every check; the box's keys, client, and App pass none", () => {
  const ownKey = loadManifest(endpointManifest("acme", { auth: { kind: "token", instance: { own: true } } }));
  const ownClient = loadManifest(endpointManifest("portal", { auth: { kind: "oauth", oauth: { strategy: "configured" } } }));
  const ref = loadManifest(endpointManifest("ref", { auth: { kind: "token", instance: { integration: "web-search", field: "api_key" } } }));
  const provided = loadManifest(endpointManifest("mail", { auth: { kind: "oauth", oauth: { strategy: "configured", provider: "google-connectors" } } }));
  const app = loadManifest(endpointManifest("gh", { auth: { kind: "oauth", oauth: { strategy: "github_app" } } }));
  for (const check of [boxWiringProblem, endpointOnlyProblem, codeManifestProblem]) {
    assert.equal(check(ownKey), null, check.name);
    assert.equal(check(ownClient), null, check.name);
    assert.equal(
      check(ref),
      "connector ref asks for the box's web-search key, which only a connector the box ships may use; a key of its own is declared with own",
      check.name,
    );
    assert.equal(
      check(provided),
      "connector mail signs in with the box's google-connectors client; it declares a client of its own or registers one",
      check.name,
    );
    assert.match(String(check(app)), /connector gh signs in with the box's GitHub App/, check.name);
  }
  // Without code a package still needs an endpoint and may not hook state; code may do both.
  const stateful = loadManifest(endpointManifest("coded", { state: { key: "coded", intro: "Coded." } }));
  assert.match(String(endpointOnlyProblem(stateful)), /state hook/);
  assert.equal(boxWiringProblem(stateful), null);
  assert.equal(codeManifestProblem(stateful), null);
  const endpointless = loadManifest({ ...endpointManifest("coded"), endpoint: undefined });
  assert.match(String(endpointOnlyProblem(endpointless)), /no endpoint/);
  assert.equal(codeManifestProblem(endpointless), null);
  // A recipe's organisation server holds nothing at instance level: no key of its own, no configured client.
  assert.equal(recipeManifestProblem(loadManifest(endpointManifest("plain"))), null);
  assert.equal(recipeManifestProblem(loadManifest(endpointManifest("dyn", { auth: { kind: "oauth", oauth: { strategy: "dynamic" } } }))), null);
  assert.equal(recipeManifestProblem(ownKey), "connector acme asks for an instance key, which an organisation's server cannot hold");
  assert.equal(recipeManifestProblem(ownClient), "connector portal signs in with a configured client; an organisation's server registers its own");
  assert.match(String(recipeManifestProblem(ref)), /asks for the box's web-search key/);
  assert.match(String(recipeManifestProblem(provided)), /signs in with the box's google-connectors client/);
  assert.match(String(recipeManifestProblem(stateful)), /state hook/);
  assert.match(String(recipeManifestProblem(endpointless)), /no endpoint/);
});

test("a package may carry a bundled adapter, never its source", async () => {
  const registry = fakeRegistry();
  const manifest = JSON.stringify({ ...endpointManifest("coded"), endpoint: undefined, state: { key: "coded", intro: "Coded." } });
  registry.connector("coded", "1.0.0", { "connector.json": manifest, "adapter.js": "export default {}" });
  registry.connector("source", "1.0.0", { "connector.json": JSON.stringify(endpointManifest("source")), "adapter.ts": "export default {}" });
  const [coded, source] = registry.index.connectors;
  const pkg = await registry.client.connectorPackage(coded!);
  assert.equal(pkg.adapter?.toString(), "export default {}");
  assert.equal(pkg.manifest.state?.key, "coded");
  await assert.rejects(() => registry.client.connectorPackage(source!), /bundled adapter\.js/);
});

test("canonical JSON sorts keys at every depth and drops undefined", () => {
  assert.equal(canonicalJson({ b: [{ d: 1, c: undefined, a: "x" }], a: null }), '{"a":null,"b":[{"a":"x","d":1}]}');
});

test("a client with a key reads only an index that key signed", async () => {
  const keys = registryKeys();
  const other = registryKeys();
  const signed = fakeRegistry({ signWith: keys.privateKey, verifyWith: keys.publicKey });
  signed.connector("acme", "1.0.0", { "connector.json": JSON.stringify(endpointManifest("acme")) });
  assert.equal((await signed.client.index()).connectors.length, 1);
  assert.equal(signed.client.verifiesSignatures, true);

  const wrong = fakeRegistry({ signWith: other.privateKey, verifyWith: keys.publicKey });
  await assert.rejects(
    () => wrong.client.index(),
    (error: unknown) => error instanceof RegistrySignatureError && /does not verify/.test(error.message),
  );

  const unsigned = fakeRegistry({ verifyWith: keys.publicKey });
  await assert.rejects(() => unsigned.client.index(), /unsigned/);

  const index = parseIndex({ generated_at: "2026-10-01T00:00:00Z", connectors: [], recipes: [] });
  const good = signIndex(index, keys.privateKey);
  assertSigned(good, registryPublicKey(keys.publicKey));
  assert.throws(() => assertSigned({ ...good, generated_at: "2030-01-01T00:00:00Z" }, registryPublicKey(keys.publicKey)), /does not verify/);
  assert.throws(() => registryPublicKey("bm90IGEga2V5"), /not an Ed25519 public key/);
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" });
  assert.throws(() => registryPublicKey(ec.toString("base64")), {
    message: "REGISTRY_PUBLIC_KEY is not an Ed25519 public key: not an Ed25519 key",
  });
});
