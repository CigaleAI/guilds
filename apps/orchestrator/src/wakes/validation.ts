/** The longest delay a wake-up may be set for, in minutes: six hours. */
export const WAKE_DELAY_MAX_MINUTES = 360;
/** The longest note a wake-up may carry, in characters, once trimmed. */
export const WAKE_MESSAGE_MAX = 1000;

/** A wake-up the run cannot set: a delay or note out of bounds, or no wake-ups left. */
export class WakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WakeError";
  }
}

/** The delay a call asks for: a whole number of minutes from 1 to 360. */
export function validateWakeDelay(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > WAKE_DELAY_MAX_MINUTES
  ) {
    throw new WakeError(`minutes must be a whole number from 1 to ${WAKE_DELAY_MAX_MINUTES}`);
  }
  return value;
}

/** The note a call leaves for its wake-up, trimmed; null when it leaves none or only whitespace. */
export function validateWakeNote(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new WakeError("message must be a string");
  }
  const text = value.trim();
  if (text.length > WAKE_MESSAGE_MAX) {
    throw new WakeError(`message must be at most ${WAKE_MESSAGE_MAX} characters`);
  }
  return text || null;
}
