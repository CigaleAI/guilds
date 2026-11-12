import { iso, type GroupMessageView } from "../db/views.js";
import { issueItem, type IssueItem } from "../issues/index.js";
import { EventQueue, type StreamEvent } from "../lib/event.js";
import { getAgent, type AgentRow } from "../db/agents.js";
import { getGuild, listGuildViewerIds } from "../db/guilds.js";
import {
  getIssue,
  listInboxIssues,
  listInboxMentions,
  markInboxMentionsRead,
  type InboxIssueRow,
  type InboxMentionRow,
} from "../db/issues.js";
import { listUnreadGroupChats, type UnreadGroupChatRow } from "../db/group-chat.js";
import { bindQuery, type Queryable } from "../db/pg.js";
import type { GuildEvent } from "../groupchat/index.js";

// An operator's inbox is a view over existing rows, not a table of its own:
// open issues in the guilds they operate, messages tagging them that are past
// their group-chat read cursor, and how many messages sit past that cursor in
// each guild they can see. Resolving the issue, advancing that guild's read
// cursor, or clearing its group chat is what clears an entry. Marking tags as
// read advances the cursor on every guild that currently has a tag in the inbox.

export const NOTIFICATIONS_CHANGED = "notifications.changed";
/** A public message was posted in a guild the viewer can see; the data names it. */
export const NOTIFICATIONS_MESSAGE = "notifications.message";
/** An agent reported an issue in a guild the viewer operates; the data is the issue. */
export const NOTIFICATIONS_ISSUE = "notifications.issue";
export const INBOX_ISSUE_LIMIT = 200;
export const INBOX_MENTION_LIMIT = 100;
/** How much of a message a stream notice carries, enough for a preview. */
export const NOTICE_PREVIEW_LENGTH = 300;
const EVENT_QUEUE_LIMIT = 256;

/** The db/ functions a user's inbox is read through, on `db`. */
function notificationsDatabase(db: Queryable) {
  return {
    getAgent: bindQuery(db, getAgent),
    getGuild: bindQuery(db, getGuild),
    getIssue: bindQuery(db, getIssue),
    listGuildViewerIds: bindQuery(db, listGuildViewerIds),
    listInboxIssues: bindQuery(db, listInboxIssues),
    listInboxMentions: bindQuery(db, listInboxMentions),
    listUnreadGroupChats: bindQuery(db, listUnreadGroupChats),
    markInboxMentionsRead: bindQuery(db, markInboxMentionsRead),
  };
}

export type NotificationsDatabase = ReturnType<typeof notificationsDatabase>;

/** An agent as the inbox names it: its id, name and look. */
export type AgentBrief = Pick<AgentRow, "id" | "name" | "avatar_shape" | "avatar_color">;

/** A message tagging the operator past their read cursor, with its guild and its author agent's look. */
export type MentionNotice = Pick<
  InboxMentionRow,
  "id" | "guild_id" | "guild_name" | "seq" | "author_type" | "author_name" | "content"
> & { created_at: string; agent: AgentBrief | null };

/** What a stream learns about a committed message: whose it is and where, the start of it, and its author agent's look. */
export type MessageNotice = Pick<GroupMessageView, "seq" | "author_type" | "author_name"> & {
  guild_id: string;
  preview: string;
  agent: AgentBrief | null;
};

/** An issue as the inbox lists it: with the name of its guild. */
export type InboxIssue = IssueItem & Pick<InboxIssueRow, "guild_name">;

/**
 * An operator's inbox: the open issues of the guilds they operate, the messages tagging them past
 * their read cursor, and each guild they can see with messages they have not read.
 */
export type Inbox = {
  issues: InboxIssue[];
  mentions: MentionNotice[];
  unread: UnreadGroupChatRow[];
};

/** That the inbox changed: the event carries nothing, and a stream reads the inbox again. */
export type InboxChanged = Record<string, never>;

/** What each event of the inbox's stream carries. */
export type InboxEvents = {
  "notifications.changed": InboxChanged;
  "notifications.message": MessageNotice;
  "notifications.issue": InboxIssue;
};

/** One event of the inbox's stream. */
export type InboxEvent = StreamEvent<InboxEvents>;

type Queue = EventQueue<InboxEvent>;

/** An agent as the inbox names it, with the look's defaults filled in. */
function agentBrief(agent: AgentLook): AgentBrief {
  return {
    id: agent.id,
    name: agent.name,
    avatar_shape: agent.avatar_shape || "teardrop",
    avatar_color: agent.avatar_color || "#7c5cff",
  };
}

/** An agent's id, name and look, as its row or a message's join holds them; a look the join misses is null. */
type AgentLook = Pick<AgentRow, "id" | "name"> & {
  avatar_shape: AgentRow["avatar_shape"] | null;
  avatar_color: AgentRow["avatar_color"] | null;
};

export function mentionItem(row: InboxMentionRow): MentionNotice {
  return {
    id: row.id,
    guild_id: row.guild_id,
    guild_name: row.guild_name,
    seq: row.seq,
    author_type: row.author_type,
    author_name: row.author_name,
    content: row.content,
    created_at: iso(row.created_at),
    agent: row.author_agent_id
      ? agentBrief({
          id: row.author_agent_id,
          name: row.author_name,
          avatar_shape: row.avatar_shape,
          avatar_color: row.avatar_color,
        })
      : null,
  };
}

/** The notice of a message committed in the guild, with the look of the agent that wrote it. */
export function messageNotice(
  guildId: string,
  message: GroupMessageView,
  agent: AgentLook | null,
): MessageNotice {
  return {
    guild_id: guildId,
    seq: message.seq,
    author_type: message.author_type,
    author_name: message.author_name,
    preview: message.content.slice(0, NOTICE_PREVIEW_LENGTH),
    agent: agent ? agentBrief(agent) : null,
  };
}

export class Notifications {
  /** Each user's open streams, with the organisation each was opened in. */
  _subs = new Map<string, Map<Queue, string>>();

  constructor(public db: NotificationsDatabase) {}

  async list(orgId: string, userId: string): Promise<Inbox> {
    const [issues, mentions, unread] = await Promise.all([
      this.db.listInboxIssues(orgId, userId, INBOX_ISSUE_LIMIT),
      this.db.listInboxMentions(orgId, userId, INBOX_MENTION_LIMIT),
      this.db.listUnreadGroupChats(orgId, userId),
    ]);
    return {
      issues: issues.map((row) => ({ ...issueItem(row), guild_name: row.guild_name })),
      mentions: mentions.map(mentionItem),
      unread,
    };
  }

  /** Advances this operator's read cursor through each guild that currently has a tag in their inbox. */
  async markMentionsRead(orgId: string, userId: string): Promise<Inbox> {
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
  async _send(userId: string, orgId: string | null, event: InboxEvent): Promise<void> {
    for (const [queue, streamOrg] of [...(this._subs.get(userId) ?? [])]) {
      if (orgId !== null && streamOrg !== orgId) {
        continue;
      }
      if (queue.size >= EVENT_QUEUE_LIMIT) {
        queue.drop();
        this.unsubscribe(userId, queue);
        continue;
      }
      await queue.put(event);
    }
  }

  /** Sends the event to everyone who can see the guild, on the streams opened in its organisation. */
  async _sendToViewers(guildId: string, event: InboxEvent): Promise<void> {
    if (!this._subs.size) {
      return;
    }
    const guild = await this.db.getGuild(guildId);
    if (!guild) {
      return;
    }
    for (const userId of await this.db.listGuildViewerIds(guildId)) {
      await this._send(userId, guild.org_id, event);
    }
  }

  /** Tells everyone who can see the guild of a committed message, with its author agent's look. */
  async _announceMessage(guildId: string, message: GroupMessageView): Promise<void> {
    if (!this._subs.size) {
      return;
    }
    const agentId = message.author_agent_id;
    const agent = agentId ? await this.db.getAgent(agentId) : null;
    await this._sendToViewers(guildId, [NOTIFICATIONS_MESSAGE, messageNotice(guildId, message, agent)]);
  }

  /**
   * Tells the guild's operators of the issue an agent just reported, on the streams opened in the
   * guild's organisation, then that their inbox changed. An issue that is gone is not announced.
   */
  async _announceIssue(guildId: string, issueId: string): Promise<void> {
    const [guild, issue] = await Promise.all([this.db.getGuild(guildId), this.db.getIssue(guildId, issueId)]);
    if (!guild) {
      return;
    }
    const operatorIds = guild.operators.map((operator) => operator.user_id);
    if (issue) {
      const notice: InboxIssue = { ...issueItem(issue), guild_name: guild.name };
      for (const userId of new Set(operatorIds)) {
        await this._send(userId, guild.org_id, [NOTIFICATIONS_ISSUE, notice]);
      }
    }
    await this.ping(operatorIds);
  }

  /** Maps a guild event to the inboxes it changes. */
  async observe(guildId: string, ...[event, data]: GuildEvent): Promise<void> {
    if (event === "group.message.committed") {
      await this._announceMessage(guildId, data);
      return;
    }
    if (event === "group.cleared") {
      await this._sendToViewers(guildId, [NOTIFICATIONS_CHANGED, {}]);
      return;
    }
    if (event !== "guild.issues.changed" || !this._subs.size) {
      return;
    }
    if (data.action === "create" && data.issue_id !== undefined) {
      await this._announceIssue(guildId, data.issue_id);
    } else {
      const guild = await this.db.getGuild(guildId);
      await this.ping(guild ? guild.operators.map((operator) => operator.user_id) : []);
    }
  }
}

/** Operators' inboxes and their streams, read on `db`. */
export function operatorNotifications(db: Queryable): Notifications {
  return new Notifications(notificationsDatabase(db));
}
