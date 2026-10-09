import { Pin } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  useAskInNewSession,
  useCancelStudio,
  useDecideEdit,
  useGrantStudioConnection,
  usePostStudioMessage,
  useStudioEdit,
} from "../../api/queries";
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
  connectionLabel,
  editTargetLabel,
  focusOf,
  widgetOf,
  type AccessWidget,
  type EditWidget,
} from "./chatModel";
import type { StudioPin } from "./investigate";
import { focusLocation } from "./location";
import { useStudio } from "./StudioContext";

const coach = { name: "coach", tone: "signal" as const };

type StudioChatProps = {
  session: StudioSession;
  messages: StudioMessage[] | undefined;
  live: string;
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
  const generating = session.generation_state !== "idle";

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

  const widgetsAfter = (segment: FlowSegment<CoachRow>, rows: readonly CoachRow[]) =>
    segment.steps.flatMap((step) =>
      step.calls.flatMap((call) => {
        const widget = widgetOf(call.result);
        if (!widget || !call.result) return [];
        const seq = call.result.seq;
        const done = answered(rows, seq);
        return [
          widget.kind === "edit" ? (
            <EditCard
              key={`edit-${seq}`}
              session={session}
              seq={seq}
              widget={widget}
              answered={done}
              onDecided={carryOn}
            />
          ) : (
            <AccessCard
              key={`access-${seq}`}
              session={session}
              widget={widget}
              answered={done}
              onDecided={carryOn}
            />
          ),
        ];
      }),
    );

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

function EditCard({
  session,
  seq,
  widget,
  answered: done,
  onDecided,
}: {
  session: StudioSession;
  seq: number;
  widget: EditWidget;
  answered: boolean;
  onDecided: (message: string) => void;
}) {
  const view = useStudioEdit(session.id, seq);
  const decide = useDecideEdit(session.id);
  const target = editTargetLabel(widget.edit);
  const lines = widget.edit.lines ?? {};
  const status = view.data?.status ?? "pending";
  const live = session.status === "active" && session.generation_state === "idle";
  const action = widget.edit.kind === "collection" ? widget.edit.action : undefined;
  const effects = status === "pending" ? (view.data?.effects ?? []) : [];

  const choose = (decision: "apply" | "decline") =>
    decide.mutate(
      { seq, decision },
      {
        onSuccess: () =>
          onDecided(
            decision === "apply"
              ? `Applied the edit to ${target}. Continue.`
              : `Declined the edit to ${target}. Continue without it.`,
          ),
        onError: (error) =>
          toast({
            kind: "error",
            title: "Couldn't record the decision",
            description: error.message,
          }),
      },
    );

  return (
    <RequestCard title={widget.title ?? `Edit ${target}`} reason={widget.reason}>
      <span className="font-mono text-xs text-fg-2">
        {target} · +{lines.added ?? 0} −{lines.removed ?? 0} lines
        {widget.edit.base_version !== undefined ? ` · from v${widget.edit.base_version}` : ""}
      </span>
      {status !== "pending" ? (
        <Tag tone={status === "applied" ? "tide" : "well"} font="sans" className="self-start">
          {status === "applied"
            ? `Applied${view.data?.applied_version ? ` as v${view.data.applied_version}` : ""}`
            : "Declined"}
        </Tag>
      ) : view.data?.stale ? (
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
      {status === "pending" && view.data ? <EditDiff view={view.data} /> : null}
      {status === "pending" && !done ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={action === "delete" ? "destructive" : "primary"}
            disabled={!live || decide.isPending || Boolean(view.data?.stale)}
            onClick={() => choose("apply")}
          >
            {action === "create"
              ? "Create table"
              : action === "delete"
                ? "Delete table"
                : "Apply edit"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!live || decide.isPending}
            onClick={() => choose("decline")}
          >
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
  session,
  widget,
  answered: done,
  onDecided,
}: {
  session: StudioSession;
  widget: AccessWidget;
  answered: boolean;
  onDecided: (message: string) => void;
}) {
  const grant = useGrantStudioConnection(session.id);
  const connection = widget.connection;
  const label = connectionLabel(connection);
  const granted = Boolean(connection.id && session.granted_connection_ids.includes(connection.id));
  const live = session.status === "active" && session.generation_state === "idle";

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
      ) : done ? (
        <Tag tone="well" font="sans" className="self-start">
          Answered
        </Tag>
      ) : (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!live || !connection.id || grant.isPending}
            onClick={() =>
              connection.id &&
              grant.mutate(
                { connectionId: connection.id, granted: true },
                {
                  onSuccess: () => onDecided(`Granted read access to ${label}. Continue.`),
                  onError: (error) =>
                    toast({
                      kind: "error",
                      title: "Couldn't grant access",
                      description: error.message,
                    }),
                },
              )
            }
          >
            Grant read access
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!live}
            onClick={() => onDecided(`Declined read access to ${label}. Continue without it.`)}
          >
            Decline
          </Button>
        </div>
      )}
    </RequestCard>
  );
}
