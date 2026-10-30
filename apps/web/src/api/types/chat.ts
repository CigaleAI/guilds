import type { AgentBrief } from "./agents";
import type { Issue } from "./issues";

/**
 * Shapes of the orchestrator's JSON API for the group chat and the inbox, as the app reads them.
 * Timestamps are ISO-8601 in UTC.
 */

export type DeliveryError = {
  at: string;
  agent_id: string;
  operation: "group.delivery";
  error_type: string;
  message: string;
};

export type GroupChatState = {
  guild_id: string;
  chat_seq: number;
  agent_message_count: number;
  agent_message_limit: number;
  dispatching: boolean;
  pending_agent_count: number;
  /** The agents in a group run right now; several when tags started them side by side. */
  active_agents: { id: string; name: string }[];
  limit_reached: boolean;
  errors: DeliveryError[];
  /** The last message this operator has seen; null when they never opened the chat. */
  seen_through_seq?: number | null;
};

export type GroupMessage = {
  id: number;
  seq: number;
  author_type: "user" | "agent";
  author_name: string;
  author_agent_id: string | null;
  /** The run that produced an agent's post. */
  source_run_id: string | null;
  /** Markdown. Tags are written inline as `@name`. */
  content: string;
  tagged: string[];
  tagged_agent_ids: string[];
  tagged_user_ids: string[];
  created_at: string;
};

/** A group chat post; `interrupt` also stops the group runs it targets. */
export type GroupMessageInput = { content: string; interrupt?: boolean };

export type MentionNotice = {
  id: number;
  guild_id: string;
  guild_name: string;
  seq: number;
  author_type: "user" | "agent";
  author_name: string;
  content: string;
  created_at: string;
  agent: AgentBrief | null;
};

/** Group chat messages past the operator's read cursor in one guild. */
export type UnreadChat = {
  guild_id: string;
  count: number;
};

export type Notifications = {
  issues: (Issue & { guild_name: string })[];
  mentions: MentionNotice[];
  /** Every guild the operator can see with messages they have not read. */
  unread: UnreadChat[];
};

/** What the inbox stream says of a message posted in a guild the operator can see. */
export type MessageNotice = {
  guild_id: string;
  seq: number;
  author_type: "user" | "agent";
  author_name: string;
  /** The start of the message, up to 300 characters of markdown. */
  preview: string;
  /** The agent that wrote it, with its look; null for an operator's message. */
  agent: AgentBrief | null;
};
