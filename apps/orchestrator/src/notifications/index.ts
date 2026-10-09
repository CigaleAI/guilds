import { iso } from "../db/views.js";
import { guildOperators } from "../guilds/validation.js";
import { issueItem } from "../issues/index.js";
import { EventQueue } from "../lib/event.js";

// An operator's inbox is a view over existing rows, not a table of its own:
// open issues in the guilds they operate, and messages tagging them that are
// past their group-chat read cursor. Resolving the issue or advancing that
// guild's read cursor is what clears an entry. Marking tags as read advances
// the cursor on every guild that currently has a tag in the inbox.

export const NOTIFICATIONS_CHANGED = "notifications.changed";
export const INBOX_ISSUE_LIMIT = 200;
export const INBOX_MENTION_LIMIT = 100;
const EVENT_QUEUE_LIMIT = 256;

export type NotificationsDatabase = {
  getGuild(guildId: string): Promise<Record<string, unknown> | null>;
  listInboxIssues(orgId: string, userId: string, limit: number): Promise<Array<Record<string, unknown>>>;
  listInboxMentions(orgId: string, userId: string, limit: number): Promise<Array<Record<string, unknown>>>;
  markInboxMentionsRead(orgId: string, userId: string, now: Date): Promise<string[]>;
};

type Queue = EventQueue<[string, Record<string, unknown>]>;

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
      ? {
          id: agentId,
          name: String(row.author_name ?? ""),
          avatar_shape: String(row.avatar_shape || "teardrop"),
          avatar_color: String(row.avatar_color || "#7c5cff"),
        }
      : null,
  };
}

export class Notifications {
  _subs = new Map<string, Set<Queue>>();

  constructor(public db: NotificationsDatabase) {}

  async list(orgId: string, userId: string): Promise<Record<string, unknown>> {
    const [issues, mentions] = await Promise.all([
      this.db.listInboxIssues(orgId, userId, INBOX_ISSUE_LIMIT),
      this.db.listInboxMentions(orgId, userId, INBOX_MENTION_LIMIT),
    ]);
    return {
      issues: issues.map((row) => ({ ...issueItem(row), guild_name: row.guild_name })),
      mentions: mentions.map(mentionItem),
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

  subscribe(userId: string): Queue {
    const queue: Queue = new EventQueue();
    const listeners = this._subs.get(userId) ?? new Set();
    listeners.add(queue);
    this._subs.set(userId, listeners);
    return queue;
  }

  unsubscribe(userId: string, queue: Queue): void {
    const listeners = this._subs.get(userId);
    if (listeners) {
      listeners.delete(queue);
      if (!listeners.size) {
        this._subs.delete(userId);
      }
    }
  }

  /** Tells these users' open streams that their inbox changed. */
  async ping(userIds: Iterable<string>): Promise<void> {
    for (const userId of new Set(userIds)) {
      for (const queue of [...(this._subs.get(userId) ?? [])]) {
        if (queue.size >= EVENT_QUEUE_LIMIT) {
          this.unsubscribe(userId, queue);
          continue;
        }
        await queue.put([NOTIFICATIONS_CHANGED, {}]);
      }
    }
  }

  /** Maps a guild event to the inboxes it changes. */
  async observe(guildId: string, event: string, data: Record<string, unknown>): Promise<void> {
    if (event === "group.message.committed") {
      const tagged = Array.isArray(data.tagged_user_ids) ? data.tagged_user_ids.map(String) : [];
      await this.ping(tagged);
      return;
    }
    if (event === "guild.issues.changed" && this._subs.size) {
      const guild = await this.db.getGuild(guildId);
      await this.ping(guild ? guildOperators(guild).map((operator) => operator.user_id) : []);
    }
  }
}
