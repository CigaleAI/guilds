/** Checks that narrow what the server sends before the app reads it as one of its types. */

/** A value as JSON writes it. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object, whose fields can be read by name. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/** A list whose every item passes `isItem`. */
export function isListOf<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every((item) => isItem(item));
}

export function isStringList(value: unknown): value is string[] {
  return isListOf(value, isString);
}

/** Whether every named field of a record passes `isField`. */
export function hasFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  isField: (value: unknown) => boolean,
): boolean {
  return fields.every((field) => isField(record[field]));
}
