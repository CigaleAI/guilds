import assert from "node:assert/strict";
import { test } from "node:test";
import { playChime, resumeChimeAudio } from "./chime";

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
  refusesResume = false;
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
  resume() {
    if (this.refusesResume) return Promise.reject(new Error("not allowed"));
    this.state = "running";
    return Promise.resolve();
  }
}

test("without Web Audio the chime is silent", () => {
  assert.equal(playChime(), false);
});

test("without Web Audio there is no audio to resume", async () => {
  assert.equal(await resumeChimeAudio(), "unavailable");
});

test("the chime waits until the browser allows sound", () => {
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  assert.equal(playChime(), false);
  assert.equal(FakeAudioContext.latest?.oscillators.length, 0);
});

test("a press resumes suspended audio once the browser allows it", async () => {
  const ctx = FakeAudioContext.latest;
  assert.ok(ctx);
  ctx.refusesResume = true;
  assert.equal(await resumeChimeAudio(), "refused");
  assert.equal(ctx.state, "suspended");
  ctx.refusesResume = false;
  assert.equal(await resumeChimeAudio(), "resumed");
  assert.equal(await resumeChimeAudio(), "unneeded");
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
