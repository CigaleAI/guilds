import type { StudioMessage } from "../../api/types/studio";
import { isRecord } from "../../api/wire";

/**
 * What a coach edit changes: an agent's memory, access, or routine, a note, the guild's
 * descriptions, or a table.
 */
export type EditTarget = {
  agent_id?: string;
  agent_name?: string;
  display_path?: string;
  title?: string;
  guild_id?: string;
  guild_name?: string;
  /** A table's id, null until the table a create request names exists. */
  collection_id?: string | null;
  /** A table's name. */
  name?: string;
  /** A routine's id, null until the routine a create request names exists. */
  schedule_id?: string | null;
  /** A routine's one-line label. */
  description?: string;
};

/** What a coach edit can change. */
const editKinds = ["memory", "note", "guild", "collection", "access", "routine"] as const;

/** What a table, routine, or note edit does to its target. */
const editActions = ["create", "edit", "delete"] as const;

/** The lines an edit adds and removes. */
export type LineCounts = { added?: number; removed?: number };

export type EditWidget = {
  kind: "edit";
  title?: string;
  reason?: string;
  edit: {
    kind?: (typeof editKinds)[number];
    /** What a table, routine, or note edit does to its target; a note edit without one changes its text. */
    action?: (typeof editActions)[number];
    target?: EditTarget;
    base_version?: number;
    /** The guild fields a guild edit changes. */
    fields?: string[];
    lines?: LineCounts;
    /** An access edit's changes, one per tool or connection. */
    changes?: AccessChange[];
    /** Whether an access edit turns on anything the agent cannot use today. */
    widens?: boolean;
  };
};

/** What an access overlay sets: a native tool, a connection, or one tool of a connection. */
const accessChangeKinds = ["native_tool", "mcp", "mcp_tool"] as const;

/** How an access overlay sets its tool or connection. */
const accessSettings = ["on", "off", "inherit"] as const;

/** One overlay an access edit writes. */
export type AccessChange = {
  kind: (typeof accessChangeKinds)[number];
  id: string;
  label: string;
  setting: (typeof accessSettings)[number];
};

/** A Task draft the coach wrote, decided like an edit: published, edited and published, or discarded. */
export type DraftWidget = {
  kind: "draft";
  agent: { id: string; name: string };
  draft_id: string;
  rationale?: string;
};

export type AccessWidget = {
  kind: "access";
  title?: string;
  reason?: string;
  connection: {
    id?: string;
    server?: { id?: string; slug?: string; display_name?: string };
    owner_scope?: string;
    account_hint?: string;
  };
};

/**
 * What an edit changes, in words: "wallet · Memory", "wallet · access", "wallet · Daily sweep", a
 * note's title, "degen · about", "leads · table".
 */
export function editTargetLabel(edit: EditWidget["edit"]): string {
  return editTargetLabels[edit.kind ?? "guild"](edit.target ?? {}, edit);
}

/** The agent an edit names, by name, else by id. */
function editAgentName(target: EditTarget): string {
  return target.agent_name || target.agent_id || "agent";
}

/** What each kind of edit changes, in words; an edit without a kind changes the guild. */
const editTargetLabels: Record<
  (typeof editKinds)[number],
  (target: EditTarget, edit: EditWidget["edit"]) => string
> = {
  memory: (target) => `${editAgentName(target)} · Memory`,
  access: (target) => `${editAgentName(target)} · access`,
  collection: (target) => `${target.name || "table"} · table`,
  routine: (target) => `${editAgentName(target)} · ${target.description || "routine"}`,
  note: (target) => target.title || target.display_path?.split("/").pop() || "note",
  guild: (target, edit) =>
    `${target.guild_name || "guild"} · ${edit.fields?.join(" + ") || "description"}`,
};

/** The login an access request names, with its account when it has one. */
export function connectionLabel(connection: AccessWidget["connection"]): string {
  const name = connection.server?.display_name || connection.server?.slug || "this login";
  return connection.account_hint ? `${name} · ${connection.account_hint}` : name;
}

/** The operator's answer to one request, in the words the coach reads. */
export type RequestDecision = { accepted: boolean; line: string };

const APPLY_NOUNS: Record<string, string> = { note: "note", routine: "routine" };

/** The apply button's words: what applying a create or delete makes, else "Apply edit". */
export function applyLabel(edit: EditWidget["edit"]): string {
  const noun = APPLY_NOUNS[edit.kind ?? ""] ?? "table";
  if (edit.action === "create") return `Create ${noun}`;
  if (edit.action === "delete") return `Delete ${noun}`;
  return "Apply edit";
}

/** A request the coach made in its turn: an edit, a login, or a Task draft. */
export type StudioWidget = EditWidget | AccessWidget | DraftWidget;

/** What became of a draft: the outcome of the last version the operator saw. */
export type DraftOutcome = "published" | "edited" | "discarded";

const DRAFT_LINES: Record<DraftOutcome, (agent: string) => string> = {
  published: (agent) => `Published the draft for ${agent}.`,
  edited: (agent) => `Edited and published the draft for ${agent}.`,
  discarded: (agent) => `Discarded the draft for ${agent}.`,
};

/** A draft's answer in the words the coach reads. */
export function draftDecision(widget: DraftWidget, outcome: DraftOutcome): RequestDecision {
  return { accepted: outcome !== "discarded", line: DRAFT_LINES[outcome](widget.agent.name) };
}

/** One request's answer when it went through: an edit applied, or a login granted. */
export function acceptedDecision(widget: EditWidget | AccessWidget): RequestDecision {
  if (widget.kind === "edit") {
    return { accepted: true, line: `Applied the edit to ${editTargetLabel(widget.edit)}.` };
  }
  return { accepted: true, line: `Granted read access to ${connectionLabel(widget.connection)}.` };
}

/** One request's answer when it was turned down: an edit or a login declined. */
export function declinedDecision(widget: EditWidget | AccessWidget): RequestDecision {
  if (widget.kind === "edit") {
    return { accepted: false, line: `Declined the edit to ${editTargetLabel(widget.edit)}.` };
  }
  return {
    accepted: false,
    line: `Declined read access to ${connectionLabel(widget.connection)}.`,
  };
}

/**
 * The one reply that answers every request a turn made, so the coach continues once with all of
 * them decided; null while any request is still open.
 */
export function batchReply(decisions: readonly (RequestDecision | null)[]): string | null {
  const all = decisions.filter((decision) => decision !== null);
  if (!all.length || all.length < decisions.length) return null;
  const next = all.some((decision) => !decision.accepted)
    ? all.length === 1
      ? "Continue without it."
      : "Continue without what I declined."
    : "Continue.";
  return [...all.map((decision) => decision.line), next].join(" ");
}

/** The fields of a JSON object that hold text, by name; a field of another type is left out. */
function textFields<Key extends string>(
  record: Record<string, unknown>,
  keys: readonly Key[],
): Partial<Record<Key, string>> {
  const fields: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

/** The fields of a JSON object that hold text or null, by name; one of another type is left out. */
function nullableTextFields<Key extends string>(
  record: Record<string, unknown>,
  keys: readonly Key[],
): Partial<Record<Key, string | null>> {
  const fields: Partial<Record<Key, string | null>> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || value === null) fields[key] = value;
  }
  return fields;
}

/** One overlay of an access edit; null when it lacks a field or names no known kind or setting. */
function parseAccessChange(value: unknown): AccessChange | null {
  if (!isRecord(value)) return null;
  const kind = accessChangeKinds.find((entry) => entry === value.kind);
  const setting = accessSettings.find((entry) => entry === value.setting);
  if (!kind || !setting || typeof value.id !== "string" || typeof value.label !== "string") {
    return null;
  }
  return { kind, id: value.id, label: value.label, setting };
}

/** The line counts of an edit, keeping the counts that are numbers. */
function parseLineCounts(lines: Record<string, unknown>): LineCounts {
  return {
    ...(typeof lines.added === "number" ? { added: lines.added } : {}),
    ...(typeof lines.removed === "number" ? { removed: lines.removed } : {}),
  };
}

/** What an edit names as its target, keeping the fields of the type each holds. */
function parseEditTarget(target: Record<string, unknown>): EditTarget {
  return {
    ...textFields(target, [
      "agent_id",
      "agent_name",
      "display_path",
      "title",
      "guild_id",
      "guild_name",
      "name",
      "description",
    ]),
    ...nullableTextFields(target, ["collection_id", "schedule_id"]),
  };
}

/** An edit request's edit, keeping each field that holds what the field says. */
export function parseEdit(value: unknown): EditWidget["edit"] {
  if (!isRecord(value)) return {};
  const kind = editKinds.find((entry) => entry === value.kind);
  const action = editActions.find((entry) => entry === value.action);
  const { fields, changes } = value;
  return {
    ...(kind ? { kind } : {}),
    ...(action ? { action } : {}),
    ...(isRecord(value.target) ? { target: parseEditTarget(value.target) } : {}),
    ...(typeof value.base_version === "number" ? { base_version: value.base_version } : {}),
    ...(Array.isArray(fields)
      ? { fields: fields.filter((field) => typeof field === "string") }
      : {}),
    ...(isRecord(value.lines) ? { lines: parseLineCounts(value.lines) } : {}),
    ...(Array.isArray(changes)
      ? { changes: changes.map(parseAccessChange).filter((change) => change !== null) }
      : {}),
    ...(typeof value.widens === "boolean" ? { widens: value.widens } : {}),
  };
}

/** The login an access request names, keeping the fields that hold text. */
export function parseConnection(value: unknown): AccessWidget["connection"] {
  if (!isRecord(value)) return {};
  return {
    ...textFields(value, ["id", "owner_scope", "account_hint"]),
    ...(isRecord(value.server)
      ? { server: textFields(value.server, ["id", "slug", "display_name"]) }
      : {}),
  };
}

/** A draft widget's fields, when the tool result carries them. */
function draftWidget(body: Record<string, unknown>): DraftWidget | null {
  const agent = textFields(isRecord(body.agent) ? body.agent : {}, ["id", "name"]);
  if (typeof body.draft_id !== "string" || agent.id === undefined) return null;
  return {
    kind: "draft",
    agent: { id: agent.id, name: agent.name ?? agent.id },
    draft_id: body.draft_id,
    ...textFields(body, ["rationale"]),
  };
}

/** A tool result that asks the operator to decide: an edit to apply, a login to grant, a draft. */
export function widgetOf(
  message: Pick<StudioMessage, "payload"> | null | undefined,
): StudioWidget | null {
  if (!message || message.payload.role !== "tool" || typeof message.payload.content !== "string")
    return null;
  let body: unknown;
  try {
    body = JSON.parse(message.payload.content);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  if (body.widget === "studio_edit_request") {
    return { kind: "edit", ...textFields(body, ["title", "reason"]), edit: parseEdit(body.edit) };
  }
  if (body.widget === "studio_connection_access") {
    return {
      kind: "access",
      ...textFields(body, ["title", "reason"]),
      connection: parseConnection(body.connection),
    };
  }
  if (body.widget === "studio_task_draft") return draftWidget(body);
  return null;
}

/** What a message was pinned to: its kind and label, and the ids that locate it. */
export type PinnedFocus = {
  kind: string;
  label: string;
  agent_id?: string;
  run_id?: string;
  seq?: number | null;
  call_id?: string | null;
  revision_id?: string | null;
  schedule_id?: string;
  display_path?: string;
};

/** What an operator's message was pinned to, when it carried a focus. */
export function focusOf(message: Pick<StudioMessage, "metadata">): PinnedFocus | null {
  const meta = message.metadata ?? {};
  if (meta.source !== "studio_focus") return null;
  const focus: Record<string, unknown> = isRecord(meta.focus) ? meta.focus : {};
  const { seq } = focus;
  return {
    ...textFields(focus, ["agent_id", "run_id", "schedule_id", "display_path"]),
    ...nullableTextFields(focus, ["call_id", "revision_id"]),
    ...(typeof seq === "number" || seq === null ? { seq } : {}),
    kind: typeof focus.kind === "string" ? focus.kind : "focus",
    label: typeof focus.label === "string" ? focus.label : "Pinned evidence",
  };
}
