import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { liveTurnActive, type LiveTurn } from "../../api/liveTurn";
import type { StudioMessage } from "../../api/types/studio";
import { isoTime, messageTime } from "../../app/format";
import { useIdentity } from "../../app/identity";
import {
  Markdown,
  AgentMessage,
  OperatorMessage,
  TypingIndicator,
  TypingDots,
  SkeletonRows,
  personTone,
} from "@guildsrun/ui";
import type { IdentityTone } from "@guildsrun/ui";
import { FlowView } from "../agent/chat/FlowView";
import { Reasoning } from "../agent/chat/Reasoning";
import {
  buildFlowSegments,
  turnReasoning,
  turnText,
  type FlowSegment,
} from "../agent/runs/runFlowModel";
import { asRunMessages } from "./coachRows";

/** One row of a coach conversation, readable by the run flow model. */
export type CoachRow = ReturnType<typeof asRunMessages>[number];

type CoachLogProps = {
  messages: StudioMessage[] | undefined;
  /** The coach's reply as it is being written. */
  live: LiveTurn | null;
  generating: boolean;
  coach: { name: string; tone: IdentityTone };
  /** Shown before the operator has written anything. */
  empty: ReactNode;
  /** What the coach asks the operator to decide, shown after the steps that asked it. */
  widgetsAfter: (segment: FlowSegment<CoachRow>, rows: readonly CoachRow[]) => ReactNode;
  /** An operator row shown as a note instead of a message, such as pinned evidence; null keeps the message. */
  operatorNote?: (message: CoachRow) => ReactNode | null;
};

/**
 * A conversation with a coach: the operator's messages, the coach's steps and replies as they are
 * written, and its requests after the steps that made them. It follows the end while the reader
 * is there, and jumps to it when the operator sends.
 */
export function CoachLog({
  messages,
  live,
  generating,
  coach,
  empty,
  widgetsAfter,
  operatorNote,
}: CoachLogProps) {
  const { user } = useIdentity();
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const rows = useMemo(() => asRunMessages(messages ?? []), [messages]);
  const segments = useMemo(() => buildFlowSegments(rows, null).segments, [rows]);
  const lastRole = rows.at(-1)?.payload.role;

  useLayoutEffect(() => {
    const el = log.current;
    if (el && (atBottom.current || lastRole === "user")) el.scrollTop = el.scrollHeight;
  }, [rows.length, live, generating, lastRole]);

  return (
    <div
      ref={log}
      onScroll={(event) => {
        const el = event.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
    >
      <div className="flex flex-col gap-3">
        {!messages ? (
          <SkeletonRows rows={5} label="Loading the conversation" />
        ) : rows.length <= 1 ? (
          <div className="py-6 text-center text-sm text-muted">{empty}</div>
        ) : null}
        {segments.map((segment) => {
          if (segment.type === "flow") {
            return (
              <div key={segment.key} className="flex flex-col gap-3">
                <FlowView flow={segment} generating={generating} />
                {widgetsAfter(segment, rows)}
              </div>
            );
          }
          const message = segment.msg;
          const role = message.payload.role;
          if (role === "system") return null;
          const time = {
            time: messageTime(message.created_at),
            dateTime: isoTime(message.created_at),
          };
          if (role === "user") {
            const note = operatorNote?.(message);
            if (note) return <div key={message.seq}>{note}</div>;
            return (
              <OperatorMessage
                key={message.seq}
                author="You"
                tone={personTone(user.color)}
                {...time}
              >
                <Markdown density="compact">{turnText(message)}</Markdown>
              </OperatorMessage>
            );
          }
          const text = turnText(message);
          const reasoning = turnReasoning(message);
          if (!text.trim() && !reasoning) {
            return message.metadata.finish_reason === "length" ? (
              <p key={message.seq} className="text-xs text-t-ochre-fg">
                The coach reached its output limit before replying.
              </p>
            ) : null;
          }
          return (
            <AgentMessage key={message.seq} {...coach} bubble="surface" {...time}>
              <div className="flex flex-col gap-2">
                {reasoning ? <Reasoning text={reasoning} /> : null}
                {text.trim() ? <Markdown density="compact">{text}</Markdown> : null}
                {message.metadata.finish_reason === "length" ? (
                  <p className="text-xs text-t-ochre-fg">
                    The coach reached its output limit before replying.
                  </p>
                ) : null}
              </div>
            </AgentMessage>
          );
        })}
        {liveTurnActive(live) ? (
          <AgentMessage {...coach} bubble="surface">
            <div className="flex flex-col gap-2">
              {live?.reasoning ? <Reasoning text={live.reasoning} streaming={!live.text} /> : null}
              {live?.text ? <Markdown density="compact">{live.text}</Markdown> : null}
              {generating ? (
                <TypingDots role="status" aria-label="Still writing" className="py-1" />
              ) : null}
            </div>
          </AgentMessage>
        ) : generating ? (
          <TypingIndicator {...coach} bubble="surface" />
        ) : null}
      </div>
    </div>
  );
}
