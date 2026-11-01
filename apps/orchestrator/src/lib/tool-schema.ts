// Shapes a JSON Schema for a model's tool call, and the arguments a model sends against it.
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
