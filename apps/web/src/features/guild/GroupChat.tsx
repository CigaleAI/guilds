import { ArrowDown, MessageSquare } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useGroupMessages,
  useMarkGroupChatRead,
  useOrgMembers,
  usePostGroupMessage,
} from "../../api/queries";
import type { Agent, GroupChatState, GroupMessage, Guild } from "../../api/types";
import { agentLook } from "../../app/agents";
import { isoTime, messageTime } from "../../app/format";
import { useIdentity } from "../../app/identity";
import {
  Button,
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

/** The guild's public conversation: agents post on paper, people in their own colour. */
export function GroupChat({ guild, agents, state, focusSeq }: GroupChatProps) {
  const { user, org } = useIdentity();
  const members = useOrgMembers(org.id);
  const messages = useGroupMessages(guild.id);
  const post = usePostGroupMessage(guild.id);
  const markRead = useMarkGroupChatRead(guild.id);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(focusSeq === undefined);
  const focused = useRef(false);
  const [away, setAway] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const agentByName = useMemo(() => new Map(agents.map((agent) => [agent.name, agent])), [agents]);
  const colorByName = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.name, member.color])),
    [members.data],
  );

  /** Where "New" goes: fixed when the chat opens, so reading does not move it. */
  const [firstUnseen, setFirstUnseen] = useState<number | null | undefined>(undefined);
  if (firstUnseen === undefined && state && messages.data) {
    const seen = state.seen_through_seq;
    const next =
      seen === null || seen === undefined ? null : messages.data.find((m) => m.seq > seen);
    setFirstUnseen(next ? next.seq : null);
  }

  const lastSeq = messages.data?.at(-1)?.seq;
  const seenThrough = state?.seen_through_seq ?? -1;
  const markPending = markRead.isPending;
  const mutateRead = markRead.mutate;
  const markIfRead = useCallback(() => {
    if (lastSeq === undefined || lastSeq <= seenThrough || markPending) return;
    if (!atBottom.current || document.visibilityState !== "visible") return;
    mutateRead(lastSeq);
  }, [lastSeq, seenThrough, markPending, mutateRead]);

  useEffect(() => {
    markIfRead();
    document.addEventListener("visibilitychange", markIfRead);
    return () => document.removeEventListener("visibilitychange", markIfRead);
  }, [markIfRead]);

  // Follow the conversation while the operator is at the end of it.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.data?.length, state?.dispatching, state?.active_agents.length]);

  // Opened at a message: bring it into view once, and count the chat read up to it.
  useLayoutEffect(() => {
    const el = log.current;
    if (focusSeq === undefined || focused.current || !el || !messages.data) return;
    const target = el.querySelector<HTMLElement>(`[data-seq="${focusSeq}"]`);
    if (!target) return;
    focused.current = true;
    el.scrollTop +=
      target.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3;
    if (focusSeq > seenThrough && !markPending) mutateRead(focusSeq);
  }, [focusSeq, messages.data, seenThrough, markPending, mutateRead]);

  const jumpToLatest = () => {
    const el = log.current;
    if (!el) return;
    atBottom.current = true;
    setAway(false);
    el.scrollTop = el.scrollHeight;
    markIfRead();
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
  const send = (content: string) => {
    if (waitsFor(content).length) {
      queueGroupMessage(guild.id, content);
      return;
    }
    atBottom.current = true;
    post.mutate(
      { content },
      {
        onError: (error) =>
          toast({ kind: "error", title: "Couldn't post to the guild", description: error.message }),
      },
    );
  };

  const latestError = state?.errors.at(-1);
  const errorKey = latestError ? `${latestError.at}-${latestError.agent_id}` : null;
  const responding = (state?.active_agents ?? []).flatMap((active) => {
    const agent = agentByName.get(active.name);
    return agent ? [agent] : [];
  });
  const waiting = Math.max(0, (state?.pending_agent_count ?? 0) - responding.length);

  const renderMessage = (message: GroupMessage) => (
    <div
      key={message.seq}
      data-seq={message.seq}
      className={cn(
        "flex flex-col rounded-2xl",
        message.seq === focusSeq && "ring-2 ring-signal",
        message.tagged_user_ids.includes(user.id) && "bg-t-sig p-1.5",
      )}
    >
      {renderBubble(message)}
    </div>
  );

  const renderBubble = (message: GroupMessage) => {
    const time = messageTime(message.created_at);
    const dateTime = isoTime(message.created_at);
    const body = (
      <Markdown density="compact" mentions={message.tagged}>
        {message.content}
      </Markdown>
    );
    if (message.author_type === "user") {
      const mine = message.author_name === user.name;
      return (
        <OperatorMessage
          key={message.seq}
          author={mine ? "You" : message.author_name}
          tone={personTone(mine ? user.color : colorByName.get(message.author_name))}
          time={time}
          dateTime={dateTime}
          seq={message.seq}
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
        key={message.seq}
        name={message.author_name}
        tone={look.tone}
        {...(look.src ? { src: look.src } : {})}
        time={time}
        dateTime={dateTime}
        bubble="surface"
        {...(agentId && runId ? { onInspectRun: () => openAgent(agentId, runId) } : {})}
        {...(agentId ? { onOpenAgent: () => openAgent(agentId) } : {})}
      >
        {body}
      </AgentMessage>
    );
  };

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
            {latestError && errorKey !== dismissedError ? (
              <Banner
                tone="error"
                title={`${agentById.get(latestError.agent_id)?.name ?? "An agent"} couldn't take its turn`}
                meta={latestError.error_type}
                onDismiss={() => setDismissedError(errorKey)}
              >
                {latestError.message}
              </Banner>
            ) : null}

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

            {responding.map((agent, index) => (
              <button
                key={agent.id}
                type="button"
                title={`Open ${agent.name}`}
                onClick={() => openAgent(agent.id)}
                className="cursor-pointer self-start rounded-2xl text-left"
              >
                <TypingIndicator
                  name={agent.name}
                  {...agentLook(agent)}
                  caption={`${agent.name} is responding…${index === responding.length - 1 && waiting > 0 ? ` ${waiting} more waiting` : ""}`}
                  bubble="surface"
                />
              </button>
            ))}
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
            {lastSeq !== undefined && lastSeq > seenThrough ? "New messages" : "Jump to latest"}
          </Button>
        ) : null}
      </div>
      <div className="px-4 pb-3 md:px-10 md:pb-6">
        <div className="mx-auto max-w-240">
          <GroupQueue guildId={guild.id} agents={agents} state={state} />
        </div>
        <Composer
          className="mx-auto max-w-240"
          variant="inline"
          tone="surface"
          label={`Message ${guild.name}`}
          placeholder="Message the guild — type @ to mention an agent"
          onSend={send}
          mentions={mentions}
        />
      </div>
    </div>
  );
}
