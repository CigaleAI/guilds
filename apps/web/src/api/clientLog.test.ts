import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { deliverReport, requestId, storedRequestId, storeRequestId } from "./clientLog";

const realFetch = globalThis.fetch;

/** A session storage that keeps what it is given, as a browser tab's does. */
function tabStorage(): Storage {
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

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

test("a request id is stored and read back while session storage is available", () => {
  Object.defineProperty(globalThis, "sessionStorage", { value: tabStorage(), configurable: true });
  assert.equal(storedRequestId(), null);
  assert.equal(storeRequestId("req-1"), true);
  assert.equal(storedRequestId(), "req-1");
});

test("without session storage nothing is stored or read", () => {
  assert.equal(storeRequestId("req-1"), false);
  assert.equal(storedRequestId(), null);
});

test("requestId keeps one id for the page when session storage is unavailable", () => {
  const id = requestId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(requestId(), id);
});

test("deliverReport says whether the orchestrator took the report", async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await deliverReport("{}"), true);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  assert.equal(await deliverReport("{}"), false);
});

test("deliverReport is false when the request fails", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await deliverReport("{}"), false);
});
