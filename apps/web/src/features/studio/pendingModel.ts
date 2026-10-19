import type { StudioDraft, StudioMessage } from "../../api/types";
import {
  batchReply,
  connectionLabel,
  decisionOf,
  draftDecision,
  editTargetLabel,
  widgetOf,
  type AccessWidget,
  type DraftWidget,
  type EditWidget,
  type RequestDecision,
  type StudioWidget,
} from "./chatModel";
import type { StudioSearch, StudioSection } from "./location";

/** Where a proposal is decided in the workspace: a section, or the Logins popover. */
export type ProposalPlace = StudioSection | "logins";

/**
 * One request of the coach's latest turn. `open` waits on the operator; `decided` carries the
 * answer the coach reads; `replaced` is a draft the coach superseded in the same turn, which
 * needs no answer of its own.
 */
export type Proposal = {
  seq: number;
  widget: StudioWidget;
  state: "open" | "decided" | "replaced";
  decision: RequestDecision | null;
  place: ProposalPlace;
  agentId: string | null;
  /** Where Show opens it; null for a login, decided in the Logins popover. */
  location: StudioSearch | null;
  label: string;
  /** A login grant, or an access change that widens: never applied with the others. */
  alone: boolean;
  /** The draft version the operator decides, for a draft. */
  draft: StudioDraft | null;
};

type Settled = Pick<Proposal, "state" | "decision"> & { draft?: StudioDraft | null };

const open: Settled = { state: "open", decision: null };

/** The tool messages after the operator's last message: the requests the turn is waiting on. */
function turnRequests(messages: readonly StudioMessage[]): ProposalRequest[] {
  const lastUser = messages.reduce(
    (seq, message) => (message.payload.role === "user" ? Math.max(seq, message.seq) : seq),
    -1,
  );
  return messages.flatMap((message) => {
    const widget = message.seq > lastUser ? widgetOf(message) : null;
    return widget ? [{ seq: message.seq, widget, metadata: message.metadata ?? {} }] : [];
  });
}

function editState(widget: EditWidget, metadata: Record<string, unknown>): Settled {
  const status = metadata.edit_status;
  if (status !== "applied" && status !== "declined") return open;
  return { state: "decided", decision: decisionOf(widget, status === "applied") };
}

function loginState(
  widget: AccessWidget,
  metadata: Record<string, unknown>,
  granted: readonly string[],
): Settled {
  const id = widget.connection.id;
  if (metadata.access_status === "granted" || (id && granted.includes(id))) {
    return { state: "decided", decision: decisionOf(widget, true) };
  }
  if (metadata.access_status === "declined") {
    return { state: "decided", decision: decisionOf(widget, false) };
  }
  return open;
}

/**
 * The newest version of a draft: the operator's edits keep the message that created it, so they
 * continue its line; a later draft the coach writes starts a new one.
 */
export function draftHead(drafts: readonly StudioDraft[], draftId: string): StudioDraft | null {
  const first = drafts.find((draft) => draft.id === draftId);
  if (!first) return null;
  const line = drafts.filter(
    (draft) =>
      draft.id === draftId ||
      (first.created_message_seq !== null &&
        draft.created_message_seq === first.created_message_seq),
  );
  return line.reduce((head, draft) => (draft.draft_number > head.draft_number ? draft : head));
}

function draftState(widget: DraftWidget, drafts: readonly StudioDraft[]): Settled {
  const head = draftHead(drafts, widget.draft_id);
  if (!head || head.status === "draft" || head.status === "conflicted") {
    return { ...open, draft: head };
  }
  if (head.status === "superseded") return { state: "replaced", decision: null, draft: head };
  if (head.status === "discarded") {
    return { state: "decided", decision: draftDecision(widget, "discarded"), draft: head };
  }
  const outcome = head.id === widget.draft_id ? "published" : "edited";
  return { state: "decided", decision: draftDecision(widget, outcome), draft: head };
}

type Placed = Pick<Proposal, "place" | "agentId" | "location">;

const agentPlace = (agent: string | undefined, search: Omit<StudioSearch, "section" | "agent">) =>
  agent
    ? {
        place: "agents" as const,
        agentId: agent,
        location: { section: "agents" as const, agent, ...search },
      }
    : { place: "agents" as const, agentId: null, location: { section: "agents" as const } };

const editPlaces: Record<string, (edit: EditWidget["edit"]) => Placed> = {
  memory: (edit) => agentPlace(edit.target?.agent_id, { tab: "memory" }),
  routine: (edit) =>
    agentPlace(edit.target?.agent_id, {
      tab: "routines",
      ...(edit.target?.schedule_id ? { item: edit.target.schedule_id } : {}),
    }),
  note: (edit) => ({
    place: "state",
    agentId: null,
    location: {
      section: "state",
      tab: "list",
      kind: "notes",
      ...(edit.target?.display_path ? { item: edit.target.display_path } : {}),
    },
  }),
  collection: (edit) => ({
    place: "state",
    agentId: null,
    location: {
      section: "state",
      tab: "list",
      kind: "tables",
      ...(edit.target?.collection_id ? { item: edit.target.collection_id } : {}),
    },
  }),
  access: (edit) => ({
    place: "tools",
    agentId: edit.target?.agent_id ?? null,
    location: { section: "tools" },
  }),
};

const guildPlace: Placed = { place: "guild", agentId: null, location: { section: "guild" } };

/** Where each kind of proposal is decided, and the words that name it. */
function placeOf(widget: StudioWidget): Placed & Pick<Proposal, "label" | "alone"> {
  if (widget.kind === "draft") {
    return {
      ...agentPlace(widget.agent.id, { tab: "draft" }),
      label: `${widget.agent.name} · Task draft`,
      alone: false,
    };
  }
  if (widget.kind === "access") {
    return {
      place: "logins",
      agentId: null,
      location: null,
      label: connectionLabel(widget.connection),
      alone: true,
    };
  }
  const placed = editPlaces[widget.edit.kind ?? ""]?.(widget.edit) ?? guildPlace;
  return { ...placed, label: editTargetLabel(widget.edit), alone: widget.edit.widens === true };
}

function settle(
  widget: StudioWidget,
  metadata: Record<string, unknown>,
  context: { drafts: readonly StudioDraft[]; granted: readonly string[] },
): Settled {
  if (widget.kind === "draft") return draftState(widget, context.drafts);
  if (widget.kind === "access") return loginState(widget, metadata, context.granted);
  return editState(widget, metadata);
}

/** A request the coach made: its tool message seq, what it asks, and what is stored on it. */
export type ProposalRequest = {
  seq: number;
  widget: StudioWidget;
  metadata: Record<string, unknown>;
};

/**
 * Every request of the coach's latest turn, where it is decided, and what the operator answered.
 * Earlier turns are settled: the operator wrote after them.
 */
export function turnProposals(
  messages: readonly StudioMessage[],
  drafts: readonly StudioDraft[],
  granted: readonly string[],
): Proposal[] {
  return proposalsOf(turnRequests(messages), { drafts, granted });
}

/** Requests with where each is decided and what the operator answered. */
export function proposalsOf(
  requests: readonly ProposalRequest[],
  context: { drafts: readonly StudioDraft[]; granted: readonly string[] },
): Proposal[] {
  const { drafts, granted } = context;
  return requests.map(({ seq, widget, metadata }) => {
    const settled = settle(widget, metadata, { drafts, granted });
    return {
      seq,
      widget,
      ...placeOf(widget),
      state: settled.state,
      decision: settled.decision,
      draft: settled.draft ?? null,
    };
  });
}

/** The one reply that tells the coach every answer; null while any proposal is open. */
export function turnReply(proposals: readonly Proposal[]): string | null {
  const answered = proposals.filter((proposal) => proposal.state !== "replaced");
  return batchReply(answered.map((proposal) => proposal.decision));
}

/** How many open proposals each key holds, such as each section or each agent. */
export function countOpen(
  proposals: readonly Proposal[],
  keyOf: (proposal: Proposal) => string | null,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const proposal of proposals) {
    const key = proposal.state === "open" ? keyOf(proposal) : null;
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
