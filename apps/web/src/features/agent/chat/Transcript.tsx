import { Clock, MessageSquare } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { attachmentBlobUrl } from "../../../api/attachments";
import { liveTurnActive, type LiveTurn } from "../../../api/liveTurn";
import type { ToolProgress } from "../../../api/toolProgress";
import type { AgentDetail, MessageAttachment, Run, RunMessage } from "../../../api/types";
import { agentLook } from "../../../app/agents";
import { isoTime, messageTime } from "../../../app/format";
import { useIdentity } from "../../../app/identity";
import {
  Markdown,
  OfferedTools,
  PromptSections,
  AgentMessage,
  OperatorMessage,
  TypingIndicator,
  Banner,
  personTone,
  Icon,
} from "@guildsrun/ui";
import { askedRequest, type SecretRequest } from "../../access/secrets";
import {
  buildFlowSegments,
  turnReasoning,
  turnText,
  type FlowCall,
  type FlowSegment,
} from "../runs/runFlowModel";
import { FlowView, type RevealStep } from "./FlowView";
import { Reasoning } from "./Reasoning";
import { offeredToolGroups, promptSectionsOf } from "./runContext";
import { SecretRequestCard } from "./SecretRequestCard";

type TranscriptProps = {
  agent: AgentDetail;
  run: Run;
  messages: RunMessage[];
  live: LiveTurn | null;
  /** What running tool calls have reported so far, by call id. */
  progress?: ToolProgress;
  /** A step to open and scroll to. */
  reveal?: RevealStep;
  /** Pins a call to a question for Studio's coach. */
  onAskCall?: ((call: FlowCall) => void) | undefined;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageAttachments(meta: Record<string, unknown>): MessageAttachment[] {
  const raw = meta.attachments;
  if (!Array.isArray(raw)) return [];
  const out: MessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const filename = typeof row.filename === "string" ? row.filename : "";
    const mime = typeof row.mime === "string" ? row.mime : "";
    const kind = row.kind === "file" || row.kind === "image" ? row.kind : null;
    if (!id || !filename || !mime || !kind) continue;
    out.push({ id, filename, mime, kind });
  }
  return out;
}

function AttachmentImage({ id, filename }: { id: string; filename: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void attachmentBlobUrl(id)
      .then((next) => {
        if (cancelled) {
          URL.revokeObjectURL(next);
          return;
        }
        url = next;
        setSrc(next);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  if (!src) {
    return <span className="text-xs text-muted">{filename}</span>;
  }
  return <img src={src} alt={filename} className="max-h-56 max-w-full rounded-md object-contain" />;
}

function OperatorAttachments({ items }: { items: MessageAttachment[] }) {
  const images = items.filter((item) => item.kind === "image");
  if (!images.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {images.map((item) => (
        <li key={item.id}>
          <AttachmentImage id={item.id} filename={item.filename} />
        </li>
      ))}
    </ul>
  );
}

/** What woke the agent when the run did not start from this chat. */
function WakeNote({ icon, children }: { icon: typeof Clock; children: string }) {
  return (
    <div className="flex items-center gap-2 self-center rounded-full bg-surface px-3 py-1.5 text-xs text-muted">
      <Icon icon={icon} size={14} />
      {children}
    </div>
  );
}

/** The secret_request calls in a flow that asked the operator, each with its call id. */
function secretRequests(flow: FlowSegment): Array<{ id: string; request: SecretRequest }> {
  return flow.steps.flatMap((step) =>
    step.calls.flatMap((call) => {
      if (call.call.function?.name !== "secret_request") return [];
      const request = askedRequest(call.call.function.arguments, call.result?.payload?.content);
      return request ? [{ id: `${call.id}:${call.position}`, request }] : [];
    }),
  );
}

/** A run from its prompt to its latest turn: messages, and each generation's steps and calls. */
export function Transcript({
  agent,
  run,
  messages,
  live,
  progress,
  reveal,
  onAskCall,
}: TranscriptProps) {
  const { user } = useIdentity();
  const { segments, unattachedErrors } = useMemo(
    () => buildFlowSegments(messages, run),
    [messages, run],
  );
  const look = agentLook(agent);
  const system = messages.find((message) => message.seq === 0 && message.payload.role === "system");
  const lastFlow = segments.findLastIndex((segment) => segment.type === "flow");
  const latestError = unattachedErrors.at(-1);

  return (
    <>
      <OfferedTools groups={offeredToolGroups(run)} />
      {system ? (
        <PromptSections sections={promptSectionsOf(String(system.payload.content ?? ""))} />
      ) : null}
      {latestError ? (
        <Banner
          tone="error"
          title={String(latestError.message ?? "The run failed")}
          meta={String(latestError.operation ?? "")}
        />
      ) : null}

      {segments.map((segment, index) => {
        if (segment.type === "flow") {
          return (
            <Fragment key={segment.key}>
              <FlowView
                flow={segment}
                runId={run.id}
                generating={run.generating}
                {...(progress ? { progress } : {})}
                defaultOpen={index === lastFlow || run.generating}
                {...(reveal ? { reveal } : {})}
                inspector={{ guildId: agent.guild_id, agentId: agent.id }}
                onAskCall={onAskCall}
              />
              {secretRequests(segment).map((item) => (
                <SecretRequestCard key={item.id} agent={agent} run={run} request={item.request} />
              ))}
            </Fragment>
          );
        }
        const message = segment.msg;
        const payload = record(message.payload);
        const meta = record(message.metadata);
        const seq = Number(message.seq);
        const createdAt = typeof message.created_at === "string" ? message.created_at : "";
        if (payload.role === "system") {
          if (seq === 0) return null;
          return (
            <Banner key={seq} tone="info" title="System note">
              {String(payload.content ?? "")}
            </Banner>
          );
        }
        if (payload.role === "user") {
          if (meta.source === "group_chat") {
            return (
              <WakeNote key={seq} icon={MessageSquare}>
                {`Woken by the group chat · message ${String(meta.group_seq ?? "")} from ${String(meta.author_name ?? "someone")}`}
              </WakeNote>
            );
          }
          if (meta.source === "schedule") {
            return (
              <WakeNote key={seq} icon={Clock}>
                Woken by a routine
              </WakeNote>
            );
          }
          const attachments = messageAttachments(meta);
          const text = turnText(message);
          return (
            <OperatorMessage
              key={seq}
              author="You"
              tone={personTone(user.color)}
              {...(createdAt ? { time: messageTime(createdAt), dateTime: isoTime(createdAt) } : {})}
            >
              <div className="flex flex-col gap-2">
                <OperatorAttachments items={attachments} />
                {text.trim() ? <Markdown density="compact">{text}</Markdown> : null}
              </div>
            </OperatorMessage>
          );
        }
        const text = turnText(message);
        const reasoning = turnReasoning(message);
        return (
          <AgentMessage
            key={seq}
            name={agent.name}
            {...look}
            bubble="surface"
            {...(createdAt ? { time: messageTime(createdAt), dateTime: isoTime(createdAt) } : {})}
          >
            <div className="flex flex-col gap-2">
              {reasoning ? <Reasoning text={reasoning} /> : null}
              {text.trim() ? <Markdown density="compact">{text}</Markdown> : null}
              {meta.finish_reason === "length" ? (
                <p className="text-xs text-t-ochre-fg">
                  Output token limit reached; the reply stops here.
                </p>
              ) : null}
            </div>
          </AgentMessage>
        );
      })}

      {liveTurnActive(live) ? (
        <AgentMessage name={agent.name} {...look} bubble="surface">
          <div className="flex flex-col gap-2">
            {live.reasoning ? <Reasoning text={live.reasoning} streaming={!live.text} /> : null}
            {live.text ? <Markdown density="compact">{live.text}</Markdown> : null}
          </div>
        </AgentMessage>
      ) : run.generating ? (
        <TypingIndicator name={agent.name} {...look} bubble="surface" />
      ) : null}
    </>
  );
}
