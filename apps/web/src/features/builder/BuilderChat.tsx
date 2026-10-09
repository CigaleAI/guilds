import { useMemo, useState } from "react";
import { useCancelBuilder, usePostBuilderMessage } from "../../api/queries";
import type { BuilderSession, StudioMessage } from "../../api/types";
import { Composer, Banner, toast } from "@guildsrun/ui";
import type { FlowSegment } from "../agent/runs/runFlowModel";
import { CoachLog, type CoachRow } from "../coach/CoachLog";
import { answered } from "../coach/coachRows";
import { ConnectCard, QuestionCard } from "./BuilderWidgets";
import { pendingQuestions, widgetOf, type BuilderWidget } from "./widgets";

const coach = { name: "coach", tone: "signal" as const };

/** A request no reply has settled: a connect card that still waits, or questions. */
function waiting(widget: BuilderWidget): boolean {
  if (widget.kind === "question") return true;
  return !(widget.recommendedScope === "org" && widget.alreadyConnected);
}

/** True while a request in the conversation still waits for the operator. */
export function openRequest(messages: readonly StudioMessage[]): boolean {
  return messages.some((message) => {
    const widget = widgetOf(message);
    return widget !== null && waiting(widget) && !answered(messages, message.seq);
  });
}

type BuilderChatProps = {
  session: BuilderSession;
  messages: StudioMessage[] | undefined;
  live: string;
};

/**
 * The Builder coach: the operator describes the guild, the coach designs it into the draft, asks
 * questions and for logins on the way, and the operator answers before it carries on.
 */
export function BuilderChat({ session, messages, live }: BuilderChatProps) {
  const post = usePostBuilderMessage(session.id);
  const cancel = useCancelBuilder(session.id);
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(() => new Set());
  const generating = session.generation_state !== "idle";
  const active = session.status === "active";
  const idle = active && !generating && !post.isPending;
  const pending = useMemo(
    () => pendingQuestions(session.recipe, answeredHere),
    [session.recipe, answeredHere],
  );
  const blocked = openRequest(messages ?? []) || pending !== null;

  const send = (content: string) =>
    post.mutate(content, {
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't message the coach", description: error.message }),
    });

  const widgetsAfter = (segment: FlowSegment<CoachRow>, rows: readonly CoachRow[]) =>
    segment.steps.flatMap((step) =>
      step.calls.flatMap((call) => {
        const widget = widgetOf(call.result);
        if (!widget || !call.result) return [];
        const key = `${widget.kind}-${call.result.seq}`;
        const props = { answered: answered(rows, call.result.seq), live: idle, onReply: send };
        return [
          widget.kind === "connect" ? (
            <ConnectCard key={key} {...props} widget={widget} />
          ) : (
            <QuestionCard key={key} {...props} widget={widget} />
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
        empty="Describe the guild you want: what it should do, for whom, with which services. The coach drafts the recipe and asks what it needs."
        widgetsAfter={widgetsAfter}
      />
      <div className="flex flex-col gap-2 px-5 pb-5">
        {session.status === "blocked" ? (
          <Banner tone="info" title="This session reached the coach's input limit">
            It stays readable, and its draft stays in Recipes. Start a new session to keep
            designing.
          </Banner>
        ) : null}
        {pending ? (
          <div className="max-h-72 overflow-y-auto rounded-xl">
            <QuestionCard
              key={pending.questions.map((question) => question.id).join("|")}
              widget={pending}
              kicker="Open questions in the design"
              answered={false}
              live={idle}
              onReply={(message) => {
                setAnsweredHere(
                  (current) =>
                    new Set([...current, ...pending.questions.map((question) => question.id)]),
                );
                send(message);
              }}
            />
          </div>
        ) : null}
        <Composer
          label="Message the coach"
          placeholder={
            blocked
              ? "Answer the request above to continue…"
              : "Describe what this guild should do…"
          }
          disabled={!active || blocked}
          generating={generating || post.isPending}
          onCancel={() => cancel.mutate()}
          onSend={send}
        />
      </div>
    </div>
  );
}
