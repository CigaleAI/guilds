import { isPlainRecord } from "../db/json.js";
import type { ConnectionSettings } from "../db/schema/index.js";

/**
 * A login's settings: the document a connector's `settings_schema` describes, stored beside the
 * login's credentials. The checker covers the JSON Schema a manifest may use: `type`
 * (`object`, `array`, `string`, `number`, `integer`, `boolean`), `properties`, `required`,
 * `additionalProperties: false`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`,
 * `pattern`, and `enum`. `x-lookup` marks a property the adapter's `lookup` fills.
 */

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

type Schema = Record<string, unknown>;

function schemaOf(value: unknown): Schema {
  return isPlainRecord(value) ? value : {};
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function check(schema: Schema, value: unknown, path: string): void {
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    throw new SettingsError(`${path} must be ${String(schema.type)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    throw new SettingsError(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      throw new SettingsError(`${path} must have at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      throw new SettingsError(`${path} must have at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      throw new SettingsError(`${path} must match ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      throw new SettingsError(`${path} must have at least ${schema.minItems} entries`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      throw new SettingsError(`${path} must have at most ${schema.maxItems} entries`);
    }
    const items = schemaOf(schema.items);
    value.forEach((item, index) => check(items, item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const properties = schemaOf(schema.properties);
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (value[String(name)] === undefined) {
        throw new SettingsError(`${path}.${String(name)} is required`);
      }
    }
    for (const [name, item] of Object.entries(value)) {
      if (name in properties) {
        check(schemaOf(properties[name]), item, `${path}.${name}`);
      } else if (schema.additionalProperties === false) {
        throw new SettingsError(`${path}.${name} is not a setting`);
      }
    }
  }
}

/** Checks a settings document against a manifest's `settings_schema`; throws `SettingsError` naming the first problem. */
export function validateSettings(schema: Record<string, unknown>, value: unknown): ConnectionSettings {
  if (!isPlainRecord(value)) {
    throw new SettingsError("settings must be object");
  }
  check(schema, value, "settings");
  return value;
}

/** Whether the schema's required properties are all present in the stored settings. */
export function settingsComplete(schema: Record<string, unknown> | undefined, settings: ConnectionSettings): boolean {
  if (!schema) {
    return true;
  }
  return (Array.isArray(schema.required) ? schema.required : []).every((name) => settings[String(name)] !== undefined);
}

/** The properties a search box fills, by name. */
export function lookupProperties(schema: Record<string, unknown> | undefined): string[] {
  return Object.entries(schemaOf(schema?.properties))
    .filter(([, property]) => schemaOf(property)["x-lookup"] === true)
    .map(([name]) => name);
}
