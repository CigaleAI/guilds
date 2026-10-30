// The request an edit tool returns instead of writing: the reason it gives, the content it may carry,
// its line counts, and the widget the turn pauses on until the operator applies or declines it.

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WRITE_MAX_BYTES } from "../artifacts/types.js";
import { StudioUnprocessableError } from "./errors.js";

// An edit tool never writes. It returns this widget; the turn pauses until
// the operator applies or declines the proposal from the Studio log.
export const STUDIO_EDIT_WIDGET = "studio_edit_request";

const Lines = Type.Object({ added: Type.Number(), removed: Type.Number() });

const Action = Type.Union([Type.Literal("create"), Type.Literal("edit"), Type.Literal("delete")]);

const Level = Type.Union([Type.Literal("agent"), Type.Literal("guild"), Type.Literal("org")]);

/** The agent whose Memory or access an edit changes. */
const AgentTarget = Type.Object({ agent_id: Type.String(), agent_name: Type.String() });

/** The note whose body an edit replaces. */
const NoteTarget = Type.Object({ display_path: Type.String(), title: Type.Union([Type.String(), Type.Null()]) });

/** The note a create or delete names; an agent note names its agent. */
const NoteLifecycleTarget = Type.Object({
  display_path: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  level: Level,
  agent_id: Type.Optional(Type.String()),
});

/** The guild whose text an edit replaces. */
const GuildTarget = Type.Object({ guild_id: Type.String(), guild_name: Type.String() });

/** The table an edit creates, changes, or deletes; a create has no id yet. */
const CollectionTarget = Type.Object({
  collection_id: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
  scope: Type.Union([Type.Literal("guild"), Type.Literal("org")]),
  display_path: Type.String(),
});

/** The routine an edit creates, changes, or deletes; a create has no id yet. */
const RoutineTarget = Type.Object({
  agent_id: Type.String(),
  agent_name: Type.String(),
  schedule_id: Type.Union([Type.String(), Type.Null()]),
  description: Type.String(),
});

/** One setting an access edit changes. */
const AccessChange = Type.Object({
  kind: Type.String(),
  id: Type.String(),
  label: Type.String(),
  setting: Type.String(),
});

// Every edit binds the live content by its hash and the proposal by its own,
// and counts the lines it adds and removes.
const Bound = {
  base_hash: Type.String(),
  proposed_hash: Type.String(),
  lines: Lines,
};

const MemoryEdit = Type.Object({ kind: Type.Literal("memory"), target: AgentTarget, base_version: Type.Number(), ...Bound });

const NoteBodyEdit = Type.Object({ kind: Type.Literal("note"), target: NoteTarget, base_version: Type.Number(), ...Bound });

const NoteLifecycleEdit = Type.Object({
  kind: Type.Literal("note"),
  action: Type.Union([Type.Literal("create"), Type.Literal("delete")]),
  target: NoteLifecycleTarget,
  base_version: Type.Optional(Type.Number()),
  ...Bound,
  effects: Type.Array(Type.String()),
});

const GuildEdit = Type.Object({
  kind: Type.Literal("guild"),
  target: GuildTarget,
  fields: Type.Array(Type.Union([Type.Literal("about"), Type.Literal("description")])),
  ...Bound,
});

const CollectionEdit = Type.Object({
  kind: Type.Literal("collection"),
  action: Action,
  target: CollectionTarget,
  ...Bound,
  effects: Type.Array(Type.String()),
});

const RoutineEdit = Type.Object({
  kind: Type.Literal("routine"),
  action: Action,
  target: RoutineTarget,
  ...Bound,
  effects: Type.Array(Type.String()),
});

const AccessEdit = Type.Object({
  kind: Type.Literal("access"),
  target: AgentTarget,
  ...Bound,
  effects: Type.Array(Type.String()),
  changes: Type.Array(AccessChange),
  widens: Type.Boolean(),
});

const StudioEditSchema = Type.Union([
  MemoryEdit,
  NoteBodyEdit,
  NoteLifecycleEdit,
  GuildEdit,
  CollectionEdit,
  RoutineEdit,
  AccessEdit,
]);

/** The widget an edit tool returns: what the edit changes, keyed on its `kind`, and why. */
const StudioEditWidgetSchema = Type.Object({
  widget: Type.Literal(STUDIO_EDIT_WIDGET),
  await_operator: Type.Literal(true),
  status: Type.Literal("awaiting_operator"),
  title: Type.String(),
  reason: Type.String(),
  edit: StudioEditSchema,
  hint: Type.String(),
});

export type AgentTarget = Static<typeof AgentTarget>;
export type NoteLifecycleTarget = Static<typeof NoteLifecycleTarget>;
export type CollectionTarget = Static<typeof CollectionTarget>;
export type RoutineTarget = Static<typeof RoutineTarget>;

/** What one edit request changes: a Memory, a note, the guild's text, a table, a routine, or an agent's access. */
export type StudioEdit = Static<typeof StudioEditSchema>;

/** A note create or delete; a note edit replaces the body and carries no action. */
export type NoteLifecycleEdit = Static<typeof NoteLifecycleEdit>;

export type StudioEditWidget = Static<typeof StudioEditWidgetSchema>;

/** The edit request a tool message's content holds, or null when it holds none. */
export function parseEditWidget(content: string): StudioEditWidget | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return Value.Check(StudioEditWidgetSchema, parsed) ? parsed : null;
}

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

/** The reason an edit gives, trimmed; a blank one is refused. */
export function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new StudioUnprocessableError("reason is required");
  }
  return trimmed;
}

export function awaitOperator(title: string, reason: string, edit: StudioEdit): StudioEditWidget {
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
