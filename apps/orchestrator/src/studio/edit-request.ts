// The request an edit tool returns instead of writing: the reason it gives, the content it may carry,
// its line counts, and the widget the turn pauses on until the operator applies or declines it.

import { WRITE_MAX_BYTES } from "../artifacts/types.js";
import { argString } from "../toolbox/schema.js";
import { StudioUnprocessableError } from "./errors.js";

// An edit tool never writes. It returns this widget; the turn pauses until
// the operator applies or declines the proposal from the Studio log.
export const STUDIO_EDIT_WIDGET = "studio_edit_request";

export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const count = (lines: string[]) => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before ? before.split("\n") : []);
  const b = count(after ? after.split("\n") : []);
  let removed = 0;
  let added = 0;
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  return { added, removed };
}

export function assertContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
    throw new StudioUnprocessableError("content exceeds the 256 KiB artifact write limit");
  }
}

export function requireReason(args: Record<string, unknown>): string {
  const reason = argString(args, "reason").trim();
  if (!reason) {
    throw new StudioUnprocessableError("reason is required");
  }
  return reason;
}

export function awaitOperator(title: string, reason: string, edit: Record<string, unknown>): Record<string, unknown> {
  return {
    widget: STUDIO_EDIT_WIDGET,
    await_operator: true,
    status: "awaiting_operator",
    title,
    reason,
    edit,
    hint: "Nothing is written yet. The operator applies or declines this edit; their reply says which.",
  };
}
