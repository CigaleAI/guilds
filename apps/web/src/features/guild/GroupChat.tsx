import { ArrowDown, MessageSquare, Reply, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  useGroupMessages,
  useMarkGroupChatRead,
  usePostGroupMessage,
} from "../../api/queries/chat";
import { useOrgMembers } from "../../api/queries/org";
import type { Guild } from "../../api/types/guilds";
import type { Agent } from "../../api/types/agents";
import type { GroupChatState, GroupMessage } from "../../api/types/chat";
import { agentLook } from "../../app/agents";
import { isoTime, messageTime } from "../../app/format";
import { useIdentity } from "../../app/identity";
import {
  Button,
  IconButton,
  Markdown,
  Composer,
  AgentMessage,
  OperatorMessage,
  TypingIndicator,
  Banner,
  EmptyState,
  SkeletonRows,
  toast,
  isHandle,
  LabelledDivider,
  Icon,
  cn,
  personTone,
  type SendOutcome,
} from "@guildsrun/ui";
import type { MentionCandidate } from "@guildsrun/ui";
import { GroupQueue, useWaitsFor } from "./GroupQueue";
import { queueGroupMessage } from "./messageQueue";

type GroupChatProps = {
  guild: Guild;
  agents: readonly Agent[];
  state: GroupChatState | undefined;
  /** A message to open the chat at, lit, such as the one that tagged the operator. */
  focusSeq?: number;
};

/** How close to the end the log must be to count as "at the bottom". */
const bottomSlack = 48;

function messageAuthorLabel(message: GroupMessage, viewerName: string): string {
  if (message.author_type === "user" && message.author_name === viewerName) {
    return "You";
  }
  return message.author_name;
}

type ReplyQuoteProps = {
  seq: number;
  target: GroupMessage | undefined;
  viewerName: string;
  onSelect: (seq: number) => void;
};

/** Compact quote of the earlier message a post replies to; clicking it jumps to that message. */
function ReplyQuote({ seq, target, viewerName, onSelect }: ReplyQuoteProps) {
  const label = target ? `${messageAuthorLabel(target, viewerName)} · seq ${seq}` : `seq ${seq}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(seq)}
      title={`Jump to message ${seq}`}
      className="flex max-w-full cursor-pointer items-center gap-2 rounded-lg bg-well/80 px-2.5 py-1.5 text-left text-xs text-fg-2 hover:bg-well"
    >
      <Icon icon={Reply} size={14} className="shrink-0 text-muted" />
      <span className="shrink-0 font-mono font-medium text-fg">{label}</span>
      {target ? <span className="truncate text-muted">{target.content}</span> : null}
    </button>
  );
}

type ReplyBannerProps = {
  target: GroupMessage;
  viewerName: string;
  onCancel: () => void;
};

/** The message pinned above the composer while the operator writes a reply to it. */
function ReplyBanner({ target, viewerName, onCancel }: ReplyBannerProps) {
  const author = messageAuthorLabel(target, viewerName);
  return (
    <div className="mb-2 flex items-start gap-2 rounded-xl bg-well px-3 py-2 text-sm">
      <Icon icon={Reply} size={14} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="type-label text-muted">
          Replying to {author} · seq {target.seq}
        </p>
        <p className="line-clamp-1 break-words text-fg-2">{target.content}</p>
      </div>
      <IconButton
        icon={X}
        label="Cancel reply"
        variant="ghost"
        size={24}
        onClick={onCancel}
      />
    </div>
  );
}

type GroupChatReadMarker = {
  /** Marks the chat read through its latest message while the operator is at its visible end. */
  markIfRead: () => void;
  /** Marks the chat read through a message, unless it already is. */
  markReadThrough: (seq: number) => void;
  /** Whether messages past the read marker have arrived. */
  unread: boolean;
};

/**
 * Moves the guild's read marker: through the latest message whenever the operator is at the end
 * of a visible chat, including when the page becomes visible again.
 */
function useGroupChatRead(
  guildId: string,
  messages: readonly GroupMessage[] | undefined,
  state: GroupChatState | undefined,
  atBottom: RefObject<boolean>,
): GroupChatReadMarker {
  const markRead = useMarkGroupChatRead(guildId);
  const lastSeq = messages?.at(-1)?.seq;
  const seenThrough = state?.seen_through_seq ?? -1;
  const markPending = markRead.isPending;
  const mutateRead = markRead.mutate;
  const markReadThrough = useCallback(
    (seq: number) => {
      if (seq > seenThrough && !markPending) mutateRead(seq);
    },
    [seenThrough, markPending, mutateRead],
  );
  const markIfRead = useCallback(() => {
    if (lastSeq === undefined || !atBottom.current || document.visibilityState !== "visible")
      return;
    markReadThrough(lastSeq);
  }, [lastSeq, atBottom, markReadThrough]);

  useEffect(() => {
    markIfRead();
    document.addEventListener("visibilitychange", markIfRead);
    return () => document.removeEventListener("visibilitychange", markIfRead);
  }, [markIfRead]);

  return { markIfRead, markReadThrough, unread: lastSeq !== undefined && lastSeq > seenThrough };
}

/**
 * Where the "New" divider goes: the first message past the read marker as the chat opened, fixed
 * then so reading does not move it; null when none is past it, undefined until both have loaded.
 */
function useFirstUnseenSeq(
  messages: readonly GroupMessage[] | undefined,
  state: GroupChatState | undefined,
): number | null | undefined {
  const [firstUnseen, setFirstUnseen] = useState<number | null | undefined>(undefined);
  if (firstUnseen === undefined && state && messages) {
    const seen = state.seen_through_seq;
    const next = seen === null || seen === undefined ? null : messages.find((m) => m.seq > seen);
    setFirstUnseen(next ? next.seq : null);
  }
  return firstUnseen;
}

type TurnErrorBannerProps = {
  state: GroupChatState | undefined;
  agentById: ReadonlyMap<string, Agent>;
};

/** The latest agent turn that failed, until the operator dismisses it. */
function TurnErrorBanner({ state, agentById }: TurnErrorBannerProps) {
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const latestError = state?.errors.at(-1);
  if (!latestError) return null;
  const errorKey = `${latestError.at}-${latestError.agent_id}`;
  if (errorKey === dismissedError) return null;
  return (
    <Banner
      tone="error"
      title={`${agentById.get(latestError.agent_id)?.name ?? "An agent"} couldn't take its turn`}
      meta={latestError.error_type}
      onDismiss={() => setDismissedError(errorKey)}
    >
      {latestError.message}
    </Banner>
  );
}

type RespondingAgentsProps = {
  agents: readonly Agent[];
  state: GroupChatState | undefined;
  onOpenAgent: (agentId: string) => void;
};

/** The agents taking their turn now, the last one saying how many more wait for theirs. */
function RespondingAgents({ agents, state, onOpenAgent }: RespondingAgentsProps) {
  const agentByName = useMemo(() => new Map(agents.map((agent) => [agent.name, agent])), [agents]);
  const responding = (state?.active_agents ?? []).flatMap((active) => {
    const agent = agentByName.get(active.name);
    return agent ? [agent] : [];
  });
  const waiting = Math.max(0, (state?.pending_agent_count ?? 0) - responding.length);
  return responding.map((agent, index) => (
    <button
      key={agent.id}
      type="button"
      title={`Open ${agent.name}`}
      onClick={() => onOpenAgent(agent.id)}
      className="cursor-pointer self-start rounded-2xl text-left"
    >
      <TypingIndicator
        name={agent.name}
        {...agentLook(agent)}
        caption={`${agent.name} is responding…${index === responding.length - 1 && waiting > 0 ? ` ${waiting} more waiting` : ""}`}
        bubble="surface"
      />
    </button>
  ));
}

function scrollLogToSeq(el: HTMLDivElement | null, seq: number): boolean {
  if (!el) return false;
  const target = el.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
  if (!target) return false;
  el.scrollTop +=
    target.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3;
  return true;
}

type MessageBubbleProps = {
  message: GroupMessage;
  replied: GroupMessage | undefined;
  viewer: { id: string; name: string; color?: string | null };
  agentById: ReadonlyMap<string, Agent>;
  colorByName: ReadonlyMap<string, string | null | undefined>;
  onOpenAgent: (agentId: string, runId?: string) => void;
  onStartReply: (seq: number) => void;
  onJumpToSeq: (seq: number) => void;
};

function MessageBubble({
  message,
  replied,
  viewer,
  agentById,
  colorByName,
  onOpenAgent,
  onStartReply,
  onJumpToSeq,
}: MessageBubbleProps) {
  const time = messageTime(message.created_at);
  const dateTime = isoTime(message.created_at);
  const quote =
    message.reply_to_seq !== null ? (
      <ReplyQuote
        seq={message.reply_to_seq}
        target={replied}
        viewerName={viewer.name}
        onSelect={onJumpToSeq}
      />
    ) : undefined;
  const body = (
    <Markdown density="compact" mentions={message.tagged}>
      {message.content}
    </Markdown>
  );
  if (message.author_type === "user") {
    const mine = message.author_name === viewer.name;
    return (
      <OperatorMessage
        author={mine ? "You" : message.author_name}
        tone={personTone(mine ? viewer.color : colorByName.get(message.author_name))}
        time={time}
        dateTime={dateTime}
        seq={message.seq}
        onReply={() => onStartReply(message.seq)}
        {...(quote ? { replyTo: quote } : {})}
      >
        {body}
      </OperatorMessage>
    );
  }
  const agent = message.author_agent_id ? agentById.get(message.author_agent_id) : undefined;
  const look = agent ? agentLook(agent) : { tone: "dusk" as const };
  const agentId = message.author_agent_id;
  const runId = message.source_run_id;
  return (
    <AgentMessage
      name={message.author_name}
      tone={look.tone}
      {...(look.src ? { src: look.src } : {})}
      time={time}
      dateTime={dateTime}
      seq={message.seq}
      bubble="surface"
      onReply={() => onStartReply(message.seq)}
      {...(quote ? { replyTo: quote } : {})}
      {...(agentId && runId ? { onInspectRun: () => onOpenAgent(agentId, runId) } : {})}
      {...(agentId ? { onOpenAgent: () => onOpenAgent(agentId) } : {})}
    >
      {body}
    </AgentMessage>
  );
}

/** The guild's public conversation: agents post on paper, people in their own colour. */
export function GroupChat({ guild, agents, state, focusSeq }: GroupChatProps) {
  const { user, org } = useIdentity();
  const members = useOrgMembers(org.id);
  const messages = useGroupMessages(guild.id);
  const post = usePostGroupMessage(guild.id);
  const log = useRef<HTMLDivElement>(null);
  const composerArea = useRef<HTMLDivElement>(null);
  const atBottom = useRef(focusSeq === undefined);
  const focused = useRef(false);
  const [away, setAway] = useState(false);
  const [replyState, setReplyState] = useState<{ guildId: string; seq: number } | null>(null);
  const [jumpedSeq, setJumpedSeq] = useState<number | null>(null);
  const { markIfRead, markReadThrough, unread } = useGroupChatRead(
    guild.id,
    messages.data,
    state,
    atBottom,
  );
  const firstUnseen = useFirstUnseenSeq(messages.data, state);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const messageBySeq = useMemo(
    () => new Map((messages.data ?? []).map((item) => [item.seq, item])),
    [messages.data],
  );
  const colorByName = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.name, member.color])),
    [members.data],
  );
  const replyTarget =
    replyState && replyState.guildId === guild.id
      ? (messageBySeq.get(replyState.seq) ?? null)
      : null;
  const litSeq = jumpedSeq ?? focusSeq;

  // Follow the conversation while the operator is at the end of it.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.data?.length, state?.dispatching, state?.active_agents.length]);

  // Opened at a message: bring it into view once, and count the chat read up to it.
  useLayoutEffect(() => {
    if (focusSeq === undefined || focused.current || !messages.data) return;
    if (!scrollLogToSeq(log.current, focusSeq)) return;
    focused.current = true;
    markReadThrough(focusSeq);
  }, [focusSeq, messages.data, markReadThrough]);

  const jumpToLatest = () => {
    const el = log.current;
    if (!el) return;
    atBottom.current = true;
    setAway(false);
    el.scrollTop = el.scrollHeight;
    markIfRead();
  };

  const jumpToSeq = (seq: number) => {
    if (!scrollLogToSeq(log.current, seq)) return;
    setJumpedSeq(seq);
  };

  const startReply = (seq: number) => {
    setReplyState({ guildId: guild.id, seq });
    requestAnimationFrame(() => {
      composerArea.current?.querySelector("textarea")?.focus();
    });
  };

  const mentions = useMemo<MentionCandidate[]>(() => {
    const candidates: MentionCandidate[] = agents.map((agent) => {
      const look = agentLook(agent);
      return { name: agent.name, tone: look.tone, ...(look.src ? { src: look.src } : {}) };
    });
    for (const operator of guild.operators) {
      if (operator.user_id !== user.id && isHandle(operator.name))
        candidates.push({ name: operator.name, hint: "operator" });
    }
    candidates.push({ name: "user", hint: "every operator" });
    return candidates;
  }, [agents, guild.operators, user.id]);

  const navigate = useNavigate();
  const openAgent = (agentId: string, run?: string) =>
    void navigate({
      to: "/guilds/$guildId/agents/$agentId",
      params: { guildId: guild.id, agentId },
      search: run ? { run } : {},
    });

  const waitsFor = useWaitsFor(agents, state);
  /** Holds the message back while an agent it targets is in a group run; sends it otherwise. */
  const send = (content: string): Promise<SendOutcome> => {
    const target = replyTarget;
    setReplyState(null);
    const replyAgent =
      target?.author_type === "agent" && target.author_agent_id && agentById.has(target.author_agent_id)
        ? target.author_name
        : undefined;
    if (waitsFor(content, replyAgent).length) {
      queueGroupMessage(
        guild.id,
        content,
        target ? { seq: target.seq, ...(replyAgent ? { agentName: replyAgent } : {}) } : undefined,
      );
      return Promise.resolve("delivered");
    }
    atBottom.current = true;
    return post.mutateAsync({ content, ...(target ? { reply_to_seq: target.seq } : {}) }).then(
      (): SendOutcome => "delivered",
      (error: Error): SendOutcome => {
        toast({ kind: "error", title: "Couldn't post to the guild", description: error.message });
        return "failed";
      },
    );
  };

  const renderMessage = (message: GroupMessage) => (
    <div
      key={message.seq}
      data-seq={message.seq}
      className={cn(
        "flex flex-col rounded-2xl",
        message.seq === litSeq && "ring-2 ring-signal",
        message.tagged_user_ids.includes(user.id) && "bg-t-sig p-1.5",
      )}
    >
      <MessageBubble
        message={message}
        replied={message.reply_to_seq !== null ? messageBySeq.get(message.reply_to_seq) : undefined}
        viewer={user}
        agentById={agentById}
        colorByName={colorByName}
        onOpenAgent={openAgent}
        onStartReply={startReply}
        onJumpToSeq={jumpToSeq}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={log}
          role="log"
          aria-label={`${guild.name} group chat`}
          aria-live="polite"
          onScroll={(event) => {
            const el = event.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < bottomSlack;
            if (away === atBottom.current) setAway(!atBottom.current);
            markIfRead();
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-10 md:py-6"
        >
          <div className="mx-auto flex max-w-240 flex-col gap-5">
            {state?.limit_reached ? (
              <Banner
                tone="warning"
                title={`Agents paused after ${state.agent_message_limit} messages in a row`}
                meta={`${state.agent_message_count} agent messages since an operator last posted`}
              >
                Post a message to let them continue.
              </Banner>
            ) : null}
            <TurnErrorBanner state={state} agentById={agentById} />

            {messages.isPending ? (
              <SkeletonRows rows={5} label="Loading messages" />
            ) : messages.isError ? (
              <Banner
                tone="error"
                title="Couldn't load the conversation"
                meta={messages.error.message}
                action={
                  <Button variant="outline" size="sm" onClick={() => void messages.refetch()}>
                    Retry
                  </Button>
                }
              />
            ) : messages.data.length === 0 ? (
              <EmptyState
                icon={MessageSquare}
                title="No messages yet"
                description="Post to the guild. Tag an agent with @ to wake it."
              />
            ) : (
              messages.data.map((message) =>
                message.seq === firstUnseen ? (
                  <div key={message.seq} className="flex flex-col gap-5">
                    <LabelledDivider label="New" />
                    {renderMessage(message)}
                  </div>
                ) : (
                  renderMessage(message)
                ),
              )
            )}

            <RespondingAgents agents={agents} state={state} onOpenAgent={openAgent} />
          </div>
        </div>
        {away ? (
          <Button
            variant="secondary"
            size="sm"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-pop"
            onClick={jumpToLatest}
          >
            <Icon icon={ArrowDown} size={14} />
            {unread ? "New messages" : "Jump to latest"}
          </Button>
        ) : null}
      </div>
      <div
        ref={composerArea}
        onKeyDown={(event) => {
          if (!event.defaultPrevented && event.key === "Escape" && replyTarget) {
            setReplyState(null);
          }
        }}
        className="px-4 pb-3 md:px-10 md:pb-6"
      >
        <div className="mx-auto max-w-240">
          <GroupQueue guildId={guild.id} agents={agents} state={state} />
          {replyTarget ? (
            <ReplyBanner
              target={replyTarget}
              viewerName={user.name}
              onCancel={() => setReplyState(null)}
            />
          ) : null}
        </div>
        <Composer
          className="mx-auto max-w-240"
          variant="inline"
          tone="surface"
          label={`Message ${guild.name}`}
          placeholder={
            replyTarget
              ? `Reply to ${messageAuthorLabel(replyTarget, user.name)} — type @ to mention an agent`
              : "Message the guild — type @ to mention an agent"
          }
          onSend={send}
          mentions={mentions}
        />
      </div>
    </div>
  );
}
