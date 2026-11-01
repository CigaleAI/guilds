/** Checks that narrow what the server sends before the app reads it as one of its types. */

import type { ErrorReply, ValidationProblem } from "./client";
import type { LookupItem } from "./types/access";
import type { StudioFocusRequest } from "./types/studio";

/** A value JSON carries: a string, number, boolean or null, or an array or object of them. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. A field held as `undefined` is one JSON leaves out. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/**
 * A JSON Schema object: the keywords the app reads, beside whatever else the schema holds. Each of
 * its `properties` is a JSON Schema too.
 */
export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  /** The values the schema allows, when it lists them. */
  enum?: JsonValue[];
  properties?: { [name: string]: JsonSchema };
  required?: string[];
  maxItems?: number;
  /** Marks a connector setting whose values the connector finds by search. */
  "x-lookup"?: boolean;
  [keyword: string]: JsonValue | undefined;
};

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

/** Whether a value is text or left out. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

/** The check each keyword the app reads passes when a JSON Schema holds it. */
const schemaKeywordChecks = {
  type: (type) => isString(type) || isStringList(type),
  title: isString,
  description: isString,
  enum: Array.isArray,
  properties: (properties) =>
    isJsonObject(properties) && Object.values(properties).every(isJsonSchema),
  required: isStringList,
  maxItems: isNumber,
  "x-lookup": isBoolean,
} satisfies Record<string, (keyword: JsonValue) => boolean>;

/**
 * Whether a value is a JSON Schema object: a JSON object whose keywords the app reads have their
 * types, each of its properties a JSON Schema too.
 */
export function isJsonSchema(value: unknown): value is JsonSchema {
  return (
    isJsonObject(value) &&
    Object.entries(schemaKeywordChecks).every(([keyword, check]) => {
      const held = value[keyword];
      return held === undefined || check(held);
    })
  );
}

/** Whether every named field of a JSON object passes `isField`. */
export function hasFields(
  record: JsonObject,
  fields: readonly string[],
  isField: (value: JsonValue | undefined) => boolean,
): boolean {
  return fields.every((field) => isField(record[field]));
}

function isValidationProblem(value: unknown): value is ValidationProblem {
  return (
    isJsonObject(value) && hasFields(value, ["type", "msg"], isString) && isStringList(value.loc)
  );
}

/** Whether a failed reply's body carries a `detail` the app can read. */
export function isErrorReply(value: unknown): value is ErrorReply {
  if (!isJsonObject(value)) return false;
  const { detail } = value;
  if (isString(detail) || isListOf(detail, isValidationProblem)) return true;
  return isJsonObject(detail) && isString(detail.message);
}

/** Whether a value is a connector's item a lookup stores: an object whose id, name and symbol are text. */
export function isLookupItem(value: unknown): value is LookupItem {
  return isJsonObject(value) && hasFields(value, ["id", "name", "symbol"], isOptionalString);
}

/** An id or path a focus pin names, null when it names none, or left out. */
function isFocusText(value: unknown): value is string | null | undefined {
  return value === undefined || isStringOrNull(value);
}

/** A step or version a focus pin names, as a number or its digits; null or left out for none. */
function isFocusIndex(value: unknown): value is number | string | null | undefined {
  return value === undefined || isNumberOrNull(value) || isString(value);
}

/** Whether a value is the evidence a Studio message is pinned to: its kind, and ids that are text or null. */
export function isStudioFocusRequest(value: unknown): value is StudioFocusRequest {
  return (
    isJsonObject(value) &&
    isString(value.kind) &&
    hasFields(value, ["seq", "version_index"], isFocusIndex) &&
    hasFields(
      value,
      [
        "agent_id",
        "run_id",
        "call_id",
        "revision_id",
        "schedule_id",
        "display_path",
        "change_id",
        "issue_id",
        "tool_name",
      ],
      isFocusText,
    )
  );
}
