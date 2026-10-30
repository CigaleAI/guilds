import type pg from "pg";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../../src/config/index.js";
import { HttpError } from "../../src/http/errors.js";
import { currentUser, signedInUserOrNull, type IdentityProvider } from "../../src/http/identity.js";
import { userRow } from "../helpers/users.js";

const USERS = [{ id: "user_one", name: "one" }];

function dbOf(calls: string[]): pg.Pool {
  return {
    query: async (text: string) => {
      calls.push(text);
      return { rows: USERS };
    },
  } as unknown as pg.Pool;
}

const request = { headers: {} };

test("with one user and no provider, a request that names no one is that user", async () => {
  const user = await currentUser(dbOf([]), request);
  assert.equal(user.id, "user_one");
});

test("an identity provider answers in place of core's modes", async () => {
  const calls: string[] = [];
  const identity: IdentityProvider = {
    currentUser: async () => userRow({ id: "user_from_provider" }),
  };
  const user = await currentUser(dbOf(calls), request, {
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
    () => currentUser(dbOf([]), request, { identity }),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
});

test("session mode without its provider signs no one in", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => currentUser(dbOf(calls), request, { config: { authMode: "session" } as AppConfig }),
    (error: unknown) => error instanceof HttpError && error.status === 401,
  );
  assert.deepEqual(calls, [], "it never falls back to the unauthenticated lookup");
});

test("a signed-in request reads as its user", async () => {
  const user = await signedInUserOrNull(dbOf([]), request);
  assert.equal(user?.id, "user_one");
});

test("a request the identity refuses reads as nobody signed in", async () => {
  const identity: IdentityProvider = {
    currentUser: async () => {
      throw new HttpError(401, "not signed in");
    },
  };
  assert.equal(await signedInUserOrNull(dbOf([]), request, { identity }), null);
});

test("a failure that is not a refusal is thrown, not read as nobody signed in", async () => {
  const identity: IdentityProvider = {
    currentUser: async () => {
      throw new Error("database unreachable");
    },
  };
  await assert.rejects(() => signedInUserOrNull(dbOf([]), request, { identity }), /database unreachable/);
});
