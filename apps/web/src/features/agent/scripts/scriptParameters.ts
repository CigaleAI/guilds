import type { Script } from "../../../api/types/scripts";

/**
 * A script form's parameters text as the form reads it: the JSON Schema object it holds (`null`
 * when the text is empty, for a plain script), or the error the field shows.
 */
export type ParametersInput =
  { schema: Script["parameters"]; error: undefined } | { schema: null; error: string };

/** Whether a parsed value is a JSON Schema object for a tool's arguments: `"type": "object"`. */
function isObjectSchema(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "object"
  );
}

/** Reads the parameters a script form holds: empty, a JSON Schema object, or why it is neither. */
export function readParameters(text: string): ParametersInput {
  if (!text.trim()) return { schema: null, error: undefined };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { schema: null, error: "Not valid JSON." };
  }
  if (isObjectSchema(value)) return { schema: value, error: undefined };
  return { schema: null, error: 'A JSON Schema object, with "type": "object".' };
}
