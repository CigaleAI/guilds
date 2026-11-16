// What a tool offers the model: its function schema, built from the TypeBox schema of its
// parameters, and the argument kinds a tool reads beside TypeBox's own.
import type { TObject } from "typebox";
import { Value } from "typebox/value";
import { JsonValueSchema, type JsonValue } from "../lib/json.js";
import {
  llmToolParameters,
  offeredParameters,
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

/** The function schema of the tool `name`, whose arguments `parameters` describe; the same schema decodes its calls. */
export function toolFunctionSchema(name: string, description: string, parameters: TObject): FunctionTool {
  const offered = offeredParameters(parameters);
  return functionSchema(name, description, offered.properties ?? {}, offered.required ?? []);
}

/**
 * An argument the tool takes as whatever JSON the model sends: it reads the value leniently, or
 * hands it on to the domain that parses it. The decode checks only that the value is JSON; the
 * schema serialises as `offered`, which is what the model is offered.
 */
export function jsonArgument(offered: ToolSchema): typeof JsonValueSchema {
  return Object.defineProperty(Value.Clone(JsonValueSchema), "toJSON", { value: () => offered });
}

/** Whether a JSON value is a number. */
export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

/** Whether a JSON value is a string. */
export function isText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
