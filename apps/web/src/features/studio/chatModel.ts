import type {
  AccessWidget,
  DraftWidget,
  EditKind,
  EditTarget,
  EditWidget,
  StudioFocus,
  StudioMessage,
  StudioWidget,
} from "../../api/types/studio";
import { parseStudioWidget } from "../../api/wire";

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
const editTargetLabels: Record<EditKind, (target: EditTarget, edit: EditWidget["edit"]) => string> =
  {
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

/** The apply button's words: what applying a create or delete makes, else "Apply edit". */
export function applyLabel(edit: EditWidget["edit"]): string {
  const noun = edit.kind === "note" || edit.kind === "routine" ? edit.kind : "table";
  if (edit.action === "create") return `Create ${noun}`;
  if (edit.action === "delete") return `Delete ${noun}`;
  return "Apply edit";
}

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

/** A tool result that asks the operator to decide: an edit to apply, a login to grant, a draft. */
export function widgetOf(
  message: Pick<StudioMessage, "payload"> | null | undefined,
): StudioWidget | null {
  if (!message || message.payload.role !== "tool") return null;
  return parseStudioWidget(message.payload.content);
}

/** What an operator's message was pinned to, when it carried a focus. */
export function focusOf(message: Pick<StudioMessage, "metadata">): StudioFocus | null {
  const metadata = message.metadata;
  return metadata?.source === "studio_focus" ? (metadata.focus ?? null) : null;
}
