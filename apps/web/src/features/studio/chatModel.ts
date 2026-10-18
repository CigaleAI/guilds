import type { StudioMessage } from "../../api/types";

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

export type EditWidget = {
  kind: "edit";
  title?: string;
  reason?: string;
  edit: {
    kind?: "memory" | "note" | "guild" | "collection" | "access" | "routine";
    /** What a table, routine, or note edit does to its target; a note edit without one changes its text. */
    action?: "create" | "edit" | "delete";
    target?: EditTarget;
    base_version?: number;
    /** The guild fields a guild edit changes. */
    fields?: string[];
    lines?: { added?: number; removed?: number };
  };
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
  const target = edit.target ?? {};
  if (edit.kind === "memory") return `${target.agent_name || target.agent_id || "agent"} · Memory`;
  if (edit.kind === "access") return `${target.agent_name || target.agent_id || "agent"} · access`;
  if (edit.kind === "collection") return `${target.name || "table"} · table`;
  if (edit.kind === "routine") {
    return `${target.agent_name || target.agent_id || "agent"} · ${target.description || "routine"}`;
  }
  if (edit.kind === "note") {
    return target.title || target.display_path?.split("/").pop() || "note";
  }
  return `${target.guild_name || "guild"} · ${edit.fields?.join(" + ") || "description"}`;
}

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

/** One request's answer: an edit applied or declined, a login granted or declined. */
export function decisionOf(widget: EditWidget | AccessWidget, accepted: boolean): RequestDecision {
  if (widget.kind === "edit") {
    const target = editTargetLabel(widget.edit);
    return {
      accepted,
      line: accepted ? `Applied the edit to ${target}.` : `Declined the edit to ${target}.`,
    };
  }
  const label = connectionLabel(widget.connection);
  return {
    accepted,
    line: accepted ? `Granted read access to ${label}.` : `Declined read access to ${label}.`,
  };
}

/**
 * The one reply that answers every request a turn made, so the coach continues once with all of
 * them decided; null while any request is still open.
 */
export function batchReply(decisions: readonly (RequestDecision | null)[]): string | null {
  if (!decisions.length || decisions.some((decision) => decision === null)) return null;
  const all = decisions as RequestDecision[];
  const next = all.some((decision) => !decision.accepted)
    ? all.length === 1
      ? "Continue without it."
      : "Continue without what I declined."
    : "Continue.";
  return [...all.map((decision) => decision.line), next].join(" ");
}

/** A tool result that asks the operator to decide: an edit to apply, or a login to grant. */
export function widgetOf(
  message: Pick<StudioMessage, "payload"> | null | undefined,
): EditWidget | AccessWidget | null {
  if (!message || message.payload.role !== "tool" || typeof message.payload.content !== "string")
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.payload.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  const text = (key: string) =>
    typeof body[key] === "string" ? { [key]: body[key] as string } : {};
  if (body.widget === "studio_edit_request") {
    return {
      kind: "edit",
      ...text("title"),
      ...text("reason"),
      edit: (body.edit as EditWidget["edit"]) ?? {},
    };
  }
  if (body.widget === "studio_connection_access") {
    return {
      kind: "access",
      ...text("title"),
      ...text("reason"),
      connection: (body.connection as AccessWidget["connection"]) ?? {},
    };
  }
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
  const focus = (meta.focus ?? {}) as Record<string, unknown>;
  return {
    ...(focus as Partial<PinnedFocus>),
    kind: typeof focus.kind === "string" ? focus.kind : "focus",
    label: typeof focus.label === "string" ? focus.label : "Pinned evidence",
  };
}
