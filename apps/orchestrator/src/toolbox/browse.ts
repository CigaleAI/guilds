import type { BrowseFieldType, BrowseOutputSchema, BrowseRequest } from "../browse/runner.js";
import { isPlainRecord } from "../db/json.js";
import { BROWSE_TOOL } from "./browser.js";
import { ToolArgumentError, ToolUnavailableError } from "./errors.js";
import { identityOutput } from "./output.js";
import { functionSchema } from "./schema.js";
import type { Tool } from "./types.js";

const DESCRIPTION =
  "Delegate a complete browser task on the live Chromium session. Returns the answer with verbatim page " +
  "citations, extracted fields if requested, and the run status.";

const PROPERTIES = {
  task: { type: "string", description: "Self-contained goal, required output, constraints, and any values to fill." },
  start: {
    type: "string",
    description: "Initial http or https URL. Omit to continue from the current page or infer from the task.",
  },
  authorize: {
    type: "boolean",
    description:
      "Allow irreversible actions (submit, pay, delete, send). Default false: the run stops at needs_confirmation before them.",
  },
  fields: {
    type: "object",
    description:
      "Flat map of field name to { type: string|number|integer|boolean, description? } to extract, each backed by a page quote.",
  },
  max_steps: { type: "integer", minimum: 1, maximum: 100 },
  max_seconds: { type: "integer", minimum: 10, maximum: 600 },
};

/** An integer argument: its name, the range it takes, and its value when the call leaves it out. */
type IntegerArgument = { name: string; min: number; max: number; fallback: number };

const MAX_STEPS: IntegerArgument = { name: "max_steps", min: 1, max: 100, fallback: 40 };
const MAX_SECONDS: IntegerArgument = { name: "max_seconds", min: 10, max: 600, fallback: 300 };

const MAX_FIELDS = 20;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_TYPES: readonly BrowseFieldType[] = ["string", "number", "integer", "boolean"];

function isFieldType(value: unknown): value is BrowseFieldType {
  return FIELD_TYPES.some((type) => type === value);
}

/** One requested field's schema: its type and, when given, its description. */
function fieldSchema(name: string, value: unknown): { type: BrowseFieldType; description?: string } {
  if (!isPlainRecord(value) || !isFieldType(value.type)) {
    throw new ToolArgumentError(`fields.${name} must be { type: ${FIELD_TYPES.join("|")}, description? }`);
  }
  const extra = Object.keys(value).find((key) => key !== "type" && key !== "description");
  if (extra !== undefined) {
    throw new ToolArgumentError(`fields.${name} takes only type and description, not ${extra}`);
  }
  if (value.description === undefined) {
    return { type: value.type };
  }
  if (typeof value.description !== "string") {
    throw new ToolArgumentError(`fields.${name}.description must be a string`);
  }
  return { type: value.type, description: value.description };
}

/**
 * The JSON Schema fastbrowse extracts `fields` with: a flat object of at most 20 named fields,
 * each required. Null when the call asks for no fields.
 */
export function fieldsToOutputSchema(fields: unknown): BrowseOutputSchema | null {
  if (fields === undefined || fields === null) {
    return null;
  }
  if (!isPlainRecord(fields)) {
    throw new ToolArgumentError("fields must be an object of field name to { type, description? }");
  }
  const names = Object.keys(fields);
  if (!names.length) {
    return null;
  }
  if (names.length > MAX_FIELDS) {
    throw new ToolArgumentError(`fields names at most ${MAX_FIELDS} fields`);
  }
  const properties: BrowseOutputSchema["properties"] = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name)) {
      throw new ToolArgumentError(`field name ${name} must be lowercase letters, digits, and underscores, starting with a letter`);
    }
    properties[name] = fieldSchema(name, fields[name]);
  }
  return { type: "object", properties, required: names, additionalProperties: false };
}

/** The address a run starts on: an http or https URL, or null when the call gives none. */
function startUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !URL.canParse(value.trim())) {
    throw new ToolArgumentError("start must be an http or https URL");
  }
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolArgumentError("start must be an http or https URL");
  }
  return url.toString();
}

function integerArgument(args: Record<string, unknown>, argument: IntegerArgument): number {
  const value = args[argument.name];
  if (value === undefined || value === null) {
    return argument.fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < argument.min || value > argument.max) {
    throw new ToolArgumentError(`${argument.name} must be an integer from ${argument.min} to ${argument.max}`);
  }
  return value;
}

/** A `browse` call's arguments, validated, with each one it leaves out at its default. */
export function browseRequest(args: Record<string, unknown>): BrowseRequest {
  const { task, authorize = false } = args;
  if (typeof task !== "string" || !task.trim()) {
    throw new ToolArgumentError("task must be a non-empty string");
  }
  if (typeof authorize !== "boolean") {
    throw new ToolArgumentError("authorize must be true or false");
  }
  return {
    task: task.trim(),
    start: startUrl(args.start),
    authorize,
    output: fieldsToOutputSchema(args.fields),
    max_steps: integerArgument(args, MAX_STEPS),
    max_seconds: integerArgument(args, MAX_SECONDS),
  };
}

export const browse: Tool = {
  name: BROWSE_TOOL,
  description: DESCRIPTION,
  output_filter: identityOutput,
  filter_name: "identity",
  schema: functionSchema(BROWSE_TOOL, DESCRIPTION, PROPERTIES, ["task"]),
  handler: async (services, run, hooks, call) => {
    if (services.browse === null) {
      throw new ToolUnavailableError("the agent-optimized browser is not available on this server");
    }
    const request = browseRequest(call.arguments);
    await hooks.ensure_browser?.();
    const outcome = await services.browse.run(run, hooks, call, request);
    call.metadata = outcome.metadata;
    return outcome.text;
  },
};
