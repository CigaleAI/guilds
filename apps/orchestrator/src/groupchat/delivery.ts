import type { PendingGroupAgentRow } from "../db/group-chat.js";
import type { RecipientRouting } from "../db/schema/index.js";

export class DeliveryCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryCreateError";
  }
}

export class DeliveryBusyError extends Error {
  constructor(message = "busy") {
    super(message);
    this.name = "DeliveryBusyError";
  }
}

/** One group run to start: the agent, the snapshot it sees, and why it was picked. */
export type GroupDelivery = {
  agentId: string;
  throughSeq: number;
  deliveredThrough: number;
  recipients: RecipientRouting | null;
};

export type GroupRunner = {
  isAgentBusy(agentId: string): boolean;
  waitForLockRelease(seen: number): Promise<void>;
  deliverGroupRun(delivery: GroupDelivery): Promise<void>;
  /** Stops the run the agent is generating, if any. */
  cancelAgentRuns(agentId: string): Promise<void>;
  lockGeneration: number;
};

/** A group run under way: its agent and the snapshot it was given. */
export type ActiveDelivery = {
  id: string;
  name: string;
  throughSeq: number;
  task?: Promise<void>;
};

/** A pending agent as the dispatcher reads it: who it is, and how far it has seen the chat. */
export type PendingAgent = Pick<PendingGroupAgentRow, "id" | "name" | "group_chat_delivered_through">;

/**
 * Pending agents as the dispatcher sees them: an agent in a group run has seen the chat through
 * that run's snapshot, so it is pending only for what came after.
 */
export function withActiveCursors<T extends PendingAgent>(
  pending: T[],
  active: ReadonlyMap<string, ActiveDelivery>,
  snapshot: number,
): T[] {
  return pending
    .map((agent) => {
      const delivery = active.get(agent.id);
      if (delivery === undefined) {
        return agent;
      }
      return { ...agent, group_chat_delivered_through: Math.max(agent.group_chat_delivered_through, delivery.throughSeq) };
    })
    .filter((agent) => agent.group_chat_delivered_through < snapshot);
}

/**
 * Which picked agents start a run now. A tagged agent starts as soon as it is free, alongside
 * other group runs. An agent picked without a tag runs alone: it starts only when no other group
 * run is under way or starting.
 */
export function deliveriesToStart<T extends Pick<PendingAgent, "id" | "name">>(args: {
  actionable: T[];
  tagged: ReadonlySet<string>;
  active: ReadonlyMap<string, ActiveDelivery>;
  isBusy: (agentId: string) => boolean;
}): { start: T[]; waitsForRelease: boolean } {
  const waiting = args.actionable.filter((agent) => !args.active.has(agent.id));
  const idle = waiting.filter((agent) => !args.isBusy(agent.id));
  const start = idle.filter((agent) => args.tagged.has(agent.name));
  const untagged = idle.find((agent) => !args.tagged.has(agent.name));
  if (untagged && args.active.size + start.length === 0) {
    start.push(untagged);
  }
  return { start, waitsForRelease: idle.length < waiting.length };
}

/** The group runs an interrupting post stops: the tagged agents' runs, or every run when untagged. */
export function interruptTargets(activeAgentIds: string[], taggedAgentIds: string[]): string[] {
  if (!taggedAgentIds.length) {
    return activeAgentIds;
  }
  return activeAgentIds.filter((agentId) => taggedAgentIds.includes(agentId));
}
