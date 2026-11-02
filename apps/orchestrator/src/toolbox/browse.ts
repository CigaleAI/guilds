import { Type, type Static } from "typebox";
import type { BrowseOutputSchema, BrowseRequest } from "../browse/runner.js";
import { BROWSE_TOOL } from "./browser.js";
import { ToolArgumentError, ToolUnavailableError } from "./errors.js";
import { nativeTool } from "./types.js";

const DESCRIPTION =
  "Delegate a complete browser task on the live Chromium session. Returns the answer with verbatim page " +
  "citations, extracted fields if requested, and the run status.";

const MAX_FIELDS = 20;
const FIELD_NAME = "^[a-z][a-z0-9_]{0,39}$";
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MAX_SECONDS = 300;

/** One field a call asks the run to extract: its type, and what it is when the call says. */
const BrowseField = Type.Object(
  {
    type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("integer"), Type.Literal("boolean")]),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** A `browse` call's arguments: the task, where it starts, whether it may act irreversibly, the fields it extracts, and its limits. */
export const BrowseParameters = Type.Object({
  task: Type.String({ description: "Self-contained goal, required output, constraints, and any values to fill." }),
  start: Type.Optional(
    Type.String({
      description: "Initial http or https URL. Omit to continue from the current page or infer from the task.",
    }),
  ),
  authorize: Type.Optional(
    Type.Boolean({
      description:
        "Allow irreversible actions (submit, pay, delete, send). Default false: the run stops at needs_confirmation before them.",
    }),
  ),
  fields: Type.Optional(
    Type.Record(Type.String({ pattern: FIELD_NAME }), BrowseField, {
      maxProperties: MAX_FIELDS,
      additionalProperties: false,
      description:
        "Flat map of field name to { type: string|number|integer|boolean, description? } to extract, each backed by a page quote.",
    }),
  ),
  max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  max_seconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 600 })),
});
export type BrowseArguments = Static<typeof BrowseParameters>;

/**
 * The JSON Schema fastbrowse extracts `fields` with: a flat object of the named fields, each
 * required. Null when the call asks for no fields.
 */
export function fieldsToOutputSchema(fields: BrowseArguments["fields"]): BrowseOutputSchema | null {
  const names = Object.keys(fields ?? {});
  if (fields === undefined || !names.length) {
    return null;
  }
  return { type: "object", properties: fields, required: names, additionalProperties: false };
}

/** The address a run starts on: an http or https URL, or null when the call gives none. */
function startUrl(start: string | undefined): string | null {
  const given = start?.trim() ?? "";
  if (!given) {
    return null;
  }
  if (!URL.canParse(given)) {
    throw new ToolArgumentError("start must be an http or https URL");
  }
  const url = new URL(given);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolArgumentError("start must be an http or https URL");
  }
  return url.toString();
}

/** A `browse` call's request, with each argument it leaves out at its default. */
export function browseRequest(args: BrowseArguments): BrowseRequest {
  const task = args.task.trim();
  if (!task) {
    throw new ToolArgumentError("task must be a non-empty string");
  }
  return {
    task,
    start: startUrl(args.start),
    authorize: args.authorize ?? false,
    output: fieldsToOutputSchema(args.fields),
    max_steps: args.max_steps ?? DEFAULT_MAX_STEPS,
    max_seconds: args.max_seconds ?? DEFAULT_MAX_SECONDS,
  };
}

export const browse = nativeTool({
  name: BROWSE_TOOL,
  description: DESCRIPTION,
  parameters: BrowseParameters,
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
});
