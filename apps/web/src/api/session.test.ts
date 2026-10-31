import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { rememberOrg, rememberUser, storedOrgId, storedUserId } from "./session";

/** A localStorage that keeps what it is given, as a browser's does. */
function pageStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "document", { value: { cookie: "" }, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("a remembered user and organisation are stored and read back", () => {
  Object.defineProperty(globalThis, "localStorage", { value: pageStorage(), configurable: true });
  rememberUser("u1");
  rememberOrg("o1");
  assert.equal(storedUserId(), "u1");
  assert.equal(storedOrgId(), "o1");
  rememberOrg(null);
  assert.equal(storedOrgId(), null);
});

test("without localStorage the cookie still carries the choice", () => {
  rememberUser("u1");
  assert.equal(document.cookie, "guilds_user=u1; Path=/; SameSite=Lax");
  assert.equal(storedUserId(), null);
});
