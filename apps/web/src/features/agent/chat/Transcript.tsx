import { Clock, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { attachmentBlobUrl } from "../../../api/attachments";
import { liveTurnActive, type LiveTurn } from "../../../api/liveTurn";
import type { ToolProgress } from "../../../api/toolProgress";
import type { AgentDetail } from "../../../api/types/agents";
import type { MessageAttachment, Run, RunMessage } from "../../../api/types/runs";
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
  TypingDots,
  Banner,
  personTone,
  Icon,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@guildsrun/ui";
import { askedRequest, type SecretRequest } from "../../access/secrets";
import {
  buildFlowSegments,
  turnReasoning,
  turnText,
  type FlowCall,
  type FlowSegment,
} from "../runs/runFlowModel";
import { isJsonObject } from "../runs/toolFormat";
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

const ATTACHMENT_KINDS = ["image", "file"] as const;

function isAttachmentKind(value: unknown): value is MessageAttachment["kind"] {
  const kinds: readonly unknown[] = ATTACHMENT_KINDS;
  return kinds.includes(value);
}

/** Whether a value is an attachment reference a user message stores, its id, filename and MIME type filled. */
function isMessageAttachment(value: unknown): value is MessageAttachment {
  if (!isJsonObject(value)) return false;
  const { id, filename, mime, kind } = value;
  return (
    typeof id === "string" &&
    id !== "" &&
    typeof filename === "string" &&
    filename !== "" &&
    typeof mime === "string" &&
    mime !== "" &&
    isAttachmentKind(kind)
  );
}

/** The attachments a user message's metadata references; a malformed reference is left out. */
export function messageAttachments(meta: Record<string, unknown>): MessageAttachment[] {
  const raw = meta.attachments;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isMessageAttachment)
    .map(({ id, filename, mime, kind }) => ({ id, filename, mime, kind }));
}

/** An attached image as a blob URL, or `null` when it cannot be fetched and its filename shows instead. */
export async function attachmentImageUrl(id: string): Promise<string | null> {
  try {
    return await attachmentBlobUrl(id);
  } catch {
    return null;
  }
}

type AttachmentImageProps = { id: string; filename: string };

function AttachmentImage({ id, filename }: AttachmentImageProps) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void attachmentImageUrl(id).then((next) => {
      if (cancelled) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      url = next;
      setSrc(next);
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

type OperatorAttachmentsProps = { items: MessageAttachment[] };

function OperatorAttachments({ items }: OperatorAttachmentsProps) {
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

type WakeNoteProps = { icon: typeof Clock; children: string };

/** What woke the agent when the run did not start from this chat. */
function WakeNote({ icon, children }: WakeNoteProps) {
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

/** When a message was written, as a chat row shows it; nothing for a message without a time. */
function messageStamp(message: RunMessage): { time?: string; dateTime?: string } {
  const createdAt = typeof message.created_at === "string" ? message.created_at : "";
  return createdAt ? { time: messageTime(createdAt), dateTime: isoTime(createdAt) } : {};
}

type UserTurnProps = { message: RunMessage };

/** The operator's message, or what woke the agent when the run did not start from this chat. */
function UserTurn({ message }: UserTurnProps) {
  const { user } = useIdentity();
  const meta = message.metadata;
  if (meta.source === "group_chat") {
    return (
      <WakeNote icon={MessageSquare}>
        {`Woken by the group chat · message ${String(meta.group_seq ?? "")} from ${String(meta.author_name ?? "someone")}`}
      </WakeNote>
    );
  }
  if (meta.source === "schedule") {
    return <WakeNote icon={Clock}>Woken by a routine</WakeNote>;
  }
  const text = turnText(message);
  return (
    <OperatorMessage author="You" tone={personTone(user.color)} {...messageStamp(message)}>
      <div className="flex flex-col gap-2">
        <OperatorAttachments items={messageAttachments(meta)} />
        {text.trim() ? <Markdown density="compact">{text}</Markdown> : null}
      </div>
    </OperatorMessage>
  );
}

type AgentTurnProps = { agent: AgentDetail; message: RunMessage };

/** The agent's reply: its reasoning, what it said, and whether the token limit cut it short. */
function AgentTurn({ agent, message }: AgentTurnProps) {
  const text = turnText(message);
  const reasoning = turnReasoning(message);
  return (
    <AgentMessage
      name={agent.name}
      {...agentLook(agent)}
      bubble="surface"
      {...messageStamp(message)}
    >
      <div className="flex flex-col gap-2">
        {reasoning ? <Reasoning text={reasoning} /> : null}
        {text.trim() ? <Markdown density="compact">{text}</Markdown> : null}
        {message.metadata.finish_reason === "length" ? (
          <p className="text-xs text-t-ochre-fg">
            Output token limit reached; the reply stops here.
          </p>
        ) : null}
      </div>
    </AgentMessage>
  );
}

type TranscriptMessageProps = { agent: AgentDetail; message: RunMessage };

/** A message outside the tool flows: a system note, the operator's turn, or the agent's reply. */
function TranscriptMessage({ agent, message }: TranscriptMessageProps) {
  const { payload } = message;
  if (payload.role === "system") {
    if (Number(message.seq) === 0) return null;
    return (
      <Banner tone="info" title="System note">
        {String(payload.content ?? "")}
      </Banner>
    );
  }
  if (payload.role === "user") return <UserTurn message={message} />;
  return <AgentTurn agent={agent} message={message} />;
}

type TranscriptFlowProps = {
  agent: AgentDetail;
  run: Run;
  flow: FlowSegment;
  progress: ToolProgress | undefined;
  reveal: RevealStep | undefined;
  onAskCall: ((call: FlowCall) => void) | undefined;
};

/** A generation's tool flow, then a card for each secret its calls asked the operator for. */
function TranscriptFlow({ agent, run, flow, progress, reveal, onAskCall }: TranscriptFlowProps) {
  return (
    <>
      <FlowView
        flow={flow}
        runId={run.id}
        generating={run.generating}
        {...(progress ? { progress } : {})}
        harness={agent.config.harness}
        {...(reveal ? { reveal } : {})}
        inspector={{ guildId: agent.guild_id, agentId: agent.id }}
        onAskCall={onAskCall}
      />
      {secretRequests(flow).map((item) => (
        <SecretRequestCard key={item.id} agent={agent} run={run} request={item.request} />
      ))}
    </>
  );
}

type LiveReplyProps = { agent: AgentDetail; live: LiveTurn | null; generating: boolean };

/** The reply the agent is writing: what it has streamed so far, or that it is typing. */
function LiveReply({ agent, live, generating }: LiveReplyProps) {
  const look = agentLook(agent);
  if (!liveTurnActive(live)) {
    return generating ? <TypingIndicator name={agent.name} {...look} bubble="surface" /> : null;
  }
  return (
    <AgentMessage name={agent.name} {...look} bubble="surface">
      <div className="flex flex-col gap-2">
        {live.reasoning ? <Reasoning text={live.reasoning} streaming={!live.text} /> : null}
        {live.text ? <Markdown density="compact">{live.text}</Markdown> : null}
        {generating ? (
          <TypingDots role="status" aria-label="Still writing" className="py-1" />
        ) : null}
      </div>
    </AgentMessage>
  );
}

/** A run from its prompt to its latest turn, with its system prompt and offered tools on their own tabs. */
export function Transcript({
  agent,
  run,
  messages,
  live,
  progress,
  reveal,
  onAskCall,
}: TranscriptProps) {
  const { segments, unattachedErrors } = useMemo(
    () => buildFlowSegments(messages, run),
    [messages, run],
  );
  const system = messages.find((message) => message.seq === 0 && message.payload.role === "system");
  const latestError = unattachedErrors.at(-1);
  const toolGroups = offeredToolGroups(run);
  const toolCount = toolGroups.reduce((sum, group) => sum + group.tools.length, 0);
  const [view, setView] = useState("conversation");

  return (
    <Tabs value={view} onValueChange={setView} className="gap-3">
      <TabsList aria-label="Run views" className="w-fit">
        <TabsTrigger value="conversation">Conversation</TabsTrigger>
        {system ? <TabsTrigger value="system">System</TabsTrigger> : null}
        {toolCount ? (
          <TabsTrigger value="tools" count={toolCount}>
            Tools
          </TabsTrigger>
        ) : null}
      </TabsList>
      {system ? (
        <TabsContent value="system">
          <PromptSections
            sections={promptSectionsOf(String(system.payload.content ?? ""))}
            defaultOpen
          />
        </TabsContent>
      ) : null}
      {toolCount ? (
        <TabsContent value="tools">
          <OfferedTools groups={toolGroups} defaultOpen />
        </TabsContent>
      ) : null}
      <TabsContent value="conversation" className="flex flex-col gap-3">
        {latestError ? (
          <Banner
            tone="error"
            title={String(latestError.message ?? "The run failed")}
            meta={String(latestError.operation ?? "")}
          />
        ) : null}

        {segments.map((segment) =>
          segment.type === "flow" ? (
            <TranscriptFlow
              key={segment.key}
              agent={agent}
              run={run}
              flow={segment}
              progress={progress}
              reveal={reveal}
              onAskCall={onAskCall}
            />
          ) : (
            <TranscriptMessage key={Number(segment.msg.seq)} agent={agent} message={segment.msg} />
          ),
        )}

        <LiveReply agent={agent} live={live} generating={run.generating} />
      </TabsContent>
    </Tabs>
  );
}
