// The arguments the model sends a Studio tool: the schema it is offered, the decode of what it
// sends against that schema, and the tool built from the two.

import {
  Type,
  type ObjectOptions,
  type Static,
  type StringOptions,
  type TObject,
  type TSchema,
  type TUnsafe,
} from "@sinclair/typebox";
import { decode } from "../lib/decode.js";
import { functionSchema } from "../toolbox/schema.js";
import { StudioUnprocessableError } from "./errors.js";
import type { StudioTool, StudioToolCall, StudioToolDeps } from "./tools.js";

const AGENT_HANDLE_KEYS = ["agent_id", "agent", "agent_name"];

/** The agent a Studio tool call names: the first non-blank of agent_id, agent, and agent_name. */
export function studioAgentHandleFromArgs(args: Record<string, unknown>): string {
  for (const key of AGENT_HANDLE_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A string argument that takes one of `values`. The model is offered them as an enum; the decode
 * refuses any other string.
 */
export function studioChoice<const T extends readonly string[]>(
  values: T,
  options: StringOptions = {},
): TUnsafe<T[number]> {
  const pattern = `^(?:${values.map(escapePattern).join("|")})$`;
  return Type.Unsafe<T[number]>(Type.String({ ...options, enum: [...values], pattern }));
}

/** An object argument from any name to a `value`, such as a tool name to its setting. */
export function studioMap<T extends TSchema>(
  value: T,
  options: ObjectOptions = {},
): TUnsafe<Record<string, Static<T>>> {
  return Type.Unsafe<Record<string, Static<T>>>(Type.Object({}, { ...options, additionalProperties: value }));
}

/** The function schema the model is offered for the Studio tool `name`, which takes `parameters`. */
export function studioFunctionSchema(
  name: string,
  description: string,
  parameters: TObject,
): Record<string, unknown> {
  return functionSchema(name, description, parameters.properties, parameters.required ?? []);
}

/**
 * `args` as the type `parameters` describes. An optional argument sent as null is absent. For a
 * tool that takes agent_id, agent_id is the first non-blank of agent_id, agent, and agent_name
 * whenever the call gives one of them. Arguments that do not match throw a
 * StudioUnprocessableError naming the first mismatch by its JSON pointer.
 */
export function decodeStudioArguments<T extends TObject>(
  parameters: T,
  args: Record<string, unknown>,
): Static<T> {
  const required = new Set(parameters.required ?? []);
  const given: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null || required.has(key)) {
      given[key] = value;
    }
  }
  if ("agent_id" in parameters.properties && AGENT_HANDLE_KEYS.some((key) => key in args)) {
    given.agent_id = studioAgentHandleFromArgs(args);
  }
  return decode(parameters, given, (problem) => new StudioUnprocessableError(problem));
}

/** A Studio tool as it is written: what the model is offered, and the work it does on a decoded call. */
export type StudioToolDefinition<T extends TObject> = {
  name: string;
  description: string;
  parameters: T;
  run: (deps: StudioToolDeps, call: StudioToolCall, input: Static<T>) => Promise<Record<string, unknown>>;
};

/**
 * The tool `definition` describes. Its handler decodes the call's arguments against the
 * parameters before any work, so a call that does not match them is refused with nothing done.
 */
export function studioTool<T extends TObject>(definition: StudioToolDefinition<T>): StudioTool {
  const { name, description, parameters, run } = definition;
  return {
    name,
    schema: studioFunctionSchema(name, description, parameters),
    handler: async (deps, call, args) => run(deps, call, decodeStudioArguments(parameters, args)),
  };
}
