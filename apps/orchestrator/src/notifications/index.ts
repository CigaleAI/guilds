import { iso } from "../db/views.js";
import { guildOperators } from "../guilds/validation.js";
import { issueItem } from "../issues/index.js";
import { EventQueue } from "../lib/event.js";

// An operator's inbox is a view over existing rows, not a table of its own:
// open issues in the guilds they operate, messages tagging them that are past
// their group-chat read cursor, and how many messages sit past that cursor in
// each guild they can see. Resolving the issue, advancing that guild's read
// cursor, or clearing its group chat is what clears an entry. Marking tags as
// read advances the cursor on every guild that currently has a tag in the inbox.

export const NOTIFICATIONS_CHANGED = "notifications.changed";
/** A public message was posted in a guild the viewer can see; the data names it. */
export const NOTIFICATIONS_MESSAGE = "notifications.message";
export const INBOX_ISSUE_LIMIT = 200;
export const INBOX_MENTION_LIMIT = 100;
/** How much of a message a stream notice carries, enough for a preview. */
export const NOTICE_PREVIEW_LENGTH = 300;
const EVENT_QUEUE_LIMIT = 256;

export type NotificationsDatabase = {
  getAgent(agentId: string): Promise<Record<string, unknown> | null>;
  getGuild(guildId: string): Promise<Record<string, unknown> | null>;
  listGuildViewerIds(guildId: string): Promise<string[]>;
  listInboxIssues(orgId: string, userId: string, limit: number): Promise<Array<Record<string, unknown>>>;
  listInboxMentions(orgId: string, userId: string, limit: number): Promise<Array<Record<string, unknown>>>;
  listUnreadGroupChats(orgId: string, userId: string): Promise<Array<Record<string, unknown>>>;
  markInboxMentionsRead(orgId: string, userId: string, now: Date): Promise<string[]>;
};

type Event = [string, Record<string, unknown>];
type Queue = EventQueue<Event>;

/** An agent as the inbox names it: its id, name and look, with the look's defaults filled in. */
function agentBrief(agent: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(agent.id),
    name: String(agent.name ?? ""),
    avatar_shape: String(agent.avatar_shape || "teardrop"),
    avatar_color: String(agent.avatar_color || "#7c5cff"),
  };
}

export function mentionItem(row: Record<string, unknown>): Record<string, unknown> {
  const agentId = row.author_agent_id ? String(row.author_agent_id) : null;
  return {
    id: row.id,
    guild_id: row.guild_id,
    guild_name: row.guild_name,
    seq: Number(row.seq),
    author_type: row.author_type,
    author_name: row.author_name,
    content: row.content,
    created_at: iso(row.created_at),
    agent: agentId
      ? agentBrief({
          id: agentId,
          name: row.author_name,
          avatar_shape: row.avatar_shape,
          avatar_color: row.avatar_color,
        })
      : null,
  };
}

export function unreadItem(row: Record<string, unknown>): Record<string, unknown> {
  return { guild_id: String(row.guild_id), count: Number(row.count) };
}

/**
 * What a stream learns about a committed message: whose it is and where, the start of it, and
 * the look of the agent that wrote it.
 */
export function messageNotice(
  message: Record<string, unknown>,
  agent: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    guild_id: String(message.guild_id),
    seq: Number(message.seq),
    author_type: String(message.author_type),
    author_name: String(message.author_name ?? ""),
    preview: String(message.content ?? "").slice(0, NOTICE_PREVIEW_LENGTH),
    agent: agent ? agentBrief(agent) : null,
  };
}

export class Notifications {
  /** Each user's open streams, with the organisation each was opened in. */
  _subs = new Map<string, Map<Queue, string>>();

  constructor(public db: NotificationsDatabase) {}

  async list(orgId: string, userId: string): Promise<Record<string, unknown>> {
    const [issues, mentions, unread] = await Promise.all([
      this.db.listInboxIssues(orgId, userId, INBOX_ISSUE_LIMIT),
      this.db.listInboxMentions(orgId, userId, INBOX_MENTION_LIMIT),
      this.db.listUnreadGroupChats(orgId, userId),
    ]);
    return {
      issues: issues.map((row) => ({ ...issueItem(row), guild_name: row.guild_name })),
      mentions: mentions.map(mentionItem),
      unread: unread.map(unreadItem),
    };
  }

  /** Advances this operator's read cursor through each guild that currently has a tag in their inbox. */
  async markMentionsRead(orgId: string, userId: string): Promise<Record<string, unknown>> {
    const guildIds = await this.db.markInboxMentionsRead(orgId, userId, new Date());
    if (guildIds.length) {
      await this.ping([userId]);
    }
    return this.list(orgId, userId);
  }

  subscribe(userId: string, orgId: string): Queue {
    const queue: Queue = new EventQueue();
    const streams = this._subs.get(userId) ?? new Map<Queue, string>();
    streams.set(queue, orgId);
    this._subs.set(userId, streams);
    return queue;
  }

  unsubscribe(userId: string, queue: Queue): void {
    const streams = this._subs.get(userId);
    if (streams) {
      streams.delete(queue);
      if (!streams.size) {
        this._subs.delete(userId);
      }
    }
  }

  /** Tells these users' open streams, in every organisation, that their inbox changed. */
  async ping(userIds: Iterable<string>): Promise<void> {
    for (const userId of new Set(userIds)) {
      await this._send(userId, null, [NOTIFICATIONS_CHANGED, {}]);
    }
  }

  /** Puts the event on each of the user's streams, or on those opened in `orgId` when given. */
  async _send(userId: string, orgId: string | null, event: Event): Promise<void> {
    for (const [queue, streamOrg] of [...(this._subs.get(userId) ?? [])]) {
      if (orgId !== null && streamOrg !== orgId) {
        continue;
      }
      if (queue.size >= EVENT_QUEUE_LIMIT) {
        this.unsubscribe(userId, queue);
        continue;
      }
      await queue.put(event);
    }
  }

  /** Sends the event to everyone who can see the guild, on the streams opened in its organisation. */
  async _sendToViewers(guildId: string, event: Event): Promise<void> {
    if (!this._subs.size) {
      return;
    }
    const guild = await this.db.getGuild(guildId);
    if (!guild) {
      return;
    }
    for (const userId of await this.db.listGuildViewerIds(guildId)) {
      await this._send(userId, String(guild.org_id), event);
    }
  }

  /** Tells everyone who can see the guild of a committed message, with its author agent's look. */
  async _announceMessage(guildId: string, message: Record<string, unknown>): Promise<void> {
    if (!this._subs.size) {
      return;
    }
    const agentId = message.author_agent_id ? String(message.author_agent_id) : null;
    const agent = agentId ? await this.db.getAgent(agentId) : null;
    await this._sendToViewers(guildId, [NOTIFICATIONS_MESSAGE, messageNotice(message, agent)]);
  }

  /** Maps a guild event to the inboxes it changes. */
  async observe(guildId: string, event: string, data: Record<string, unknown>): Promise<void> {
    if (event === "group.message.committed") {
      await this._announceMessage(guildId, data);
      return;
    }
    if (event === "group.cleared") {
      await this._sendToViewers(guildId, [NOTIFICATIONS_CHANGED, {}]);
      return;
    }
    if (event === "guild.issues.changed" && this._subs.size) {
      const guild = await this.db.getGuild(guildId);
      await this.ping(guild ? guildOperators(guild).map((operator) => operator.user_id) : []);
    }
  }
}
