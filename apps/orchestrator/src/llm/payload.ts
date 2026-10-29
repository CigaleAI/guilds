// What a provider or the models.dev feed sends is JSON whose shape no type promises. A module that
// reads it narrows each value with a guard before it reads a field.

/** A JSON object: not null, not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string with something in it; null for anything else. */
export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
