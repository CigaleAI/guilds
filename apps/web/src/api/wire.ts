/** Checks that narrow what the server sends before the app reads it as one of its types. */

/** A value JSON carries: a string, number, boolean or null, or an array or object of them. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. A field held as `undefined` is one JSON leaves out. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/** The value a JSON text holds; undefined when the text is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const JSON_SCALARS: readonly string[] = ["string", "number", "boolean"];

/** Whether a value is one JSON carries, every element and field of it included. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || JSON_SCALARS.includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

/** Whether a value is a JSON object: a plain object, every field of it a JSON value or left out. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((field) => field === undefined || isJsonValue(field));
}

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
