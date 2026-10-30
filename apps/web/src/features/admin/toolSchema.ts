import { isRecord } from "../../api/wire";

/** A tool's input schema as typed in its editor: the JSON object it parses to, or why it is none. */
export function parseInputSchema(
  text: string,
): { schema: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof SyntaxError ? error.message : "Not valid JSON." };
  }
  return isRecord(value) ? { schema: value } : { error: "A JSON object." };
}
