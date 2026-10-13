import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleTimers } from "../../src/generation/idle.js";

/** Waits for the key's armed stop to settle: run its callback, or end without it once cancelled. */
async function settled(timers: IdleTimers, key: string): Promise<void> {
  await timers.get(key)?.promise;
}

test("an armed key runs its callback once the timeout passes, and is gone after", async () => {
  const timers = new IdleTimers(5);
  const ran: string[] = [];
  let heldDuringCallback = false;
  timers.arm("mach_1", async () => {
    ran.push("mach_1");
    heldDuringCallback = timers.has("mach_1");
  });
  assert.deepEqual(timers.keys(), ["mach_1"]);
  await settled(timers, "mach_1");
  assert.deepEqual(ran, ["mach_1"]);
  assert.equal(heldDuringCallback, true, "the key is held while its callback runs");
  assert.equal(timers.has("mach_1"), false);
  assert.deepEqual(timers.keys(), []);
});

test("arming again restarts the timeout: the first arming never runs", async () => {
  const timers = new IdleTimers(20);
  const ran: string[] = [];
  timers.arm("mach_1", async () => {
    ran.push("first");
  });
  const first = timers.get("mach_1");
  timers.arm("mach_1", async () => {
    ran.push("second");
  });
  const second = timers.get("mach_1");
  assert.notEqual(first, second);
  assert.equal(first?.abort.signal.aborted, true);
  await first?.promise;
  assert.deepEqual(ran, []);
  assert.equal(timers.get("mach_1"), second, "the first arming ending leaves the second in place");
  await second?.promise;
  assert.deepEqual(ran, ["second"]);
  assert.equal(timers.has("mach_1"), false);
});

test("cancel stops the callback and drops the key; cancelling an unknown key is harmless", async () => {
  const timers = new IdleTimers(5);
  let ran = 0;
  timers.arm("mach_1", async () => {
    ran += 1;
  });
  const handle = timers.get("mach_1");
  timers.cancel("mach_1");
  timers.cancel("mach_unknown");
  assert.equal(timers.has("mach_1"), false);
  await handle?.promise;
  assert.equal(ran, 0);
});

test("a timeout of zero or less arms nothing", async () => {
  for (const timeout of [0, -1]) {
    const timers = new IdleTimers(timeout);
    let ran = 0;
    timers.arm("mach_1", async () => {
      ran += 1;
    });
    assert.equal(timers.has("mach_1"), false);
    assert.equal(timers.get("mach_1"), undefined);
    assert.equal(ran, 0);
  }
});

test("keys run independently, and a failing callback still drops its key", async () => {
  const timers = new IdleTimers(5);
  const ran: string[] = [];
  timers.arm("a", async () => {
    throw new Error("stop failed");
  });
  timers.arm("b", async () => {
    ran.push("b");
  });
  assert.deepEqual(timers.keys().sort(), ["a", "b"]);
  await Promise.all([settled(timers, "a"), settled(timers, "b")]);
  assert.deepEqual(ran, ["b"]);
  assert.deepEqual(timers.keys(), []);
});
