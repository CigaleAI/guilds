/**
 * The events each stream follows, by name, with the guard an event's payload passes before its
 * handler reads it. A handler is given only a payload that passed; any other payload is ignored.
 */

import type { AgentBrief, AgentChange } from "./types/agents";
import type { DeliveryError, GroupChatState, GroupMessage, MessageNotice } from "./types/chat";
import type { IssueNotice, IssueSeverity } from "./types/issues";
import type {
  LiveDelta,
  MessagePayload,
  RunContinuation,
  RunMessage,
  RunWakeChange,
  ToolCall,
  ToolProgressEvent,
} from "./types/runs";
import type {
  ConversationMessageMetadata,
  SessionFailure,
  StudioMessage,
  StudioMessageCommit,
} from "./types/studio";
import {
  hasFields,
  isBoolean,
  isListOf,
  isNumber,
  isNumberOrNull,
  isJsonObject,
  isString,
  isStringList,
  isStringOrNull,
  isPendingWake,
  isStudioFocus,
  type JsonValue,
} from "./wire";

/** A check that an event's payload has the shape its handler reads. */
export type PayloadGuard<T> = (data: unknown) => data is T;

/** The guard of each event a stream follows; `P` names each event's payload. */
export type PayloadGuards<P> = { [E in keyof P]: PayloadGuard<P[E]> };

/** The handler of each event a stream follows, given the payload its guard admitted. */
export type LiveEventHandlers<P> = { [E in keyof P]: (payload: P[E]) => void };

function isEventOf<P>(guards: PayloadGuards<P>, name: string): name is Extract<keyof P, string> {
  return Object.hasOwn(guards, name);
}

/**
 * Hands an event's payload to its handler once the payload passes the event's guard. An event the
 * table does not name, and a payload that fails its guard, are ignored.
 */
export function dispatchLiveEvent<P>(
  guards: PayloadGuards<P>,
  handlers: LiveEventHandlers<P>,
  name: string,
  data: JsonValue | undefined,
): void {
  if (!isEventOf(guards, name)) return;
  const guard = guards[name];
  if (guard(data)) handlers[name](data);
}

/** Admits every payload: the handler reads nothing from it, or narrows it with its own reader. */
export function isAnyPayload(_data: unknown): _data is unknown {
  return true;
}

function isAuthorType(value: unknown): value is GroupMessage["author_type"] {
  return value === "user" || value === "agent";
}

function isAgentBrief(value: unknown): value is AgentBrief {
  return (
    isJsonObject(value) &&
    hasFields(value, ["id", "name", "avatar_shape", "avatar_color"], isString)
  );
}

function isActiveAgent(value: unknown): value is GroupChatState["active_agents"][number] {
  return isJsonObject(value) && hasFields(value, ["id", "name"], isString);
}

function isDeliveryError(value: unknown): value is DeliveryError {
  return (
    isJsonObject(value) &&
    value.operation === "group.delivery" &&
    hasFields(value, ["at", "agent_id", "error_type", "message"], isString)
  );
}

export function isGroupMessage(data: unknown): data is GroupMessage {
  return (
    isJsonObject(data) &&
    hasFields(data, ["id", "seq"], isNumber) &&
    isAuthorType(data.author_type) &&
    hasFields(data, ["author_name", "content", "created_at"], isString) &&
    hasFields(data, ["author_agent_id", "source_run_id"], isStringOrNull) &&
    hasFields(data, ["tagged", "tagged_agent_ids", "tagged_user_ids"], isStringList)
  );
}

export function isGroupChatState(data: unknown): data is GroupChatState {
  return (
    isJsonObject(data) &&
    isString(data.guild_id) &&
    hasFields(
      data,
      ["chat_seq", "agent_message_count", "agent_message_limit", "pending_agent_count"],
      isNumber,
    ) &&
    hasFields(data, ["dispatching", "limit_reached"], isBoolean) &&
    isListOf(data.active_agents, isActiveAgent) &&
    isListOf(data.errors, isDeliveryError) &&
    (data.seen_through_seq === undefined || isNumberOrNull(data.seen_through_seq))
  );
}

export function isAgentChange(data: unknown): data is AgentChange {
  return isJsonObject(data) && isString(data.agent_id);
}

export function isMessageNotice(data: unknown): data is MessageNotice {
  return (
    isJsonObject(data) &&
    isNumber(data.seq) &&
    isAuthorType(data.author_type) &&
    hasFields(data, ["guild_id", "author_name", "preview"], isString) &&
    (data.agent === null || isAgentBrief(data.agent))
  );
}

function isIssueSeverity(value: unknown): value is IssueSeverity {
  return value === "low" || value === "medium" || value === "high" || value === "blocking";
}

export function isIssueNotice(data: unknown): data is IssueNotice {
  return (
    isJsonObject(data) &&
    hasFields(data, ["id", "guild_id", "guild_name", "summary", "agent_name"], isString) &&
    isIssueSeverity(data.severity) &&
    (data.agent === null || isAgentBrief(data.agent))
  );
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isJsonObject(value) &&
    hasFields(value, ["id", "type"], isString) &&
    isJsonObject(value.function) &&
    hasFields(value.function, ["name", "arguments"], isString)
  );
}

/** Whether a value is a stored message: a system, user, assistant or tool message with its text. */
function isMessagePayload(value: unknown): value is MessagePayload {
  if (!isJsonObject(value) || !isString(value.content)) return false;
  if (value.role === "system" || value.role === "user") return true;
  if (value.role === "tool") return isString(value.tool_call_id);
  return (
    value.role === "assistant" &&
    (value.tool_calls === undefined || isListOf(value.tool_calls, isToolCall))
  );
}

export function isRunMessage(data: unknown): data is RunMessage {
  return (
    isJsonObject(data) &&
    hasFields(data, ["id", "seq"], isNumber) &&
    isMessagePayload(data.payload) &&
    isJsonObject(data.metadata) &&
    isString(data.created_at) &&
    isNumberOrNull(data.cost_usd)
  );
}

export function isLiveDelta(data: unknown): data is LiveDelta {
  return (
    isJsonObject(data) &&
    isString(data.text) &&
    (data.content === undefined || isString(data.content))
  );
}

export function isToolProgressEvent(data: unknown): data is ToolProgressEvent {
  return (
    isJsonObject(data) &&
    hasFields(data, ["run_id", "tool_call_id"], isString) &&
    isStringList(data.lines) &&
    (data.session_id === undefined || isStringOrNull(data.session_id))
  );
}

export function isRunContinuation(data: unknown): data is RunContinuation {
  return isJsonObject(data) && isString(data.run_id);
}

export function isRunWakeChange(data: unknown): data is RunWakeChange {
  return isJsonObject(data) && (data.pending_wake === null || isPendingWake(data.pending_wake));
}

/** Whether a value is a coach message's metadata: a JSON object, its focus, when it has one, whole. */
function isConversationMessageMetadata(value: unknown): value is ConversationMessageMetadata {
  return isJsonObject(value) && (value.focus === undefined || isStudioFocus(value.focus));
}

function isStudioMessage(value: unknown): value is StudioMessage {
  return (
    isJsonObject(value) &&
    hasFields(value, ["id", "seq", "generation"], isNumber) &&
    hasFields(value, ["session_id", "created_at"], isString) &&
    isMessagePayload(value.payload) &&
    (value.metadata === null || isConversationMessageMetadata(value.metadata)) &&
    isNumberOrNull(value.cost_usd)
  );
}

export function isStudioMessageCommit(data: unknown): data is StudioMessageCommit {
  return isJsonObject(data) && isStudioMessage(data.message);
}

export function isSessionFailure(data: unknown): data is SessionFailure {
  return isJsonObject(data) && isString(data.detail);
}

/** What each event of a guild's stream carries. */
export type GuildEvents = {
  "group.message.committed": GroupMessage;
  "group.cleared": GroupChatState;
  "group.limit_reached": GroupChatState;
  "group.idle": GroupChatState;
  "group.delivery.started": unknown;
  "group.delivery.finished": unknown;
  "group.delivery.failed": unknown;
  "guild.issues.changed": unknown;
  "guild.artifacts.changed": unknown;
  "agent.routines.changed": AgentChange;
  "agent.scripts.changed": AgentChange;
};

export const guildEventGuards: PayloadGuards<GuildEvents> = {
  "group.message.committed": isGroupMessage,
  "group.cleared": isGroupChatState,
  "group.limit_reached": isGroupChatState,
  "group.idle": isGroupChatState,
  "group.delivery.started": isAnyPayload,
  "group.delivery.finished": isAnyPayload,
  "group.delivery.failed": isAnyPayload,
  "guild.issues.changed": isAnyPayload,
  "guild.artifacts.changed": isAnyPayload,
  "agent.routines.changed": isAgentChange,
  "agent.scripts.changed": isAgentChange,
};

/** What each event of the inbox's stream carries. */
export type InboxEvents = {
  "notifications.changed": unknown;
  "notifications.message": MessageNotice;
  "notifications.issue": IssueNotice;
};

export const inboxEventGuards: PayloadGuards<InboxEvents> = {
  "notifications.changed": isAnyPayload,
  "notifications.message": isMessageNotice,
  "notifications.issue": isIssueNotice,
};

/** What each event of a run's stream carries. */
export type RunEvents = {
  "generation.started": unknown;
  "assistant.reasoning.delta": LiveDelta;
  "assistant.delta": LiveDelta;
  "message.committed": RunMessage;
  "tool.progress": ToolProgressEvent;
  "run.error": unknown;
  "generation.finished": unknown;
  "run.continued": RunContinuation;
  "run.wake.changed": RunWakeChange;
};

export const runEventGuards: PayloadGuards<RunEvents> = {
  "generation.started": isAnyPayload,
  "assistant.reasoning.delta": isLiveDelta,
  "assistant.delta": isLiveDelta,
  "message.committed": isRunMessage,
  "tool.progress": isToolProgressEvent,
  "run.error": isAnyPayload,
  "generation.finished": isAnyPayload,
  "run.continued": isRunContinuation,
  "run.wake.changed": isRunWakeChange,
};

/** What each event of a Studio session's stream carries. */
export type StudioEvents = {
  "generation.started": unknown;
  "assistant.delta": LiveDelta;
  "assistant.reasoning.delta": LiveDelta;
  "message.committed": StudioMessageCommit;
  "draft.changed": unknown;
  "generation.finished": unknown;
  "session.error": unknown;
};

export const studioEventGuards: PayloadGuards<StudioEvents> = {
  "generation.started": isAnyPayload,
  "assistant.delta": isLiveDelta,
  "assistant.reasoning.delta": isLiveDelta,
  "message.committed": isStudioMessageCommit,
  "draft.changed": isAnyPayload,
  "generation.finished": isAnyPayload,
  "session.error": isAnyPayload,
};

/** What each event of a Builder session's stream carries. */
export type BuilderEvents = {
  "generation.started": unknown;
  "assistant.delta": LiveDelta;
  "assistant.reasoning.delta": LiveDelta;
  "message.committed": StudioMessageCommit;
  "recipe.changed": unknown;
  "generation.finished": unknown;
  "session.error": SessionFailure;
};

export const builderEventGuards: PayloadGuards<BuilderEvents> = {
  "generation.started": isAnyPayload,
  "assistant.delta": isLiveDelta,
  "assistant.reasoning.delta": isLiveDelta,
  "message.committed": isStudioMessageCommit,
  "recipe.changed": isAnyPayload,
  "generation.finished": isAnyPayload,
  "session.error": isSessionFailure,
};
