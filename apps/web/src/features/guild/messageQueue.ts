import { useCallback, useSyncExternalStore } from "react";
import { MENTION_PATTERN } from "@guildsrun/ui";

/** The message a reply answers: its sequence number and, when a member agent wrote it, that agent's handle. */
export type ReplyTarget = {
  seq: number;
  agentName?: string;
};

/** A group-chat message held in this browser until the agents it targets finish their runs. */
export type QueuedMessage = {
  id: string;
  content: string;
  replyToSeq?: number;
  replyToAgentName?: string;
  /** `sending` while a post is under way; `failed` waits for the operator to send or delete it. */
  status?: "sending" | "failed";
};

const EMPTY: readonly QueuedMessage[] = [];
const queues = new Map<string, readonly QueuedMessage[]>();
const listeners = new Set<() => void>();
let nextId = 0;

function setQueue(guildId: string, queue: readonly QueuedMessage[]): void {
  if (queue.length) queues.set(guildId, queue);
  else queues.delete(guildId);
  for (const listener of listeners) listener();
}

/** The guild's queued messages, oldest first. */
export function queuedMessages(guildId: string): readonly QueuedMessage[] {
  return queues.get(guildId) ?? EMPTY;
}

/** Adds a message to the end of the guild's queue. */
export function queueGroupMessage(
  guildId: string,
  content: string,
  reply?: ReplyTarget,
): QueuedMessage {
  nextId += 1;
  const message: QueuedMessage = {
    id: `q_${nextId}`,
    content,
    ...(reply ? { replyToSeq: reply.seq } : {}),
    ...(reply?.agentName ? { replyToAgentName: reply.agentName } : {}),
  };
  setQueue(guildId, [...queuedMessages(guildId), message]);
  return message;
}

/** Removes a queued message: it was sent or deleted. */
export function dropQueuedMessage(guildId: string, id: string): void {
  setQueue(
    guildId,
    queuedMessages(guildId).filter((message) => message.id !== id),
  );
}

/** Marks a queued message as being sent, or as failed so it no longer sends on its own. */
export function markQueuedMessage(
  guildId: string,
  id: string,
  status: NonNullable<QueuedMessage["status"]>,
): void {
  setQueue(
    guildId,
    queuedMessages(guildId).map((message) =>
      message.id === id ? { ...message, status } : message,
    ),
  );
}

/**
 * Sends a queued message through `post`: drops it once posted, or marks it failed so it waits for
 * the operator. Resolves to the error the post failed with, or null once the message is sent.
 */
export function sendQueuedMessage(
  guildId: string,
  message: QueuedMessage,
  post: (message: QueuedMessage) => Promise<unknown>,
): Promise<Error | null> {
  markQueuedMessage(guildId, message.id, "sending");
  return post(message)
    .then(() => {
      dropQueuedMessage(guildId, message.id);
      return null;
    })
    .catch((error: Error) => {
      markQueuedMessage(guildId, message.id, "failed");
      return error;
    });
}

/** The guild's queued messages, re-rendering when they change. */
export function useQueuedMessages(guildId: string): readonly QueuedMessage[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return useSyncExternalStore(subscribe, () => queuedMessages(guildId));
}

/** The member agents a message tags, as the orchestrator reads them. */
export function taggedAgentNames(content: string, agentNames: ReadonlySet<string>): string[] {
  const tagged = new Set<string>();
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const name = match[1] ?? "";
    if (agentNames.has(name)) tagged.add(name);
  }
  return [...tagged];
}

/**
 * The agents in a group run that a message would wait for: the ones it tags, else the replied-to
 * agent when replying to one, else every running agent. A message that waits for nobody is sent at once.
 */
export function blockingAgents(
  content: string,
  agentNames: ReadonlySet<string>,
  activeNames: readonly string[],
  replyToAgentName?: string,
): string[] {
  const tagged = taggedAgentNames(content, agentNames);
  if (tagged.length) return activeNames.filter((name) => tagged.includes(name));
  if (replyToAgentName && agentNames.has(replyToAgentName)) {
    return activeNames.filter((name) => name === replyToAgentName);
  }
  return [...activeNames];
}

/**
 * The queued messages that can go now: the oldest ones, up to the first that still waits, is
 * being sent, or failed.
 */
export function sendableHead(
  queue: readonly QueuedMessage[],
  waitsFor: (message: QueuedMessage) => readonly string[],
): QueuedMessage[] {
  const end = queue.findIndex(
    (message) => message.status !== undefined || waitsFor(message).length > 0,
  );
  return queue.slice(0, end === -1 ? queue.length : end);
}
