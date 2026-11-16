/**
 * A short two-note chime made with Web Audio, so no sound file ships with the app, or an audio
 * file the operator chose in this browser. A browser allows sound only once the operator has
 * pressed a key or a pointer on the page; `primeChime` takes that first press to start the audio
 * context.
 */

import { readStored, writeStored, type StoredWrite } from "../../app/storage";

const notes = [
  { frequency: 784, at: 0 },
  { frequency: 1046.5, at: 0.09 },
] as const;
const noteLength = 0.22;
const peakGain = 0.08;

/** The largest audio file the chime will take, so this browser's storage still has room. */
export const maxChimeBytes = 256 * 1024;
/** Where this browser keeps the operator's chime sound. */
export const chimeSoundKey = "guilds-chime-sound";

/**
 * An audio file the operator chose for the chime, kept in this browser. `name` is the file's name
 * as the account menu shows it; `dataUrl` is the file as a data URL.
 */
export type ChimeSound = {
  name: string;
  dataUrl: string;
};

/**
 * How choosing a file as the chime ended: chosen and stored, too large, not an audio type, this
 * browser cannot decode it, or this browser refused to store it.
 */
export type ChimeChoice =
  | { kind: "chosen"; sound: ChimeSound }
  | { kind: "too-large" }
  | { kind: "not-audio" }
  | { kind: "undecodable" }
  | { kind: "unstored" };

let context: AudioContext | null = null;
/** The decoded custom chime, when the operator chose a file this browser can play. */
let customBuffer: AudioBuffer | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  if (typeof AudioContext === "undefined") return null;
  context = new AudioContext();
  return context;
}

/**
 * How resuming the chime's audio ended: resumed, refused by the browser until the operator has
 * pressed a key or a pointer, not needed because the audio is not suspended, or unavailable
 * without Web Audio.
 */
export type AudioResume = "resumed" | "refused" | "unneeded" | "unavailable";

/** Resumes the chime's audio when it is suspended. */
export async function resumeChimeAudio(): Promise<AudioResume> {
  const ctx = audio();
  if (!ctx) return "unavailable";
  if (ctx.state !== "suspended") return "unneeded";
  try {
    await ctx.resume();
    return "resumed";
  } catch {
    return "refused";
  }
}

/** Starts audio on the first key or pointer press; returns what stops listening for it. */
export function primeChime(): () => void {
  window.addEventListener("pointerdown", resumeChimeAudio, { passive: true });
  window.addEventListener("keydown", resumeChimeAudio, { passive: true });
  return () => {
    window.removeEventListener("pointerdown", resumeChimeAudio);
    window.removeEventListener("keydown", resumeChimeAudio);
  };
}

/** Plays the chime once. False while the browser has not allowed sound yet. */
export function playChime(): boolean {
  const ctx = audio();
  if (!ctx || ctx.state !== "running") return false;
  if (customBuffer) {
    playBuffer(ctx, customBuffer);
    return true;
  }
  for (const note of notes) playNote(ctx, note.frequency, ctx.currentTime + note.at);
  return true;
}

function playNote(ctx: AudioContext, frequency: number, at: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peakGain, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + noteLength);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + noteLength + 0.03);
}

function playBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}

/** The chime sound this browser has stored, or null for the built-in two notes. */
export function readChimeSound(): ChimeSound | null {
  const raw = readStored(chimeSoundKey);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isChimeSound(value) ? value : null;
  } catch {
    return null;
  }
}

function isChimeSound(value: unknown): value is ChimeSound {
  if (value === null || typeof value !== "object") return false;
  if (!("name" in value) || !("dataUrl" in value)) return false;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.dataUrl === "string" &&
    value.dataUrl.startsWith("data:")
  );
}

/** Decodes a stored custom chime so `playChime` rings it; without one, the built-in notes ring. */
export async function restoreChimeSound(): Promise<void> {
  const sound = readChimeSound();
  if (!sound) {
    customBuffer = null;
    return;
  }
  customBuffer = await decodeDataUrl(sound.dataUrl);
}

/** Makes this file the chime in this browser, and rings it from then on. */
export async function chooseChimeFile(file: File): Promise<ChimeChoice> {
  if (file.size > maxChimeBytes) return { kind: "too-large" };
  if (isNonAudioType(file)) return { kind: "not-audio" };
  const dataUrl = await dataUrlOf(file);
  if (dataUrl === null) return { kind: "undecodable" };
  const buffer = await decodeDataUrl(dataUrl);
  if (buffer === null) return { kind: "undecodable" };
  const sound: ChimeSound = { name: chimeFileName(file.name), dataUrl };
  if (writeStored(chimeSoundKey, JSON.stringify(sound)) === "unavailable") {
    return { kind: "unstored" };
  }
  customBuffer = buffer;
  return { kind: "chosen", sound };
}

/** Rings the built-in two notes again, and forgets a chosen file in this browser. */
export function chooseDefaultChime(): StoredWrite {
  const written = writeStored(chimeSoundKey, null);
  if (written === "stored") customBuffer = null;
  return written;
}

function isNonAudioType(file: File): boolean {
  return file.type !== "" && !file.type.startsWith("audio/");
}

function chimeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.length > 0 ? base : "chime";
}

function isReadDataUrl(value: FileReader["result"]): value is string {
  return typeof value === "string";
}

function dataUrlOf(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(isReadDataUrl(reader.result) ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function decodeDataUrl(dataUrl: string): Promise<AudioBuffer | null> {
  const ctx = audio();
  if (!ctx) return null;
  const bytes = bytesOfDataUrl(dataUrl);
  if (bytes === null) return null;
  try {
    return await ctx.decodeAudioData(bytes);
  } catch {
    return null;
  }
}

function bytesOfDataUrl(dataUrl: string): ArrayBuffer | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const payload = dataUrl.slice(comma + 1);
  try {
    const binary = dataUrl.slice(0, comma).includes(";base64")
      ? atob(payload)
      : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}
