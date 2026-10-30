import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readStored, writeStored } from "./storage";

function useStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("a value the browser keeps is stored, and null removes it", () => {
  useStorage(memoryStorage());
  assert.equal(writeStored("guilds-last", "g1"), "stored");
  assert.equal(readStored("guilds-last"), "g1");
  assert.equal(writeStored("guilds-last", null), "stored");
  assert.equal(readStored("guilds-last"), null);
});

test("a write the browser refuses is unavailable", () => {
  useStorage({
    ...memoryStorage(),
    setItem: () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    },
  });
  assert.equal(writeStored("guilds-last", "g1"), "unavailable");
});

test("a write without storage is unavailable", () => {
  assert.equal(writeStored("guilds-last", "g1"), "unavailable");
});
