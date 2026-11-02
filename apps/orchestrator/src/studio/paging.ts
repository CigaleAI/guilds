// How a Studio tool pages and caps what it returns: limits, cursors, byte slices, and the arguments
// of a tool that pages one agent's history.

import { Type, type Static } from "typebox";
import type { JsonObject } from "../lib/json.js";
import { STUDIO_TOOL_RESULT_MAX_BYTES, STUDIO_TOTAL_RETURNED_BYTES } from "./constants.js";

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(value ?? fallback, 1), max);
}

export function cursorOffset(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  const n = Number(cursor);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** What a tool answers in place of a result over the byte cap. */
export type TruncatedResult = { truncated: true; error: string; byte_cap: number };

/** `payload` as the coach is sent it: itself, or a TruncatedResult when it is over the byte cap. */
export function truncatePayload(payload: JsonObject): JsonObject {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8");
  if (encoded.length <= STUDIO_TOTAL_RETURNED_BYTES) {
    return payload;
  }
  const truncated: TruncatedResult = {
    truncated: true,
    error: "result exceeded byte cap; narrow the range or continue from the cursor",
    byte_cap: STUDIO_TOTAL_RETURNED_BYTES,
  };
  return truncated;
}

/** A slice of a text a page at a time: its bytes from the cursor, the cursor of the next slice, and whether text was left out. */
export type ByteSlice = { text: string; next_cursor: string | null; truncated: boolean };

export function sliceStudioBytes(
  text: string,
  cursor: string | null | undefined,
  maxBytes = STUDIO_TOOL_RESULT_MAX_BYTES,
): ByteSlice {
  const offset = cursorOffset(cursor);
  const encoded = Buffer.from(text, "utf8");
  if (offset >= encoded.length) {
    return { text: "", next_cursor: null, truncated: offset > 0 };
  }
  if (encoded.length - offset <= maxBytes) {
    return {
      text: encoded.subarray(offset).toString("utf8"),
      next_cursor: null,
      truncated: offset > 0,
    };
  }
  return {
    text: encoded.subarray(offset, offset + maxBytes).toString("utf8"),
    next_cursor: String(offset + maxBytes),
    truncated: true,
  };
}

// The arguments of a tool that pages one agent's history.
export const AgentHistoryArguments = Type.Object({
  agent_id: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
export type AgentHistoryArguments = Static<typeof AgentHistoryArguments>;
