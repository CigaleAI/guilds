import { Pin } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  useAskInNewSession,
  useCancelStudio,
  useDecideEdit,
  useGrantStudioConnection,
  usePostStudioMessage,
  useStudioEdits,
} from "../../api/queries";
import type { LiveTurn } from "../../api/liveTurn";
import type { StudioEdit, StudioMessage, StudioSession } from "../../api/types";
import {
  Button,
  Checkbox,
  DiffView,
  diffLines,
  Composer,
  Banner,
  toast,
  Icon,
  Tag,
} from "@guildsrun/ui";
import type { FlowSegment } from "../agent/runs/runFlowModel";
import { CoachLog, type CoachRow } from "../coach/CoachLog";
import { answered } from "../coach/coachRows";
import {
  applyLabel,
  batchReply,
  connectionLabel,
  decisionOf,
  editTargetLabel,
  focusOf,
  widgetOf,
  type AccessWidget,
  type EditWidget,
  type RequestDecision,
} from "./chatModel";
import type { StudioPin } from "./investigate";
import { focusLocation } from "./location";
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
  const { go, search } = useStudio();
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

  /** Tells the coach what the operator decided, so it carries on. */
  const carryOn = (content: string) =>
    post.mutate(
      { content },
      {
        onError: (error) =>
          toast({ kind: "error", title: "Couldn't message the coach", description: error.message }),
      },
    );

  const widgetsAfter = (segment: FlowSegment<CoachRow>, rows: readonly CoachRow[]) => {
    const requests = segment.steps.flatMap((step) =>
      step.calls.flatMap((call) => {
        const widget = widgetOf(call.result);
        return widget && call.result ? [{ seq: call.result.seq, widget }] : [];
      }),
    );
    if (!requests.length) return null;
    return (
      <RequestBatch
        key={`requests-${requests[0]?.seq}`}
        session={session}
        requests={requests}
        answered={requests.every((request) => answered(rows, request.seq))}
        replying={post.isPending}
        onReply={carryOn}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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

function RequestCard({
  title,
  reason,
  children,
}: {
  title: string;
  reason: string | undefined;
  children: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-3 self-start rounded-xl bg-t-sig p-4 text-fg">
      <div className="flex flex-col gap-1">
        <span className="text-md font-semibold">{title}</span>
        {reason ? <p className="text-sm text-fg-2">{reason}</p> : null}
      </div>
      {children}
    </article>
  );
}

type Request = { seq: number; widget: EditWidget | AccessWidget };

/**
 * The requests one coach turn made. Each is decided on its own card, or every pending edit at
 * once; the coach continues with one reply only when every request is applied, granted, or
 * declined.
 */
function RequestBatch({
  session,
  requests,
  answered: done,
  replying,
  onReply,
}: {
  session: StudioSession;
  requests: Request[];
  answered: boolean;
  /** Whether a reply to the coach is being sent. */
  replying: boolean;
  onReply: (content: string) => void;
}) {
  const editSeqs = requests.filter((request) => request.widget.kind === "edit").map((r) => r.seq);
  const views = useStudioEdits(session.id, editSeqs);
  const decide = useDecideEdit(session.id);
  const grant = useGrantStudioConnection(session.id);
  const [decided, setDecided] = useState<Record<number, RequestDecision>>({});
  const [settling, setSettling] = useState(false);
  const live = session.status === "active" && session.generation_state === "idle";
  const busy = decide.isPending || grant.isPending || settling;
  const viewOf = (seq: number) => views[editSeqs.indexOf(seq)]?.data;
  const granted = (widget: AccessWidget) =>
    Boolean(widget.connection.id && session.granted_connection_ids.includes(widget.connection.id));

  /** A request's answer: what the server recorded, else what this page decided. */
  const decisionFor = (request: Request, local: Record<number, RequestDecision>) => {
    if (request.widget.kind === "edit") {
      const status = viewOf(request.seq)?.status;
      if (status === "applied" || status === "declined") {
        return decisionOf(request.widget, status === "applied");
      }
    } else if (granted(request.widget)) {
      return decisionOf(request.widget, true);
    }
    return local[request.seq] ?? null;
  };
  const replyFor = (local: Record<number, RequestDecision>) =>
    batchReply(requests.map((request) => decisionFor(request, local)));

  /** Records answers; the one that leaves no request open sends the reply. */
  const record = (answers: Record<number, RequestDecision>) => {
    const next = { ...decided, ...answers };
    setDecided(next);
    const content = replyFor(next);
    if (content) onReply(content);
  };

  const failed = (title: string) => (error: Error) =>
    toast({ kind: "error", title, description: error.message });

  const chooseEdit = (request: Request & { widget: EditWidget }, decision: "apply" | "decline") =>
    decide.mutate(
      { seq: request.seq, decision },
      {
        onSuccess: () =>
          record({ [request.seq]: decisionOf(request.widget, decision === "apply") }),
        onError: failed("Couldn't record the decision"),
      },
    );

  const openEdits = done
    ? []
    : requests.filter(
        (request): request is Request & { widget: EditWidget } =>
          request.widget.kind === "edit" && decisionFor(request, decided) === null,
      );
  const openCount = done ? 0 : requests.filter((r) => decisionFor(r, decided) === null).length;
  const reply = done ? null : replyFor(decided);

  /** Applies or declines every open edit in turn; a refused one stops the rest. */
  const settleAll = async (decision: "apply" | "decline") => {
    setSettling(true);
    const answers: Record<number, RequestDecision> = {};
    try {
      for (const request of openEdits) {
        await decide.mutateAsync({ seq: request.seq, decision });
        answers[request.seq] = decisionOf(request.widget, decision === "apply");
      }
    } catch (error) {
      failed("Couldn't record the decision")(error as Error);
    } finally {
      setSettling(false);
      record(answers);
    }
  };
  const applyBlocked = openEdits.some((request) => {
    const view = viewOf(request.seq);
    return !view || view.stale;
  });

  return (
    <>
      {requests.map(({ seq, widget }) =>
        widget.kind === "edit" ? (
          <EditCard
            key={`edit-${seq}`}
            widget={widget}
            view={viewOf(seq)}
            open={!done && decided[seq] === undefined}
            disabled={!live || busy}
            onChoose={(decision) => chooseEdit({ seq, widget }, decision)}
          />
        ) : (
          <AccessCard
            key={`access-${seq}`}
            widget={widget}
            granted={granted(widget)}
            declined={decided[seq]?.accepted === false}
            open={!done}
            disabled={!live || busy}
            onGrant={() =>
              widget.connection.id &&
              grant.mutate(
                { connectionId: widget.connection.id, granted: true },
                {
                  onSuccess: () => record({ [seq]: decisionOf(widget, true) }),
                  onError: failed("Couldn't grant access"),
                },
              )
            }
            onDecline={() => record({ [seq]: decisionOf(widget, false) })}
          />
        ),
      )}
      {openCount > 0 && requests.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 self-start">
          <span className="text-sm text-fg-2">
            {openCount} of {requests.length} left to decide; the coach continues once each is
            answered.
          </span>
          {openEdits.length > 1 ? (
            <>
              <Button
                size="sm"
                variant={
                  openEdits.some((request) => request.widget.edit.action === "delete")
                    ? "destructive"
                    : "primary"
                }
                disabled={!live || busy || applyBlocked}
                onClick={() => void settleAll("apply")}
              >
                Apply all {openEdits.length}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!live || busy}
                onClick={() => void settleAll("decline")}
              >
                Decline all
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {reply && live && !busy && !replying ? (
        <Button size="sm" className="self-start" onClick={() => onReply(reply)}>
          Continue
        </Button>
      ) : null}
    </>
  );
}

function EditCard({
  widget,
  view,
  open,
  disabled,
  onChoose,
}: {
  widget: EditWidget;
  view: StudioEdit | undefined;
  /** Whether the request still waits for this operator's answer. */
  open: boolean;
  disabled: boolean;
  onChoose: (decision: "apply" | "decline") => void;
}) {
  const target = editTargetLabel(widget.edit);
  const lines = widget.edit.lines ?? {};
  const status = view?.status ?? "pending";
  const action = widget.edit.action;
  const effects = status === "pending" ? (view?.effects ?? []) : [];

  return (
    <RequestCard title={widget.title ?? `Edit ${target}`} reason={widget.reason}>
      <span className="font-mono text-xs text-fg-2">
        {target} · +{lines.added ?? 0} −{lines.removed ?? 0} lines
        {widget.edit.base_version !== undefined ? ` · from v${widget.edit.base_version}` : ""}
      </span>
      {status !== "pending" ? (
        <Tag tone={status === "applied" ? "tide" : "well"} font="sans" className="self-start">
          {status === "applied"
            ? `Applied${view?.applied_version ? ` as v${view.applied_version}` : ""}`
            : "Declined"}
        </Tag>
      ) : view?.stale ? (
        <p className="text-sm text-plum-t">
          The live content changed since this proposal; ask the coach to rebuild it, or decline.
        </p>
      ) : null}
      {effects.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg-2">
          {effects.map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
      ) : null}
      {status === "pending" && view ? <EditDiff view={view} /> : null}
      {status === "pending" && open ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={action === "delete" ? "destructive" : "primary"}
            disabled={disabled || Boolean(view?.stale)}
            onClick={() => onChoose("apply")}
          >
            {applyLabel(widget.edit)}
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChoose("decline")}>
            Decline
          </Button>
        </div>
      ) : null}
    </RequestCard>
  );
}

/**
 * What a pending edit changes: the live text beside the proposal, per guild field for guild edits;
 * a table's definition and access written out line by line.
 */
function EditDiff({ view }: { view: StudioEdit }) {
  if (view.error) return <p className="text-sm text-plum-t">{view.error}</p>;
  const { live, proposed } = view;
  if (typeof live === "string" || typeof proposed === "string" || !live || !proposed) {
    return (
      <DiffView
        lines={diffLines(
          typeof live === "string" ? live : "",
          typeof proposed === "string" ? proposed : "",
        )}
        title="live → proposed"
        className="max-h-96 overflow-y-auto"
      />
    );
  }
  return (
    <>
      {(["about", "description"] as const)
        .filter((field) => live[field] !== proposed[field])
        .map((field) => (
          <DiffView
            key={field}
            lines={diffLines(live[field], proposed[field])}
            title={`${field} · live → proposed`}
            className="max-h-96 overflow-y-auto"
          />
        ))}
    </>
  );
}

function AccessCard({
  widget,
  granted,
  declined,
  open,
  disabled,
  onGrant,
  onDecline,
}: {
  widget: AccessWidget;
  granted: boolean;
  declined: boolean;
  /** Whether the request still waits for this operator's answer. */
  open: boolean;
  disabled: boolean;
  onGrant: () => void;
  onDecline: () => void;
}) {
  const connection = widget.connection;
  const label = connectionLabel(connection);

  return (
    <RequestCard title={widget.title ?? "Grant read access"} reason={widget.reason}>
      <span className="font-mono text-xs text-fg-2">
        {label}
        {connection.owner_scope ? ` · ${connection.owner_scope} login` : ""}
      </span>
      {granted ? (
        <Tag tone="tide" font="sans" className="self-start">
          Granted
        </Tag>
      ) : declined ? (
        <Tag tone="well" font="sans" className="self-start">
          Declined
        </Tag>
      ) : !open ? (
        <Tag tone="well" font="sans" className="self-start">
          Answered
        </Tag>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={disabled || !connection.id} onClick={onGrant}>
            Grant read access
          </Button>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onDecline}>
            Decline
          </Button>
        </div>
      )}
    </RequestCard>
  );
}
