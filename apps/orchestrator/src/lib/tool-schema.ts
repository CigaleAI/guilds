// Shapes a JSON Schema for a model's tool call, and the arguments a model sends against it.
import type { Static, TObject } from "typebox";
import { assertMatches } from "./decode.js";
import { isJsonObject, isObjectNode, type JsonObject, type JsonValue } from "./json.js";

/**
 * A JSON Schema object of a tool's parameters, or of a part of them: the keywords tool calling
 * reads, on a JSON object that holds whatever other keyword the schema has.
 */
export type ToolSchema = JsonObject & {
  type?: string | string[];
  description?: string;
  format?: string;
  properties?: ToolSchemaProperties;
  required?: string[];
  items?: ToolSubschema | ToolSubschema[];
  prefixItems?: ToolSubschema[];
  anyOf?: ToolSubschema[];
  oneOf?: ToolSubschema[];
  allOf?: ToolSubschema[];
};

/** A schema where JSON Schema takes one: an object, or `true` or `false` for one that accepts every value or none. */
export type ToolSubschema = ToolSchema | boolean;

/** The properties of an object schema, each one's schema by its name. */
export type ToolSchemaProperties = { [name: string]: ToolSubschema };

/** A tool as a model is offered it: a function, with its name, what it does, and the JSON Schema of its parameters. */
export type FunctionTool = {
  type: "function";
  function: { name: string; description: string; parameters: ToolSchema };
};

/** The keywords whose value is a list of schemas. */
const LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/** Whether `value` is what JSON Schema puts under each keyword tool calling reads, when the keyword is present. */
const KEYWORD_HOLDS = {
  type: (value: JsonValue) => isString(value) || isStringList(value),
  description: isString,
  format: isString,
  properties: isSchemaProperties,
  required: isStringList,
  items: (value: JsonValue) => isSubschema(value) || isSubschemaList(value),
  prefixItems: isSubschemaList,
  anyOf: isSubschemaList,
  oneOf: isSubschemaList,
  allOf: isSubschemaList,
} satisfies Record<string, (value: JsonValue) => boolean>;

/** Whether a value is a JSON Schema object whose keywords tool calling reads hold what JSON Schema puts there, at every depth. */
export function isToolSchema(value: unknown): value is ToolSchema {
  return isJsonObject(value) && isSchemaNode(value);
}

/**
 * `parameters` as the JSON Schema the model is offered: what they serialise to, TypeBox's own
 * marks left out, and each choice among constants of one type (a union of literals) as that
 * type's `enum`.
 */
export function offeredParameters(parameters: TObject): ToolSchema {
  const offered: unknown = JSON.parse(JSON.stringify(parameters));
  if (!isToolSchema(offered)) {
    throw new TypeError("a tool's parameters must serialise to a JSON Schema object");
  }
  return withEnums(offered);
}

/** A type name whose values a JSON Schema `enum` lists. */
const ENUM_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** One alternative of a union of literals: a constant and the type it has, and nothing else. */
type ConstAlternative = { type: string; const: string | number | boolean };

/** Whether a value is a string, a number or a boolean. */
function isPrimitive(value: JsonValue | undefined): value is string | number | boolean {
  return value !== undefined && value !== null && !Array.isArray(value) && !isObjectNode(value);
}

/** Whether a schema is one alternative of a union of literals: only `type` and `const`, the constant of that type. */
function isConstAlternative(spec: ToolSubschema): spec is ToolSchema & ConstAlternative {
  if (!isSchemaObject(spec) || Object.keys(spec).length !== 2 || !isString(spec.type) || !ENUM_TYPES.has(spec.type)) {
    return false;
  }
  return isPrimitive(spec.const);
}

/** The constants of `alternatives` when they are a union of literals of one type, with that type; null otherwise. */
function literalChoice(alternatives: ToolSubschema[]): { type: string; values: Array<string | number | boolean> } | null {
  if (!alternatives.every(isConstAlternative)) {
    return null;
  }
  const [first] = alternatives;
  return first !== undefined && alternatives.every((alternative) => alternative.type === first.type)
    ? { type: first.type, values: alternatives.map((alternative) => alternative.const) }
    : null;
}

/** `spec` with every union of literals under it, and its own, as `{ type, enum }`; its other keywords kept. */
function withEnums(spec: ToolSchema): ToolSchema {
  const next: ToolSchema = { ...spec };
  if (next.properties !== undefined) {
    next.properties = Object.fromEntries(Object.entries(next.properties).map(([name, item]) => [name, subschemaWithEnums(item)]));
  }
  if (next.items !== undefined) {
    next.items = Array.isArray(next.items) ? next.items.map(subschemaWithEnums) : subschemaWithEnums(next.items);
  }
  for (const keyword of LIST_KEYWORDS) {
    const schemas = next[keyword];
    if (schemas !== undefined) {
      next[keyword] = schemas.map(subschemaWithEnums);
    }
  }
  const choice = next.anyOf === undefined ? null : literalChoice(next.anyOf);
  if (choice === null) {
    return next;
  }
  delete next.anyOf;
  return { ...next, type: choice.type, enum: choice.values };
}

function subschemaWithEnums(spec: ToolSubschema): ToolSubschema {
  return isSchemaObject(spec) ? withEnums(spec) : spec;
}

/** Whether a JSON object's keywords tool calling reads hold what JSON Schema puts there, at every depth. */
function isSchemaNode(node: JsonObject): node is ToolSchema {
  return Object.entries(KEYWORD_HOLDS).every(([keyword, holds]) => {
    const value = node[keyword];
    return value === undefined || holds(value);
  });
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isStringList(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isSubschema(value: JsonValue | undefined): value is ToolSubschema {
  return typeof value === "boolean" || (value !== undefined && isObjectNode(value) && isSchemaNode(value));
}

function isSubschemaList(value: JsonValue | undefined): value is ToolSubschema[] {
  return Array.isArray(value) && value.every(isSubschema);
}

function isSchemaProperties(value: JsonValue): value is ToolSchemaProperties {
  return isObjectNode(value) && Object.values(value).every(isSubschema);
}

/** Whether a schema is an object, and not `true` or `false`. */
function isSchemaObject(spec: ToolSubschema | undefined): spec is ToolSchema {
  return typeof spec === "object";
}

/** The type names a schema states: none, one, or several. */
function typeNames(spec: ToolSchema): string[] {
  return spec.type === undefined ? [] : [spec.type].flat();
}

/** Whether a schema object accepts null: its type names `null`, or one of its alternatives accepts it. */
function acceptsNull(spec: ToolSubschema): boolean {
  if (!isSchemaObject(spec)) {
    return false;
  }
  if (typeNames(spec).includes("null")) {
    return true;
  }
  return [spec.anyOf, spec.oneOf, spec.allOf].some((alternatives) => alternatives?.some(acceptsNull) ?? false);
}

const OPTIONAL_OMIT =
  "Optional. Omit this key when unused; do not pass an empty value.";

function alreadyStatesOptional(description: string): boolean {
  return /\b(optional|omit(?:ted|ting)?)\b/i.test(description);
}

function clarifyOptionalString(spec: ToolSchema): void {
  if (!typeNames(spec).includes("string")) {
    return;
  }
  const description = spec.description?.trim() ?? "";
  if (description && alreadyStatesOptional(description)) {
    return;
  }
  spec.description = description ? `${OPTIONAL_OMIT} ${description}` : OPTIONAL_OMIT;
}

/**
 * Prepare a JSON Schema for tool-calling: drop validator-only constraints that
 * force a placeholder, and mark optional strings so unused keys are omitted.
 * Required non-null fields keep `format`.
 */
export function llmToolParameters(schema: ToolSchema, loose = false): ToolSchema {
  const { properties } = schema;
  if (properties === undefined) {
    return schema;
  }
  const required = new Set(schema.required);
  const sanitized: ToolSchemaProperties = {};
  for (const [name, spec] of Object.entries(properties)) {
    sanitized[name] = sanitizeProperty(
      spec,
      !loose && required.has(name) && !acceptsNull(spec),
      !loose,
    );
  }
  const next: ToolSchema = { ...schema, properties: sanitized };
  if (next.additionalProperties === false) {
    delete next.additionalProperties;
  }
  delete next.$schema;
  return next;
}

function sanitizeProperty(spec: ToolSubschema, required: boolean, annotateOptional: boolean): ToolSubschema {
  if (!isSchemaObject(spec)) {
    return spec;
  }
  const next = { ...spec };
  if (!required) {
    delete next.format;
    if (annotateOptional) {
      clarifyOptionalString(next);
    }
  }
  for (const keyword of LIST_KEYWORDS) {
    const schemas = next[keyword];
    if (schemas !== undefined) {
      next[keyword] = schemas.map((item) => sanitizeProperty(item, required, annotateOptional));
    }
  }
  const { items } = next;
  if (items !== undefined) {
    next.items = Array.isArray(items)
      ? items.map((item) => sanitizeProperty(item, required, annotateOptional))
      : sanitizeProperty(items, required, annotateOptional);
  }
  if (next.properties !== undefined) {
    return llmToolParameters(next, !required);
  }
  return next;
}

/** Drop `""` only when the schema lists the key and does not require it. */
export function omitEmptyOptionalStrings(args: JsonObject, schema: ToolSchema): JsonObject {
  const { properties } = schema;
  if (properties === undefined) {
    return args;
  }
  const required = new Set(schema.required);
  const next: JsonObject = {};
  for (const [name, value] of Object.entries(args)) {
    const spec = Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (spec !== undefined && !required.has(name) && isString(value) && value.trim() === "") {
      continue;
    }
    next[name] = value !== undefined && isObjectNode(value) && isSchemaObject(spec)
      ? omitEmptyOptionalStrings(value, spec)
      : value;
  }
  return next;
}

/** `args` less each optional argument the model sent as null, which is an argument it left out. */
function presentArguments(parameters: TObject, args: JsonObject): JsonObject {
  const required = new Set(parameters.required ?? []);
  const given: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null || required.has(key)) {
      given[key] = value;
    }
  }
  return given;
}

/**
 * `args`, a tool call's arguments as the model wrote them, decoded as `parameters` describe them.
 * An optional argument sent as null is absent. A required argument left out throws the error
 * `fail` makes of "<name> is required"; arguments that do not match throw the one it makes of the
 * first mismatch, named by its JSON pointer.
 */
export function decodeArguments<P extends TObject>(
  parameters: P,
  args: JsonObject,
  fail: (problem: string) => Error,
): JsonObject & Static<P> {
  const given = presentArguments(parameters, args);
  const missing = parameters.required?.find((key) => given[key] === undefined);
  if (missing !== undefined) {
    throw fail(`${missing} is required`);
  }
  assertMatches(parameters, given, fail);
  return given;
}
