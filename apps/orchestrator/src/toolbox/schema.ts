import { isPlainRecord } from "../db/json.js";
import { llmToolParameters } from "../lib/tool-schema.js";

export function functionSchema(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
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

export function argString(args: Record<string, unknown>, name: string, fallback = ""): string {
  const value = args[name];
  return typeof value === "string" ? value : fallback;
}

export function argRecord(args: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  return isPlainRecord(value) ? value : undefined;
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
