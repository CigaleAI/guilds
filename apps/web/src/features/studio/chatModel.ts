import type { StudioMessage } from "../../api/types/studio";

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
    /** An access edit's changes, one per tool or connection. */
    changes?: AccessChange[];
    /** Whether an access edit turns on anything the agent cannot use today. */
    widens?: boolean;
  };
};

/** One overlay an access edit writes. */
export type AccessChange = {
  kind: "native_tool" | "mcp" | "mcp_tool";
  id: string;
  label: string;
  setting: "on" | "off" | "inherit";
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
  if (!decisions.length || decisions.some((decision) => decision === null)) return null;
  const all = decisions as RequestDecision[];
  const next = all.some((decision) => !decision.accepted)
    ? all.length === 1
      ? "Continue without it."
      : "Continue without what I declined."
    : "Continue.";
  return [...all.map((decision) => decision.line), next].join(" ");
}

/** A draft widget's fields, when the tool result carries them. */
function draftWidget(body: Record<string, unknown>): DraftWidget | null {
  const agent = (body.agent ?? {}) as Partial<DraftWidget["agent"]>;
  if (typeof body.draft_id !== "string" || typeof agent.id !== "string") return null;
  return {
    kind: "draft",
    agent: { id: agent.id, name: typeof agent.name === "string" ? agent.name : agent.id },
    draft_id: body.draft_id,
    ...(typeof body.rationale === "string" ? { rationale: body.rationale } : {}),
  };
}

/** A tool result that asks the operator to decide: an edit to apply, a login to grant, a draft. */
export function widgetOf(
  message: Pick<StudioMessage, "payload"> | null | undefined,
): StudioWidget | null {
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
  const focus = (meta.focus ?? {}) as Record<string, unknown>;
  return {
    ...(focus as Partial<PinnedFocus>),
    kind: typeof focus.kind === "string" ? focus.kind : "focus",
    label: typeof focus.label === "string" ? focus.label : "Pinned evidence",
  };
}
