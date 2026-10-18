import { StudioUnprocessableError } from "./errors.js";

// The three changes a note, table, or routine tool proposes, named by its
// `action` argument. The recorded tool call carries it from request to apply.

export const EDIT_ACTIONS = ["create", "edit", "delete"] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

export function editActionOf(args: Record<string, unknown>): EditAction {
  const action = args.action;
  if (typeof action === "string" && (EDIT_ACTIONS as readonly string[]).includes(action)) {
    return action as EditAction;
  }
  throw new StudioUnprocessableError("action must be create, edit, or delete");
}
