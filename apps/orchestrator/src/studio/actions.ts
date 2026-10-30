// The three changes a note, table, or routine tool proposes, named by its
// `action` argument. The recorded tool call carries it from request to apply.

export const EDIT_ACTIONS = ["create", "edit", "delete"] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];
