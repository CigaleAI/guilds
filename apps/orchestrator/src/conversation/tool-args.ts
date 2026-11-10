import { isJsonObject, type JsonObject } from "../lib/json.js";
import type { CompletionMetadata, ToolCall } from "../db/schema/index.js";

/** Whether a tool call's arguments, as the model wrote them, are a whole JSON object. */
export function toolArgsAreJsonObject(raw: ToolCall["function"]["arguments"]): boolean {
  if (!raw.trim()) {
    return false;
  }
  try {
    return isJsonObject(JSON.parse(raw));
  } catch {
    return false;
  }
}

/** Whether the step's output was cut at max_tokens in the middle of the call's arguments. */
export function truncatedToolArguments(
  finishReason: CompletionMetadata["finish_reason"],
  raw: ToolCall["function"]["arguments"],
): boolean {
  return finishReason === "length" && !toolArgsAreJsonObject(raw);
}

/** A tool call's arguments as a JSON object; what can be recovered of them when they are not one. */
export function parseToolArgs(raw: ToolCall["function"]["arguments"]): JsonObject {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isJsonObject(parsed)) {
      return parsed;
    }
  } catch {
    return recoverPartialToolArgs(raw);
  }
  return recoverPartialToolArgs(raw);
}

export function recoverPartialToolArgs(raw: string): JsonObject {
  const out: JsonObject = {};
  const handle = raw.match(/"(?:agent_id|agent_name)"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (handle?.[1]) {
    out.agent_id = decodeJsonStringBody(handle[1]) ?? handle[1];
  }
  const rationale = raw.match(/"rationale"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (rationale?.[1]) {
    out.rationale = decodeJsonStringBody(rationale[1]) ?? rationale[1];
  }
  return out;
}

/** The text a JSON string's body between its quotes decodes to; null when its escapes are not JSON. */
function decodeJsonStringBody(body: string): string | null {
  try {
    const decoded: unknown = JSON.parse(`"${body}"`);
    return isDecodedText(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Whether what JSON.parse gave back is a string. */
function isDecodedText(value: unknown): value is string {
  return typeof value === "string";
}
