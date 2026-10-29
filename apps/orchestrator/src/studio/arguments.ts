// The arguments the model sends a Studio tool: the schema it is offered, and the decode of what it
// sends against that schema.

import type { Static, TObject } from "@sinclair/typebox";
import { decode } from "../lib/decode.js";
import { functionSchema } from "../toolbox/schema.js";
import { StudioUnprocessableError } from "./errors.js";

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
 * tool that takes agent_id, agent_id is the handle studioAgentHandleFromArgs names whenever the
 * call gives agent_id, agent, or agent_name. Arguments that do not match throw a
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
