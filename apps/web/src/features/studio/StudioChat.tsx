import { Pin } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  useAskInNewSession,
  useCancelStudio,
  usePostStudioMessage,
} from "../../api/queries/studio";
import type { LiveTurn } from "../../api/liveTurn";
import type { StudioMessage, StudioSession } from "../../api/types";
import { Button, Checkbox, Composer, Banner, toast, Icon } from "@guildsrun/ui";
import type { FlowSegment } from "../agent/runs/runFlowModel";
import { CoachLog, type CoachRow } from "../coach/CoachLog";
import { answered } from "../coach/coachRows";
import { focusOf, widgetOf } from "./chatModel";
import type { StudioPin } from "./investigate";
import { focusLocation } from "./location";
import { proposalsOf, type ProposalRequest } from "./pendingModel";
import { ProposalCard, SettleAll } from "./ProposalCards";
import { useStudio } from "./StudioContext";

const coach = { name: "coach", tone: "signal" as const };

type StudioChatProps = {
  session: StudioSession;
  messages: StudioMessage[] | undefined;
  live: LiveTurn | null;
  /** Evidence the next message is about; sending it clears the pin. */
  pin: StudioPin | null;
  onUnpin: () => void;
};

/**
 * The coach conversation: the operator's messages and pinned evidence, the coach's steps and
 * replies as they are written, and the edits or logins it asks the operator to decide on.
 */
export function StudioChat({ session, messages, live, pin, onUnpin }: StudioChatProps) {
  const { go, search, approvals } = useStudio();
  const waiting = approvals.open.length;
  const navigate = useNavigate();
  const post = usePostStudioMessage(session.id);
  const askElsewhere = useAskInNewSession(session);
  const cancel = useCancelStudio(session.id);
  const [fresh, setFresh] = useState(false);
  const generating =
    session.generation_state !== "idle" || post.isPending || askElsewhere.isPending;

  const failed = (error: Error) =>
    toast({ kind: "error", title: "Couldn't message the coach", description: error.message });

  const send = (content: string) => {
    if (pin && fresh) {
      askElsewhere.mutate(
        { content, focus: pin.focus },
        {
          onSuccess: (child) => {
            onUnpin();
            setFresh(false);
            void navigate({
              to: "/studio/$sessionId",
              params: { sessionId: child.id },
              search,
            });
          },
          onError: failed,
        },
      );
      return;
    }
    post.mutate(
      { content, ...(pin ? { focus: pin.focus } : {}) },
      { onSuccess: onUnpin, onError: failed },
    );
  };

  const metadataAt = (seq: number) =>
    messages?.find((message) => message.seq === seq)?.metadata ?? {};
  const widgetsAfter = (segment: FlowSegment<CoachRow>, rows: readonly CoachRow[]) => {
    const requests = segment.steps.flatMap((step) =>
      step.calls.flatMap((call) => {
        const widget = widgetOf(call.result);
        return widget && call.result
          ? [{ seq: call.result.seq, widget, metadata: metadataAt(call.result.seq) }]
          : [];
      }),
    );
    if (!requests.length) return null;
    return (
      <RequestBatch
        key={`requests-${requests[0]?.seq}`}
        requests={requests}
        answered={requests.every((request) => answered(rows, request.seq))}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {waiting ? (
        <div className="border-b border-line px-5 py-2 text-sm font-medium text-fg-2" role="status">
          Waiting on {waiting} decision{waiting === 1 ? "" : "s"}
        </div>
      ) : null}
      <CoachLog
        messages={messages}
        live={live}
        generating={generating}
        coach={coach}
        empty="Ask the coach about this guild: why an agent did something, or how to change its Task."
        widgetsAfter={widgetsAfter}
        operatorNote={(message) => {
          const focus = focusOf(message);
          if (!focus) return null;
          const where = focusLocation(focus);
          return (
            <button
              type="button"
              disabled={!where}
              title={where ? "Open this in the inspector" : undefined}
              onClick={() => where && go(where)}
              className="ml-auto flex w-fit cursor-pointer items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-xs text-fg-2 hover:bg-paper-hi disabled:cursor-default"
            >
              <Icon icon={Pin} size={14} />
              Pinned {focus.kind.replace("_", " ")}: {focus.label}
            </button>
          );
        }}
      />
      <div className="flex flex-col gap-2 px-5 pb-5">
        {session.status !== "active" ? (
          <Banner
            tone="info"
            title={
              session.status === "archived" ? "This session is archived" : "This session is blocked"
            }
          >
            {session.status === "archived"
              ? "It stays readable; start a new session to keep working."
              : session.blocked_reason === "input_token_limit"
                ? "The conversation reached the coach's input limit. Continue in a new session that starts from a summary."
                : "Its guild is gone."}
          </Banner>
        ) : null}
        {pin ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 self-start rounded-2xl bg-surface py-1 pr-1 pl-3 text-xs text-fg-2">
            <span className="flex items-center gap-2">
              <Icon icon={Pin} size={14} />
              {pin.focus.label}
            </span>
            <Checkbox
              label="Ask in a new session"
              checked={fresh}
              onCheckedChange={(value) => setFresh(value === true)}
            />
            <Button variant="ghost" size="xs" onClick={onUnpin}>
              Unpin
            </Button>
          </div>
        ) : null}
        <Composer
          label="Message the coach"
          placeholder="Ask the coach about this guild…"
          defaultValue={pin?.prompt ?? ""}
          disabled={session.status !== "active"}
          generating={generating || post.isPending || askElsewhere.isPending}
          onCancel={() => cancel.mutate()}
          onSend={send}
        />
      </div>
    </div>
  );
}

/**
 * The requests one coach turn made, each on its own card, with Apply all and Decline all while
 * several are open. The coach continues with one reply once every request is answered.
 */
function RequestBatch({
  requests,
  answered: done,
}: {
  requests: ProposalRequest[];
  answered: boolean;
}) {
  const { approvals } = useStudio();
  const seqs = new Set(requests.map((request) => request.seq));
  const current = approvals.proposals.filter((proposal) => seqs.has(proposal.seq));
  const proposals = !done && current.length ? current : proposalsOf(requests, approvals);
  const open = done ? [] : proposals.filter((proposal) => proposal.state === "open");
  const idle = approvals.live && !approvals.busy;

  return (
    <>
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.seq} proposal={proposal} actionable={!done} showable />
      ))}
      {open.length && proposals.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 self-start">
          <span className="text-sm text-fg-2">
            {open.length} of {proposals.length} left to decide; the coach continues once each is
            answered.
          </span>
          {open.length > 1 ? <SettleAll open={open} disabled={!idle} /> : null}
        </div>
      ) : null}
      {!done && approvals.reply && idle && !approvals.replying ? (
        <Button size="sm" className="self-start" onClick={approvals.carryOn}>
          Continue
        </Button>
      ) : null}
    </>
  );
}
