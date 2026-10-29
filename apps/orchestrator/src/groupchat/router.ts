import type { GroupMessageRow } from "../db/group-chat.js";
import type { RecipientRouting, TypeSafeUsage } from "../db/schema/index.js";

export type RecipientDecision = {
  source: "tags" | "typesafe" | "low_confidence" | "fallback";
  reason?: string;
  names: Set<string>;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  model?: string;
  usage?: TypeSafeUsage;
};

export type HistoryDecision = {
  source: "limit" | "typesafe" | "fallback";
  reason?: string;
  rows: GroupMessageRow[];
  keep?: Record<string, number>;
  model?: string;
  usage?: TypeSafeUsage;
};

/** What a group chat asks of its router: who a message wakes, and which history an agent reads. */
export type GroupRouter = {
  configured: boolean;
  recipients(args: {
    rows: Array<Record<string, unknown>>;
    members: Array<Record<string, unknown>>;
    pending: Array<Record<string, unknown>>;
    taggedNames?: Set<string>;
    ruleNames?: Set<string>;
  }): Promise<RecipientDecision>;
  history(args: {
    rows: GroupMessageRow[];
    agentName: string;
    agentFocus?: string;
  }): Promise<HistoryDecision>;
};

export function serializeRecipientDecision(decision: RecipientDecision): RecipientRouting {
  const payload: RecipientRouting = {
    source: decision.source,
    names: [...decision.names].sort(),
  };
  if (decision.reason) {
    payload.reason = decision.reason;
  }
  if (decision.choice) {
    payload.choice = decision.choice;
  }
  if (decision.confidence !== undefined) {
    payload.confidence = decision.confidence;
  }
  if (decision.probabilities) {
    payload.probabilities = decision.probabilities;
  }
  if (decision.model) {
    payload.model = decision.model;
  }
  if (decision.usage) {
    payload.usage = decision.usage;
  }
  return payload;
}
