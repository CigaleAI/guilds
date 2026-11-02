import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ConnectionSettings, Manifest } from "../db/schema/index.js";
import { keepMatching } from "../lib/decode.js";
import { isJsonObject, isObjectNode, JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from "../lib/json.js";

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

/** The JSON Schema of the settings a login of a connector stores, as the connector's manifest declares it. */
export type SettingsSchema = NonNullable<Manifest["settings_schema"]>;

/** A type name the check knows. */
const SettingsTypeName = Type.Union([
  Type.Literal("object"),
  Type.Literal("array"),
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("integer"),
  Type.Literal("boolean"),
]);

type SettingsTypeName = Static<typeof SettingsTypeName>;

/** The values each type name accepts. */
const TYPE_SHAPES = {
  object: JsonObjectSchema,
  array: Type.Array(JsonValueSchema),
  string: Type.String(),
  number: Type.Number(),
  integer: Type.Integer(),
  boolean: Type.Boolean(),
} satisfies Record<SettingsTypeName, TSchema>;

const Count = Type.Optional(Type.Integer({ minimum: 0 }));

/**
 * The keywords of a settings schema, or of a part of it, that the check reads. A keyword that does
 * not hold what JSON Schema puts there is left out, and checks nothing.
 */
const SettingsKeywords = Type.Object({
  type: Type.Optional(SettingsTypeName),
  properties: Type.Optional(Type.Record(Type.String(), JsonObjectSchema)),
  required: Type.Optional(Type.Array(Type.String())),
  additionalProperties: Type.Optional(Type.Boolean()),
  items: Type.Optional(JsonObjectSchema),
  minItems: Count,
  maxItems: Count,
  minLength: Count,
  maxLength: Count,
  pattern: Type.Optional(Type.String()),
  enum: Type.Optional(Type.Array(JsonValueSchema)),
  "x-lookup": Type.Optional(Type.Boolean()),
});

type SettingsKeywords = Static<typeof SettingsKeywords>;

/** The keywords of `schema` the check reads. */
function keywordsOf(schema: JsonObject): SettingsKeywords {
  return keepMatching(SettingsKeywords, schema) ?? {};
}

/** Checks a string against the schema's `minLength`, `maxLength` and `pattern`. */
function checkString(keywords: SettingsKeywords, value: string, path: string): void {
  if (keywords.minLength !== undefined && value.length < keywords.minLength) {
    throw new SettingsError(`${path} must have at least ${keywords.minLength} characters`);
  }
  if (keywords.maxLength !== undefined && value.length > keywords.maxLength) {
    throw new SettingsError(`${path} must have at most ${keywords.maxLength} characters`);
  }
  if (keywords.pattern !== undefined && !new RegExp(keywords.pattern).test(value)) {
    throw new SettingsError(`${path} must match ${keywords.pattern}`);
  }
}

/** Checks an array against the schema's `minItems` and `maxItems`, and each entry against its `items`. */
function checkArray(keywords: SettingsKeywords, value: JsonValue[], path: string): void {
  if (keywords.minItems !== undefined && value.length < keywords.minItems) {
    throw new SettingsError(`${path} must have at least ${keywords.minItems} entries`);
  }
  if (keywords.maxItems !== undefined && value.length > keywords.maxItems) {
    throw new SettingsError(`${path} must have at most ${keywords.maxItems} entries`);
  }
  const items = keywords.items ?? {};
  value.forEach((item, index) => check(items, item, `${path}[${index}]`));
}

/** Checks an object's `required` properties, each property against its schema, and `additionalProperties: false`. */
function checkObject(keywords: SettingsKeywords, value: JsonObject, path: string): void {
  const properties = keywords.properties ?? {};
  for (const name of keywords.required ?? []) {
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
    } else if (keywords.additionalProperties === false) {
      throw new SettingsError(`${path}.${name} is not a setting`);
    }
  }
}

function check(schema: JsonObject, value: JsonValue, path: string): void {
  const keywords = keywordsOf(schema);
  if (keywords.type !== undefined && !Value.Check(TYPE_SHAPES[keywords.type], value)) {
    throw new SettingsError(`${path} must be ${keywords.type}`);
  }
  if (keywords.enum !== undefined && !keywords.enum.some((option) => option === value)) {
    throw new SettingsError(`${path} must be one of ${keywords.enum.map(String).join(", ")}`);
  }
  if (Value.Check(TYPE_SHAPES.string, value)) {
    checkString(keywords, value, path);
  }
  if (Array.isArray(value)) {
    checkArray(keywords, value, path);
  }
  if (isObjectNode(value)) {
    checkObject(keywords, value, path);
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
  return (keywordsOf(schema).required ?? []).every((name) => settings[name] !== undefined);
}

/** The properties a search box fills, by name. */
export function lookupProperties(schema: SettingsSchema | undefined): string[] {
  return Object.entries(schema ? (keywordsOf(schema).properties ?? {}) : {})
    .filter(([, property]) => keywordsOf(property)["x-lookup"] === true)
    .map(([name]) => name);
}
