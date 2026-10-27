import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import type { AppConfig } from "../../src/config/index.js";
import type { Repositories } from "../../src/db/repositories.js";
import {
  extensionIdentity,
  extensionInstanceAdmin,
  extensionModelCredentials,
  extensionOrgCreated,
  extensionPolicy,
  extensionSandboxes,
  extensionWebApp,
  type SandboxProvider,
  type ServerExtension,
} from "../../src/extension.js";
import { OPEN_POLICY } from "../../src/policy/index.js";

const repo = {} as Repositories;
const client = {} as pg.PoolClient;

test("extensions without a hook, a policy, or an identity leave core's own in place", () => {
  const plain: ServerExtension[] = [{ name: "a" }, { name: "b" }];
  assert.equal(extensionOrgCreated(plain), undefined);
  assert.equal(extensionPolicy(plain, { repo }), undefined);
  assert.equal(extensionIdentity(plain, { repo }), undefined);
  assert.equal(extensionInstanceAdmin(plain, { repo }), undefined);
  assert.equal(extensionModelCredentials(plain, { repo }), undefined);
});

test("the first extension that supplies model credentials is the one used", () => {
  const credentials = { modelCredentials: async () => ({ apiKey: "extension" }) };
  const supplied = extensionModelCredentials(
    [{ name: "a" }, { name: "b", modelCredentials: () => credentials }, { name: "c", modelCredentials: () => credentials }],
    { repo },
  );
  assert.equal(supplied, credentials);
});

test("every extension's hook for a new organisation runs, in order", async () => {
  const calls: string[] = [];
  const hook = extensionOrgCreated([
    { name: "a", orgCreated: async (_client, org) => void calls.push(`a:${org.id}`) },
    { name: "b" },
    { name: "c", orgCreated: async (_client, org) => void calls.push(`c:${org.id}`) },
  ]);
  await hook?.(client, { id: "org_1" }, new Date());
  assert.deepEqual(calls, ["a:org_1", "c:org_1"]);
});

test("the first extension that supplies a policy or an identity is the one used", async () => {
  const identity = { currentUser: async () => ({ id: "user_1" }) };
  const extensions: ServerExtension[] = [
    { name: "a", identity: () => undefined },
    { name: "b", policy: () => OPEN_POLICY, identity: () => identity },
    {
      name: "c",
      policy: () => {
        throw new Error("not reached");
      },
    },
  ];
  assert.equal(extensionPolicy(extensions, { repo }), OPEN_POLICY);
  assert.equal(extensionIdentity(extensions, { repo }), identity);

  const rule = async (userId: string) => userId === "user_admin";
  const supplied = extensionInstanceAdmin([{ name: "a" }, { name: "b", instanceAdmin: () => rule }], { repo });
  assert.equal(supplied, rule);
});

test("an extension's sandbox provider replaces core's, built from the services it is given", () => {
  const config = { sandboxImage: "agent-runtime:0.4" } as AppConfig;
  const masterKey = Buffer.alloc(32);
  assert.equal(extensionSandboxes([{ name: "a" }], { repo, config, masterKey }), undefined);
  const provider = {} as SandboxProvider;
  const seen: unknown[] = [];
  const supplied = extensionSandboxes(
    [
      { name: "a" },
      {
        name: "b",
        sandboxes: (services) => {
          seen.push(services.repo, services.config.sandboxImage, services.masterKey);
          return provider;
        },
      },
    ],
    { repo, config, masterKey },
  );
  assert.equal(supplied, provider);
  assert.deepEqual(seen, [repo, "agent-runtime:0.4", masterKey]);
});

test("the first extension that names a build of the operator app is the one served", () => {
  assert.equal(extensionWebApp([{ name: "a" }, { name: "b" }]), undefined);
  assert.equal(
    extensionWebApp([{ name: "a" }, { name: "b", webApp: "/srv/b/dist" }, { name: "c", webApp: "/srv/c/dist" }]),
    "/srv/b/dist",
  );
});
