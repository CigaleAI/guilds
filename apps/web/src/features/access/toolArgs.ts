export type ArgFieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export type ArgField = {
  name: string;
  kind: ArgFieldKind;
  required: boolean;
  description?: string;
  values?: string[];
};

/** Whether a parsed JSON value is an object: not null, not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeOf(spec: Record<string, unknown>): string {
  const raw = spec.type;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((item) => item !== "null" && typeof item === "string");
    if (typeof first === "string") return first;
  }
  return "";
}

function enumValues(spec: Record<string, unknown>): string[] | null {
  if (!Array.isArray(spec.enum) || spec.enum.length === 0) return null;
  if (!spec.enum.every((item) => typeof item === "string" || typeof item === "number")) return null;
  return spec.enum.map((item) => String(item));
}

function fieldKind(spec: Record<string, unknown>): ArgFieldKind {
  const values = enumValues(spec);
  if (values) return "enum";
  const type = typeOf(spec);
  if (type === "string") return "string";
  if (type === "number") return "number";
  if (type === "integer") return "integer";
  if (type === "boolean") return "boolean";
  return "json";
}

/** One form field per property on an object schema; a single JSON field when there are none. */
export function fieldsFromSchema(schema: Record<string, unknown> | undefined): ArgField[] {
  const properties = isPlainObject(schema?.properties) ? schema.properties : null;
  if (!properties || !Object.keys(properties).length) {
    return [{ name: "arguments", kind: "json", required: false, description: "JSON object." }];
  }
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  return Object.entries(properties).map(([name, raw]) => {
    const spec = isPlainObject(raw) ? raw : {};
    const kind = fieldKind(spec);
    const values = kind === "enum" ? (enumValues(spec) ?? undefined) : undefined;
    const description = typeof spec.description === "string" ? spec.description : undefined;
    return {
      name,
      kind,
      required: required.has(name),
      ...(description ? { description } : {}),
      ...(values ? { values } : {}),
    };
  });
}

export function emptyArgValues(fields: readonly ArgField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    values[field.name] = field.kind === "json" && field.name === "arguments" ? "{}" : "";
  }
  return values;
}

/** The value a JSON text holds; null when the text is not JSON. */
export function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** What one field's text parses to: the value its kind takes, or why it takes none. */
type ArgValue = { value: unknown } | { error: string };

/** How each kind of field reads its text, by the field's name and its non-empty text. */
const argValueByKind: Record<ArgFieldKind, (name: string, raw: string) => ArgValue> = {
  string: (_name, raw) => ({ value: raw }),
  enum: (_name, raw) => ({ value: raw }),
  boolean: (name, raw) =>
    raw === "true" || raw === "false"
      ? { value: raw === "true" }
      : { error: `${name} must be true or false.` },
  number: (name, raw) => {
    const number = Number(raw);
    return Number.isFinite(number) ? { value: number } : { error: `${name} must be a number.` };
  },
  integer: (name, raw) => {
    const number = Number(raw);
    if (!Number.isFinite(number)) return { error: `${name} must be a number.` };
    return Number.isInteger(number)
      ? { value: number }
      : { error: `${name} must be a whole number.` };
  },
  json: (name, raw) => {
    const parsed = parseJson(raw);
    return parsed ? { value: parsed.value } : { error: `${name} must be valid JSON.` };
  },
};

/** Turns form text into tool arguments. Empty optional fields are omitted. */
export function parseArgValues(
  fields: readonly ArgField[],
  values: Record<string, string>,
): { arguments: Record<string, unknown> } | { error: string } {
  const arguments_: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? "").trim();
    if (!raw) {
      if (field.required) return { error: `${field.name} is required.` };
      continue;
    }
    const parsed = argValueByKind[field.kind](field.name, raw);
    if ("error" in parsed) return parsed;
    if (fields.length === 1 && field.kind === "json" && field.name === "arguments") {
      return isPlainObject(parsed.value)
        ? { arguments: parsed.value }
        : { error: "arguments must be a JSON object." };
    }
    arguments_[field.name] = parsed.value;
  }
  return { arguments: arguments_ };
}

export function prettyResult(content: string): { text: string; json: unknown } {
  try {
    return { text: content, json: JSON.parse(content) };
  } catch {
    return { text: content, json: null };
  }
}
