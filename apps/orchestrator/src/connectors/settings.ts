import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ConnectionSettings, SettingsSchema, SettingsTypeName } from "../db/schema/index.js";
import { isJsonObject, isObjectNode, JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from "../lib/json.js";

/**
 * A login's settings: the document a connector's `settings_schema` describes, stored beside the
 * login's credentials. The check covers the keywords `SettingsSchema` declares: `type`
 * (`object`, `array`, `string`, `number`, `integer`, `boolean`), `properties`, `required`,
 * `additionalProperties: false`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`,
 * `pattern`, and `enum`.
 */

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** The values each type name accepts. */
const TYPE_SHAPES = {
  object: JsonObjectSchema,
  array: Type.Array(JsonValueSchema),
  string: Type.String(),
  number: Type.Number(),
  integer: Type.Integer(),
  boolean: Type.Boolean(),
} satisfies Record<SettingsTypeName, TSchema>;

/** Checks a string against the schema's `minLength`, `maxLength` and `pattern`. */
function checkString(schema: SettingsSchema, value: string, path: string): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new SettingsError(`${path} must have at least ${schema.minLength} characters`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new SettingsError(`${path} must have at most ${schema.maxLength} characters`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    throw new SettingsError(`${path} must match ${schema.pattern}`);
  }
}

/** Checks an array against the schema's `minItems` and `maxItems`, and each entry against its `items`. */
function checkArray(schema: SettingsSchema, value: JsonValue[], path: string): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new SettingsError(`${path} must have at least ${schema.minItems} entries`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new SettingsError(`${path} must have at most ${schema.maxItems} entries`);
  }
  const items = schema.items ?? {};
  value.forEach((item, index) => check(items, item, `${path}[${index}]`));
}

/** Checks an object's `required` properties, each property against its schema, and `additionalProperties: false`. */
function checkObject(schema: SettingsSchema, value: JsonObject, path: string): void {
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (value[name] === undefined) {
      throw new SettingsError(`${path}.${name} is required`);
    }
  }
  for (const [name, item] of Object.entries(value)) {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (property !== undefined) {
      if (item !== undefined) {
        check(property, item, `${path}.${name}`);
      }
    } else if (schema.additionalProperties === false) {
      throw new SettingsError(`${path}.${name} is not a setting`);
    }
  }
}

function check(schema: SettingsSchema, value: JsonValue, path: string): void {
  if (schema.type !== undefined && !Value.Check(TYPE_SHAPES[schema.type], value)) {
    throw new SettingsError(`${path} must be ${schema.type}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    throw new SettingsError(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
  }
  if (Value.Check(TYPE_SHAPES.string, value)) {
    checkString(schema, value, path);
  }
  if (Array.isArray(value)) {
    checkArray(schema, value, path);
  }
  if (isObjectNode(value)) {
    checkObject(schema, value, path);
  }
}

/**
 * Asserts that `value`, a settings document as it arrives, is one a manifest's `settings_schema`
 * describes; throws `SettingsError` naming the first problem.
 */
export function validateSettings(schema: SettingsSchema, value: unknown): asserts value is ConnectionSettings {
  if (!isJsonObject(value)) {
    throw new SettingsError("settings must be object");
  }
  check(schema, value, "settings");
}

/** Whether the schema's required properties are all present in the stored settings. */
export function settingsComplete(schema: SettingsSchema | undefined, settings: ConnectionSettings): boolean {
  if (!schema) {
    return true;
  }
  return (schema.required ?? []).every((name) => settings[name] !== undefined);
}

/** The properties a search box fills, by name. */
export function lookupProperties(schema: SettingsSchema | undefined): string[] {
  return Object.entries(schema?.properties ?? {})
    .filter(([, property]) => property["x-lookup"] === true)
    .map(([name]) => name);
}
