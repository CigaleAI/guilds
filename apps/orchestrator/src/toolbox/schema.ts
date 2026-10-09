function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function acceptsNull(spec: unknown): boolean {
  if (!isPlainObject(spec)) {
    return false;
  }
  if (spec.type === "null") {
    return true;
  }
  if (Array.isArray(spec.type) && spec.type.includes("null")) {
    return true;
  }
  if (Array.isArray(spec.anyOf) && spec.anyOf.some(acceptsNull)) {
    return true;
  }
  if (Array.isArray(spec.oneOf) && spec.oneOf.some(acceptsNull)) {
    return true;
  }
  if (Array.isArray(spec.allOf) && spec.allOf.some(acceptsNull)) {
    return true;
  }
  return false;
}

const OPTIONAL_OMIT =
  "Optional. Omit this key when unused; do not pass an empty value.";

function mapSchemaList(
  value: unknown,
  required: boolean,
  annotateOptional: boolean,
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => sanitizeProperty(item, required, annotateOptional));
}

function isStringType(spec: Record<string, unknown>): boolean {
  if (spec.type === "string") {
    return true;
  }
  return Array.isArray(spec.type) && spec.type.includes("string");
}

function alreadyStatesOptional(description: string): boolean {
  return /\b(optional|omit(?:ted|ting)?)\b/i.test(description);
}

function clarifyOptionalString(spec: Record<string, unknown>): void {
  if (!isStringType(spec)) {
    return;
  }
  const description = typeof spec.description === "string" ? spec.description.trim() : "";
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
export function llmToolParameters(
  schema: Record<string, unknown>,
  loose = false,
): Record<string, unknown> {
  if (!isPlainObject(schema.properties)) {
    return schema;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema.properties)) {
    properties[name] = sanitizeProperty(
      spec,
      !loose && required.has(name) && !acceptsNull(spec),
      !loose,
    );
  }
  const next: Record<string, unknown> = { ...schema, properties };
  if (next.additionalProperties === false) {
    delete next.additionalProperties;
  }
  delete next.$schema;
  return next;
}

function sanitizeProperty(spec: unknown, required: boolean, annotateOptional: boolean): unknown {
  if (!isPlainObject(spec)) {
    return spec;
  }
  const next = { ...spec };
  if (!required && typeof next.format === "string") {
    delete next.format;
  }
  if (!required && annotateOptional) {
    clarifyOptionalString(next);
  }
  const anyOf = mapSchemaList(next.anyOf, required, annotateOptional);
  if (anyOf) {
    next.anyOf = anyOf;
  }
  const oneOf = mapSchemaList(next.oneOf, required, annotateOptional);
  if (oneOf) {
    next.oneOf = oneOf;
  }
  const allOf = mapSchemaList(next.allOf, required, annotateOptional);
  if (allOf) {
    next.allOf = allOf;
  }
  if (isPlainObject(next.items)) {
    next.items = sanitizeProperty(next.items, required, annotateOptional);
  } else {
    const items = mapSchemaList(next.items, required, annotateOptional);
    if (items) {
      next.items = items;
    }
  }
  const prefixItems = mapSchemaList(next.prefixItems, required, annotateOptional);
  if (prefixItems) {
    next.prefixItems = prefixItems;
  }
  if (isPlainObject(next.properties)) {
    return llmToolParameters(next, !required);
  }
  return next;
}

export function functionSchema(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: llmToolParameters({
        type: "object",
        properties,
        required,
      }),
    },
  };
}

/** Drop `""` only when the schema lists the key and does not require it. */
export function omitEmptyOptionalStrings(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) {
    return args;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const properties = schema.properties;
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (
      typeof value === "string"
      && value.trim() === ""
      && Object.prototype.hasOwnProperty.call(properties, name)
      && !required.has(name)
    ) {
      continue;
    }
    const spec = properties[name];
    if (isPlainObject(value) && isPlainObject(spec)) {
      next[name] = omitEmptyOptionalStrings(value, spec);
      continue;
    }
    next[name] = value;
  }
  return next;
}

export function argString(args: Record<string, unknown>, name: string, fallback = ""): string {
  const value = args[name];
  return typeof value === "string" ? value : fallback;
}

export function argRecord(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function argInteger(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return fallback;
}
