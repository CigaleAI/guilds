import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  chooseChimeFile,
  chooseDefaultChime,
  chimeSoundKey,
  maxChimeBytes,
  playChime,
  readChimeSound,
  restoreChimeSound,
  resumeChimeAudio,
} from "./chime";
import { writeStored } from "../../app/storage";

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

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  started = false;
  start() {
    this.started = true;
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  state = "suspended";
  currentTime = 10;
  destination = {};
  oscillators: FakeOscillator[] = [];
  sources: FakeBufferSource[] = [];
  refusesResume = false;
  refusesDecode = false;
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
  createBufferSource() {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  }
  decodeAudioData(_bytes: ArrayBuffer) {
    if (this.refusesDecode) return Promise.reject(new Error("undecodable"));
    return Promise.resolve({ duration: 0.2 });
  }
  resume() {
    if (this.refusesResume) return Promise.reject(new Error("not allowed"));
    this.state = "running";
    return Promise.resolve();
  }
}

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: File) {
    const type = file.type || "application/octet-stream";
    this.result = `data:${type};base64,AQID`;
    this.onload?.();
  }
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

describe("a chosen chime file", () => {
  const previous = {
    FileReader: Object.getOwnPropertyDescriptor(globalThis, "FileReader"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  };

  beforeEach(() => {
    Object.defineProperty(globalThis, "FileReader", {
      value: FakeFileReader,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
    const ctx = FakeAudioContext.latest;
    if (ctx) {
      ctx.refusesDecode = false;
      ctx.oscillators = [];
      ctx.sources = [];
      ctx.state = "running";
    }
  });

  afterEach(() => {
    chooseDefaultChime();
    if (previous.FileReader) Object.defineProperty(globalThis, "FileReader", previous.FileReader);
    else Reflect.deleteProperty(globalThis, "FileReader");
    if (previous.localStorage) {
      Object.defineProperty(globalThis, "localStorage", previous.localStorage);
    } else Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("a file over the size cap is refused and the built-in notes still ring", async () => {
    const file = new File([new Uint8Array(maxChimeBytes + 1)], "big.wav", { type: "audio/wav" });
    assert.deepEqual(await chooseChimeFile(file), { kind: "too-large" });
    assert.equal(readChimeSound(), null);
    const ctx = FakeAudioContext.latest;
    assert.ok(ctx);
    ctx.oscillators = [];
    assert.equal(playChime(), true);
    assert.equal(ctx.oscillators.length, 2);
    assert.equal(ctx.sources.length, 0);
  });

  test("a non-audio type is refused", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" });
    assert.deepEqual(await chooseChimeFile(file), { kind: "not-audio" });
    assert.equal(readChimeSound(), null);
  });

  test("a file this browser cannot decode is refused", async () => {
    const ctx = FakeAudioContext.latest;
    assert.ok(ctx);
    ctx.refusesDecode = true;
    const file = new File([new Uint8Array([1, 2, 3])], "bell.wav", { type: "audio/wav" });
    assert.deepEqual(await chooseChimeFile(file), { kind: "undecodable" });
    assert.equal(readChimeSound(), null);
  });

  test("a file this browser will not store is refused", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        ...memoryStorage(),
        setItem: () => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        },
      },
      configurable: true,
      writable: true,
    });
    const file = new File([new Uint8Array([1, 2, 3])], "bell.wav", { type: "audio/wav" });
    assert.deepEqual(await chooseChimeFile(file), { kind: "unstored" });
  });

  test("a chosen file is stored and rings in place of the notes", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "bell.wav", { type: "audio/wav" });
    const choice = await chooseChimeFile(file);
    assert.equal(choice.kind, "chosen");
    if (choice.kind !== "chosen") return;
    assert.equal(choice.sound.name, "bell.wav");
    assert.equal(readChimeSound()?.name, "bell.wav");
    const ctx = FakeAudioContext.latest;
    assert.ok(ctx);
    ctx.oscillators = [];
    assert.equal(playChime(), true);
    assert.equal(ctx.oscillators.length, 0);
    assert.equal(ctx.sources.length, 1);
    assert.equal(ctx.sources[0]?.started, true);
  });

  test("Default forgets the file and the built-in notes ring again", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "bell.wav", { type: "audio/wav" });
    assert.equal((await chooseChimeFile(file)).kind, "chosen");
    assert.equal(chooseDefaultChime(), "stored");
    assert.equal(readChimeSound(), null);
    const ctx = FakeAudioContext.latest;
    assert.ok(ctx);
    ctx.oscillators = [];
    ctx.sources = [];
    assert.equal(playChime(), true);
    assert.equal(ctx.oscillators.length, 2);
    assert.equal(ctx.sources.length, 0);
  });

  test("restore rings a stored file, and garbage in storage leaves the notes", async () => {
    assert.equal(readChimeSound(), null);
    writeStored(chimeSoundKey, "{not json");
    assert.equal(readChimeSound(), null);
    writeStored(
      chimeSoundKey,
      JSON.stringify({ name: "door.mp3", dataUrl: "data:audio/mpeg;base64,AQID" }),
    );
    assert.equal(readChimeSound()?.name, "door.mp3");
    await restoreChimeSound();
    const ctx = FakeAudioContext.latest;
    assert.ok(ctx);
    ctx.oscillators = [];
    ctx.sources = [];
    assert.equal(playChime(), true);
    assert.equal(ctx.sources.length, 1);
    assert.equal(ctx.oscillators.length, 0);
  });

  test("a file with no type is decoded, and a nameless file is stored as chime", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "", { type: "" });
    const choice = await chooseChimeFile(file);
    assert.equal(choice.kind, "chosen");
    if (choice.kind !== "chosen") return;
    assert.equal(choice.sound.name, "chime");
  });
});
