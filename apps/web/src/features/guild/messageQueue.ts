import { useCallback, useSyncExternalStore } from "react";
import { MENTION_PATTERN } from "@guildsrun/ui";

/** A group-chat message held in this browser until the agents it targets finish their runs. */
export type QueuedMessage = {
  id: string;
  content: string;
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
export function queueGroupMessage(guildId: string, content: string): QueuedMessage {
  nextId += 1;
  const message = { id: `q_${nextId}`, content };
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
 * The agents in a group run that a message would wait for: the ones it tags, or every one when it
 * tags no agent. A message that waits for nobody is sent at once.
 */
export function blockingAgents(
  content: string,
  agentNames: ReadonlySet<string>,
  activeNames: readonly string[],
): string[] {
  const tagged = taggedAgentNames(content, agentNames);
  if (!tagged.length) return [...activeNames];
  return activeNames.filter((name) => tagged.includes(name));
}

/**
 * The queued messages that can go now: the oldest ones, up to the first that still waits, is
 * being sent, or failed.
 */
export function sendableHead(
  queue: readonly QueuedMessage[],
  waitsFor: (content: string) => readonly string[],
): QueuedMessage[] {
  const end = queue.findIndex(
    (message) => message.status !== undefined || waitsFor(message.content).length > 0,
  );
  return queue.slice(0, end === -1 ? queue.length : end);
}
