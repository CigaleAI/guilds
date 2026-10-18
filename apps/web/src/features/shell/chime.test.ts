import assert from "node:assert/strict";
import { test } from "node:test";
import { playChime } from "./chime";

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeNode {
  connect<T>(node: T): T {
    return node;
  }
}

class FakeOscillator extends FakeNode {
  type = "";
  frequency = new FakeParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  start(at: number) {
    this.startedAt = at;
  }
  stop(at: number) {
    this.stoppedAt = at;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  state = "suspended";
  currentTime = 10;
  destination = {};
  oscillators: FakeOscillator[] = [];
  constructor() {
    FakeAudioContext.latest = this;
  }
  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createGain() {
    return new FakeGain();
  }
}

test("without Web Audio the chime is silent", () => {
  assert.equal(playChime(), false);
});

test("the chime waits until the browser allows sound", () => {
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  assert.equal(playChime(), false);
  assert.equal(FakeAudioContext.latest?.oscillators.length, 0);
});

test("the chime is two short rising notes", () => {
  const ctx = FakeAudioContext.latest;
  assert.ok(ctx);
  ctx.state = "running";
  assert.equal(playChime(), true);
  assert.deepEqual(
    ctx.oscillators.map((oscillator) => [
      oscillator.type,
      oscillator.frequency.value,
      oscillator.startedAt,
    ]),
    [
      ["sine", 784, 10],
      ["sine", 1046.5, 10.09],
    ],
  );
  assert.ok(ctx.oscillators.every((oscillator) => (oscillator.stoppedAt ?? 0) < 10.5));
});
