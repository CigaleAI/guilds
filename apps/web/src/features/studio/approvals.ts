import { useEffect, useMemo, useRef, useState } from "react";
import {
  useDecideEdit,
  useDraftAction,
  usePostStudioMessage,
  useResolveStudioLogin,
} from "../../api/queries/studio";
import type { StudioDraft, StudioMessage, StudioSession } from "../../api/types";
import { toast } from "@guildsrun/ui";
import { turnProposals, turnReply, type Proposal } from "./pendingModel";

/** The coach's open turn, and how the operator answers it from anywhere in the workspace. */
export type Approvals = {
  /** Every request of the latest turn, decided or not. */
  proposals: Proposal[];
  /** The requests still waiting on the operator. */
  open: Proposal[];
  drafts: readonly StudioDraft[];
  granted: readonly string[];
  /** Whether answers can be given now: the session is live and the coach is not writing. */
  live: boolean;
  busy: boolean;
  /** Applies, grants or publishes one request; or declines or discards it. */
  decide: (proposal: Proposal, accept: boolean) => Promise<void>;
  /** Applies every open request that may go with others; returns how many it left. */
  applyAll: () => Promise<number>;
  declineAll: () => Promise<void>;
  /** The reply that would carry on the coach, once every request is answered. */
  reply: string | null;
  carryOn: () => void;
  replying: boolean;
};

/**
 * One set of answers for the whole workspace: a request decided in the tray, a tab, the chat or
 * the Logins popover counts the same, and the coach continues as soon as the last one is decided.
 */
export function useApprovals({
  sessionId,
  session,
  messages,
  drafts,
}: {
  sessionId: string;
  session: StudioSession | undefined;
  messages: readonly StudioMessage[] | undefined;
  drafts: readonly StudioDraft[] | undefined;
}): Approvals {
  const decideEdit = useDecideEdit(sessionId);
  const resolveLogin = useResolveStudioLogin(sessionId);
  const draftAction = useDraftAction(sessionId);
  const post = usePostStudioMessage(sessionId);
  const [settling, setSettling] = useState(false);
  const allDrafts = drafts ?? noDrafts;
  const granted = session?.granted_connection_ids ?? noGrants;
  const proposals = useMemo(
    () => turnProposals(messages ?? [], allDrafts, granted),
    [messages, allDrafts, granted],
  );
  const open = proposals.filter((proposal) => proposal.state === "open");
  const reply = turnReply(proposals);
  const live = session?.status === "active" && session.generation_state === "idle";
  const carryOn = () =>
    post.mutate(
      { content: reply ?? "" },
      {
        onError: (error) =>
          toast({ kind: "error", title: "Couldn't message the coach", description: error.message }),
      },
    );
  useCarryOnWhenSettled({
    proposals,
    open: open.length,
    reply,
    ready: live && !post.isPending,
    carryOn,
  });

  const decide = async (proposal: Proposal, accept: boolean) => {
    const widget = proposal.widget;
    if (widget.kind === "draft") {
      const draftId = proposal.draft?.id ?? widget.draft_id;
      await draftAction.mutateAsync({ draftId, action: accept ? "publish" : "discard" });
    } else if (widget.kind === "access") {
      await resolveLogin.mutateAsync({ seq: proposal.seq, decision: accept ? "grant" : "decline" });
    } else {
      await decideEdit.mutateAsync({ seq: proposal.seq, decision: accept ? "apply" : "decline" });
    }
  };
  const settleEach = async (targets: Proposal[], accept: boolean) => {
    setSettling(true);
    try {
      for (const proposal of targets) await decide(proposal, accept);
    } catch (error) {
      toast({
        kind: "error",
        title: "Couldn't record the decision",
        description: (error as Error).message,
      });
    } finally {
      setSettling(false);
    }
  };

  return {
    proposals,
    open,
    drafts: allDrafts,
    granted,
    live,
    busy: settling || decideEdit.isPending || resolveLogin.isPending || draftAction.isPending,
    decide,
    applyAll: async () => {
      const [alone, together] = partition(open, (proposal) => proposal.alone);
      await settleEach(together, true);
      return alone.length;
    },
    declineAll: () => settleEach(open, false),
    reply,
    carryOn,
    replying: post.isPending,
  };
}

const noDrafts: readonly StudioDraft[] = [];
const noGrants: readonly string[] = [];

function partition<T>(items: readonly T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((item) => !test(item))];
}

/**
 * Sends the reply once the turn's last open request is decided while this page watches. A turn
 * that was already settled when the page opened waits for **Continue** instead.
 */
function useCarryOnWhenSettled(turn: {
  proposals: Proposal[];
  open: number;
  reply: string | null;
  ready: boolean;
  carryOn: () => void;
}) {
  const key = turn.proposals[0]?.seq ?? null;
  const seen = useRef<{ key: number | null; open: number; sent: boolean }>({
    key,
    open: turn.open,
    sent: false,
  });
  useEffect(() => {
    const previous = seen.current;
    const sameTurn = previous.key === key;
    const settledNow = sameTurn && previous.open > 0 && turn.open === 0;
    const send = settledNow && !previous.sent && turn.reply !== null && turn.ready;
    if (send) turn.carryOn();
    seen.current = {
      key,
      open: send || !settledNow ? turn.open : previous.open,
      sent: (sameTurn && previous.sent) || send,
    };
  });
}
