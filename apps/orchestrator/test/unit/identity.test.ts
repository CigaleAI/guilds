import type pg from "pg";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../../src/config/index.js";
import { HttpError } from "../../src/http/errors.js";
import { currentUser, type IdentityProvider } from "../../src/http/identity.js";

const USERS = [{ id: "user_one", name: "one" }];

function repoOf(calls: string[]): pg.Pool {
  return {
    listUsers: async () => {
      calls.push("listUsers");
      return USERS;
    },
  } as unknown as pg.Pool;
}

const request = { headers: {} };

test("with one user and no provider, a request that names no one is that user", async () => {
  const user = await currentUser(repoOf([]) as never, request);
  assert.equal(user.id, "user_one");
});

test("an identity provider answers in place of core's modes", async () => {
  const calls: string[] = [];
  const identity: IdentityProvider = {
    currentUser: async () => ({ id: "user_from_provider" }),
  };
  const user = await currentUser(repoOf(calls) as never, request, {
    identity,
    config: { authMode: "compat-cookie" } as AppConfig,
  });
  assert.equal(user.id, "user_from_provider");
  assert.deepEqual(calls, [], "core's own lookup does not run");
});

test("a provider's refusal is final", async () => {
  const identity: IdentityProvider = {
    currentUser: async () => {
      throw new HttpError(401, "not signed in");
    },
  };
  await assert.rejects(
    () => currentUser(repoOf([]) as never, request, { identity }),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
});

test("session mode without its provider signs no one in", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => currentUser(repoOf(calls) as never, request, { config: { authMode: "session" } as AppConfig }),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
  assert.deepEqual(calls, [], "it never falls back to the unauthenticated lookup");
});
