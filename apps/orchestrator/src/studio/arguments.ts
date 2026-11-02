// The arguments the model sends a Studio tool: the schema it is offered, the decode of what it
// sends against that schema, and the tool built from the two.

import {
  Type,
  type Static,
  type TObject,
  type TObjectOptions,
  type TSchema,
  type TStringOptions,
  type TUnsafe,
} from "typebox";
import { keepMatching } from "../lib/decode.js";
import type { JsonObject } from "../lib/json.js";
import { ToolArgumentError } from "../toolbox/errors.js";
import { toolFunctionSchema } from "../toolbox/schema.js";
import { decodeToolArguments } from "../toolbox/types.js";
import { StudioUnprocessableError } from "./errors.js";
import type { StudioTool, StudioToolCall, StudioToolDeps } from "./tools.js";

/** The names a call may give its agent by, in the order the first non-blank one is taken. */
const AgentHandles = Type.Object({
  agent_id: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  agent_name: Type.Optional(Type.String()),
});

const AGENT_HANDLE_KEYS = ["agent_id", "agent", "agent_name"] as const;

/** The agent a Studio tool call names: the first non-blank of agent_id, agent, and agent_name given as text. */
function agentHandleOf(args: JsonObject): string {
  const handles = keepMatching(AgentHandles, args) ?? {};
  for (const key of AGENT_HANDLE_KEYS) {
    const handle = handles[key]?.trim();
    if (handle) {
      return handle;
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
  options: TStringOptions = {},
): TUnsafe<T[number]> {
  const pattern = `^(?:${values.map(escapePattern).join("|")})$`;
  return Type.Unsafe<T[number]>(Type.String({ ...options, enum: [...values], pattern }));
}

/** An object argument from any name to a `value`, such as a tool name to its setting. */
export function studioMap<T extends TSchema>(
  value: T,
  options: TObjectOptions = {},
): TUnsafe<Record<string, Static<T>>> {
  return Type.Unsafe<Record<string, Static<T>>>(Type.Object({}, { ...options, additionalProperties: value }));
}

/**
 * `args` as the type `parameters` describes, decoded as every tool's arguments are. For a tool
 * that takes agent_id, agent_id is the first non-blank of agent_id, agent, and agent_name
 * whenever the call gives one of them. Arguments that do not match throw a
 * StudioUnprocessableError with the decode's message.
 */
export function decodeStudioArguments<T extends TObject>(parameters: T, args: JsonObject): JsonObject & Static<T> {
  const given =
    "agent_id" in parameters.properties && AGENT_HANDLE_KEYS.some((key) => key in args)
      ? { ...args, agent_id: agentHandleOf(args) }
      : args;
  try {
    return decodeToolArguments(parameters, given);
  } catch (error) {
    if (error instanceof ToolArgumentError) {
      throw new StudioUnprocessableError(error.message);
    }
    throw error;
  }
}

/** A Studio tool as it is written: what the model is offered, and the work it does on a decoded call. */
export type StudioToolDefinition<T extends TObject> = {
  name: string;
  description: string;
  parameters: T;
  run: (deps: StudioToolDeps, call: StudioToolCall, input: Static<T>) => Promise<JsonObject>;
};

/**
 * The tool `definition` describes. Its handler decodes the call's arguments against the
 * parameters before any work, so a call that does not match them is refused with nothing done.
 */
export function studioTool<T extends TObject>(definition: StudioToolDefinition<T>): StudioTool {
  const { name, description, parameters, run } = definition;
  return {
    name,
    schema: toolFunctionSchema(name, description, parameters),
    handler: async (deps, call, args) => run(deps, call, decodeStudioArguments(parameters, args)),
  };
}
