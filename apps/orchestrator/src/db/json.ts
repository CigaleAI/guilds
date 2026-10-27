export function jsonObj(value: unknown): unknown {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** The value when it is a plain object, else an empty one. */
export function recordOf(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}
