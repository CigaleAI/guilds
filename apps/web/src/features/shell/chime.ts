/**
 * A short two-note chime made with Web Audio, so no sound file ships with the app. A browser
 * allows sound only once the operator has pressed a key or a pointer on the page; `primeChime`
 * takes that first press to start the audio context.
 */

const notes = [
  { frequency: 784, at: 0 },
  { frequency: 1046.5, at: 0.09 },
] as const;
const noteLength = 0.22;
const peakGain = 0.08;

let context: AudioContext | null = null;

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
