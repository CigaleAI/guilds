// What a tool offers the model: its function schema, built from the TypeBox schema of its
// parameters, and the argument kinds a tool reads beside TypeBox's own.
import { Kind, Type, TypeRegistry, type TObject, type TUnsafe } from "@sinclair/typebox";
import { isJsonValue, type JsonValue } from "../lib/json.js";
import {
  isToolSchema,
  llmToolParameters,
  type FunctionTool,
  type ToolSchema,
  type ToolSchemaProperties,
} from "../lib/tool-schema.js";

export function functionSchema(
  name: string,
  description: string,
  properties: ToolSchemaProperties,
  required: string[],
): FunctionTool {
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

/** `parameters` as the JSON Schema they serialise to, which is what the model is offered: TypeBox's own marks left out. */
function offeredParameters(parameters: TObject): ToolSchema {
  const offered: unknown = JSON.parse(JSON.stringify(parameters));
  if (!isToolSchema(offered)) {
    throw new TypeError("a tool's parameters must serialise to a JSON Schema object");
  }
  return offered;
}

/** The function schema of the tool `name`, whose arguments `parameters` describe; the same schema decodes its calls. */
export function toolFunctionSchema(name: string, description: string, parameters: TObject): FunctionTool {
  const offered = offeredParameters(parameters);
  return functionSchema(name, description, offered.properties ?? {}, offered.required ?? []);
}

// The kind accepts every JSON value, so Value.Check agrees with the JsonValue it is typed as.
TypeRegistry.Set("JsonValue", (_schema, value) => isJsonValue(value));

/**
 * An argument the tool takes as whatever JSON the model sends: it reads the value leniently, or
 * hands it on to the domain that parses it. The model is offered `offered`.
 */
export function jsonArgument(offered: ToolSchema): TUnsafe<JsonValue> {
  return Type.Unsafe<JsonValue>({ ...offered, [Kind]: "JsonValue" });
}

/** Whether a JSON value is a number. */
export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

/** Whether a JSON value is a string. */
export function isText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/** A whole number an argument is read as when it is one: the range it is kept in, and its value otherwise. */
export type WholeRange = { min: number; max: number; fallback: number };

/** `value` truncated to a whole number within `range`; the range's fallback when it is not a finite number. */
export function wholeWithin(value: JsonValue | undefined, range: WholeRange): number {
  const whole = isNumber(value) && Number.isFinite(value) ? Math.trunc(value) : range.fallback;
  return Math.max(range.min, Math.min(range.max, whole));
}

export function argString(args: Record<string, unknown>, name: string, fallback = ""): string {
  const value = args[name];
  return typeof value === "string" ? value : fallback;
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
