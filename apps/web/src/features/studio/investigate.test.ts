import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearPin, keepPin, readPin, type StudioPin } from "./investigate";

const pin: StudioPin = {
  focus: { kind: "issue", issue_id: "iss_1", label: "Issue · a failed run" },
  prompt: "What caused this issue?",
};

/** A tab's session storage that keeps items in memory, and refuses writes once `full`. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    full: false,
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      if (this.full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
  };
}

function installStorage(storage: ReturnType<typeof memoryStorage>) {
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
}

function denyStorage() {
  Object.defineProperty(globalThis, "sessionStorage", {
    get() {
      throw new DOMException("The page has no storage.", "SecurityError");
    },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

test("a kept pin reads back for its session, and is gone once cleared", () => {
  const storage = memoryStorage();
  installStorage(storage);
  assert.equal(keepPin("stu_1", pin), true);
  assert.deepEqual(readPin("stu_1"), pin);
  assert.equal(readPin("stu_2"), null);
  clearPin("stu_1");
  assert.equal(readPin("stu_1"), null);
  assert.equal(storage.items.size, 0);
});

test("a pin is not kept where the tab denies storage or its storage is full", () => {
  denyStorage();
  assert.equal(keepPin("stu_1", pin), false);
  const storage = memoryStorage();
  storage.full = true;
  installStorage(storage);
  assert.equal(keepPin("stu_1", pin), false);
  assert.equal(readPin("stu_1"), null);
});

test("what a tab keeps under a pin's key reads as no pin when it is not one", () => {
  const storage = memoryStorage();
  installStorage(storage);
  storage.items.set(
    "studio-pin:stu_1",
    JSON.stringify({ focus: { kind: "issue" }, prompt: "Why?" }),
  );
  storage.items.set("studio-pin:stu_2", JSON.stringify(["What caused this issue?"]));
  storage.items.set("studio-pin:stu_3", "not json");
  assert.equal(readPin("stu_1"), null);
  assert.equal(readPin("stu_2"), null);
  assert.equal(readPin("stu_3"), null);
});

test("clearing a pin where the tab denies storage has nothing to forget", () => {
  denyStorage();
  assert.doesNotThrow(() => clearPin("stu_1"));
});
