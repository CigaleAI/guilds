import {
  isJsonObject,
  isNumber,
  isString,
  parseJson,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from "../../api/wire";

export type ArgFieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export type ArgField = {
  name: string;
  kind: ArgFieldKind;
  required: boolean;
  description?: string;
  values?: string[];
};

/** The type a property's schema names: its one type, or the first besides `null` it lists. */
function typeOf(spec: JsonSchema): string {
  const type = spec.type;
  if (!Array.isArray(type)) return type ?? "";
  return type.find((item) => item !== "null") ?? "";
}

/** The values a property's schema lists, as the field's choices; null unless each is text or a number. */
function enumValues(spec: JsonSchema): string[] | null {
  if (!spec.enum?.length) return null;
  if (!spec.enum.every((item) => isString(item) || isNumber(item))) return null;
  return spec.enum.map((item) => String(item));
}

function fieldKind(spec: JsonSchema): ArgFieldKind {
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
export function fieldsFromSchema(schema: JsonSchema | undefined): ArgField[] {
  const properties = schema?.properties;
  if (!properties || !Object.keys(properties).length) {
    return [{ name: "arguments", kind: "json", required: false, description: "JSON object." }];
  }
  const required = new Set(schema.required);
  return Object.entries(properties).map(([name, spec]) => {
    const kind = fieldKind(spec);
    const values = kind === "enum" ? (enumValues(spec) ?? undefined) : undefined;
    const description = spec.description;
    return {
      name,
      kind,
      required: required.has(name),
      ...(description ? { description } : {}),
      ...(values ? { values } : {}),
    };
  });
}

/** What the operator typed in each field of a tool's form, by the field's name. */
export type ArgTexts = Record<ArgField["name"], string>;

/** Each field's starting text: an empty object for the one JSON field of a schema without properties. */
export function emptyArgValues(fields: readonly ArgField[]): ArgTexts {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.kind === "json" && field.name === "arguments" ? "{}" : "",
    ]),
  );
}

/** What one field's text parses to: the value its kind takes, or why it takes none. */
type ArgValue = { value: JsonValue } | { error: string };

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
    const value = parseJson(raw);
    return value === undefined ? { error: `${name} must be valid JSON.` } : { value };
  },
};

/** Turns form text into tool arguments. Empty optional fields are omitted. */
export function parseArgValues(
  fields: readonly ArgField[],
  values: ArgTexts,
): { arguments: JsonObject } | { error: string } {
  const arguments_: JsonObject = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? "").trim();
    if (!raw) {
      if (field.required) return { error: `${field.name} is required.` };
      continue;
    }
    const parsed = argValueByKind[field.kind](field.name, raw);
    if ("error" in parsed) return parsed;
    if (fields.length === 1 && field.kind === "json" && field.name === "arguments") {
      return isJsonObject(parsed.value)
        ? { arguments: parsed.value }
        : { error: "arguments must be a JSON object." };
    }
    arguments_[field.name] = parsed.value;
  }
  return { arguments: arguments_ };
}

/**
 * A tool's result as the test dialog shows it: its text, and the JSON array or object the text
 * holds, which shows as a tree; null when the text holds neither.
 */
export type ToolResultView = { text: string; json: JsonValue[] | JsonObject | null };

export function prettyResult(content: string): ToolResultView {
  const json = parseJson(content);
  return { text: content, json: Array.isArray(json) || isJsonObject(json) ? json : null };
}
