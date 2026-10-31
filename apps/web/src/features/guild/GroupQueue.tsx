import { useEffect, useMemo } from "react";
import { Clock, X, Zap } from "lucide-react";
import { usePostGroupMessage } from "../../api/queries/chat";
import type { Agent } from "../../api/types/agents";
import type { GroupChatState } from "../../api/types/chat";
import { Button, Icon, IconButton, Tooltip, toast } from "@guildsrun/ui";
import {
  blockingAgents,
  dropQueuedMessage,
  sendableHead,
  sendQueuedMessage,
  useQueuedMessages,
  type QueuedMessage,
} from "./messageQueue";

/** For a message's text, the agents in a group run it would wait for. */
export function useWaitsFor(
  agents: readonly Agent[],
  state: GroupChatState | undefined,
): (content: string) => string[] {
  const activeAgents = state?.active_agents;
  return useMemo(() => {
    const names = new Set(agents.map((agent) => agent.name));
    const active = (activeAgents ?? []).map((agent) => agent.name);
    return (content: string) => blockingAgents(content, names, active);
  }, [agents, activeAgents]);
}

/** Sends a queued message through `post`, and tells the operator when it could not go. */
function sendQueued(
  guildId: string,
  message: QueuedMessage,
  post: (content: string) => Promise<unknown>,
): void {
  void sendQueuedMessage(guildId, message, post).then((error) => {
    if (error) {
      toast({ kind: "error", title: "Couldn't send a queued message", description: error.message });
    }
  });
}

/**
 * Sends the guild's queued messages, oldest first, once the agents each one waits for are out of
 * their runs. It runs while any page of the guild is open.
 */
export function useSendQueuedMessages(
  guildId: string,
  agents: readonly Agent[],
  state: GroupChatState | undefined,
): void {
  const queue = useQueuedMessages(guildId);
  const { mutateAsync } = usePostGroupMessage(guildId);
  const waitsFor = useWaitsFor(agents, state);
  useEffect(() => {
    if (!state || queue.some((message) => message.status === "sending")) return;
    const next = sendableHead(queue, waitsFor)[0];
    if (next) sendQueued(guildId, next, (content) => mutateAsync({ content }));
  }, [guildId, queue, state, waitsFor, mutateAsync]);
}

function queuedNote(message: QueuedMessage, waiting: readonly string[]): string {
  if (message.status === "failed") return "Couldn't send";
  if (message.status === "sending" || !waiting.length) return "Sending…";
  return `Waits for ${waiting.join(", ")}`;
}

type GroupQueueProps = {
  guildId: string;
  agents: readonly Agent[];
  state: GroupChatState | undefined;
};

/** The operator's messages waiting for agents to finish, each with Send now and Delete. */
export function GroupQueue({ guildId, agents, state }: GroupQueueProps) {
  const queue = useQueuedMessages(guildId);
  const { mutateAsync } = usePostGroupMessage(guildId);
  const waitsFor = useWaitsFor(agents, state);
  if (!queue.length) return null;
  return (
    <ul aria-label="Queued messages" className="mb-2 flex flex-col gap-1.5">
      {queue.map((message) => {
        const sending = message.status === "sending";
        return (
          <li
            key={message.id}
            className="flex items-start gap-2 rounded-xl bg-well px-3 py-2 text-sm"
          >
            <Icon icon={Clock} size={14} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="type-label text-muted">
                Queued · {queuedNote(message, waitsFor(message.content))}
              </p>
              <p className="line-clamp-2 break-words whitespace-pre-wrap">{message.content}</p>
            </div>
            <Tooltip label="Stop the runs it waits for and send it now">
              <Button
                variant="ghost"
                size="xs"
                disabled={sending}
                onClick={() =>
                  sendQueued(guildId, message, (content) =>
                    mutateAsync({ content, interrupt: true }),
                  )
                }
              >
                <Icon icon={Zap} size={14} />
                Send now
              </Button>
            </Tooltip>
            <IconButton
              icon={X}
              label="Delete queued message"
              variant="ghost"
              size={24}
              disabled={sending}
              onClick={() => dropQueuedMessage(guildId, message.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}
