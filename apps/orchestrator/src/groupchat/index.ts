import { jsonObj } from "../db/json.js";
import { AgentMessageLimitReached, GuildInactive } from "../db/errors.js";
import { groupMessageItem } from "../db/views.js";
import { guildOperators, type GuildOperator } from "../guilds/validation.js";
import { EventQueue } from "../lib/event.js";
import { writeLog } from "../observability/log.js";
import {
  defaultGroupRouter,
  serializeRecipientDecision,
  type GroupRouter,
  type RecipientDecision,
} from "../typesafe/index.js";
import { groupChatHistory, storedTags } from "./history.js";

export {
  CONTEXT_HISTORY_LIMIT,
  HISTORY_CANDIDATE_LIMIT,
  groupChatHistory,
  recentGroupRows,
  storedTags,
} from "./history.js";

const EVENT_QUEUE_LIMIT = 4096;

export class GroupChatError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "GroupChatError";
    this.status = status;
    this.detail = detail;
  }
}

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

export function requireContent(content: string): string {
  if (!content || !content.trim()) {
    throw new GroupChatError(422, "content must contain non-whitespace text");
  }
  return content;
}

export function limitError(limit: number): string {
  return `ERROR: group chat is waiting for a user message after ${limit} consecutive agent messages`;
}

export const USER_TAG = "user";
export const TAG_RE = /(?<![A-Za-z0-9-])@([a-z][a-z0-9-]{0,62})\b/g;

export function parseTags(content: string, names: Set<string>): string[] {
  const tagged: string[] = [];
  const seen = new Set<string>();
  const matches = (content || "").matchAll(TAG_RE);
  for (const match of matches) {
    const token = match[1];
    if (token && names.has(token) && !seen.has(token)) {
      tagged.push(token);
      seen.add(token);
    }
  }
  return tagged;
}

export function taggableNames(
  members: Array<Record<string, unknown>>,
  operators: GuildOperator[] = [],
): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    if (member.archived_at === null || member.archived_at === undefined) {
      names.add(String(member.name));
    }
  }
  for (const operator of operators) {
    names.add(operator.name);
  }
  names.add(USER_TAG);
  return names;
}

export type GroupTags = { names: string[]; agentIds: string[]; userIds: string[] };

/**
 * Tags in a public message: the names as written, the member agents they
 * select, and the operators they reach. `@user` reaches every operator.
 */
export function recognizedTags(
  content: string,
  members: Array<Record<string, unknown>>,
  operators: GuildOperator[] = [],
): GroupTags {
  const names = parseTags(content, taggableNames(members, operators));
  const agentIdsByName = new Map<string, string>();
  for (const member of members) {
    if (member.archived_at === null || member.archived_at === undefined) {
      agentIdsByName.set(String(member.name), String(member.id));
    }
  }
  const agentIds: string[] = [];
  const userIds = new Set<string>();
  for (const name of names) {
    const agentId = agentIdsByName.get(name);
    if (agentId !== undefined) {
      agentIds.push(agentId);
    }
    for (const operator of operators) {
      if (name === USER_TAG || operator.name === name) {
        userIds.add(operator.user_id);
      }
    }
  }
  return { names, agentIds, userIds: [...userIds] };
}

export function storedTagAgentIds(row: Record<string, unknown>): string[] {
  const tagged = jsonObj(row.tagged_agent_ids);
  if (!Array.isArray(tagged)) {
    return [];
  }
  return tagged.filter((item): item is string => typeof item === "string");
}

export function taggedRecipientNamesAfter(
  rows: Array<Record<string, unknown>>,
  members: Array<Record<string, unknown>>,
  deliveredThrough: number,
): Set<string> {
  const membersById = new Map<string, string>();
  for (const member of members) {
    if (member.archived_at === null || member.archived_at === undefined) {
      membersById.set(String(member.id), String(member.name));
    }
  }
  const recipients = new Set<string>();
  for (const row of rows) {
    if (Number(row.seq) <= deliveredThrough) {
      continue;
    }
    const taggedAgentIds = new Set(storedTagAgentIds(row));
    for (const agentId of taggedAgentIds) {
      if (row.author_type === "agent" && agentId === row.author_agent_id) {
        continue;
      }
      const name = membersById.get(agentId);
      if (name !== undefined) {
        recipients.add(name);
      }
    }
  }
  return recipients;
}

export function recipientNamesAfter(
  rows: Array<Record<string, unknown>>,
  members: Array<Record<string, unknown>>,
  deliveredThrough: number,
): Set<string> {
  const membersById = new Map<string, string>();
  for (const member of members) {
    if (member.archived_at === null || member.archived_at === undefined) {
      membersById.set(String(member.id), String(member.name));
    }
  }
  const recipients = new Set<string>();
  for (const row of rows) {
    if (Number(row.seq) <= deliveredThrough) {
      continue;
    }
    const taggedAgentIds = new Set(storedTagAgentIds(row));
    let recipientIds: Set<string>;
    if (row.author_type === "user") {
      recipientIds = taggedAgentIds.size ? taggedAgentIds : new Set(membersById.keys());
    } else {
      recipientIds = new Set([...taggedAgentIds].filter((id) => id !== row.author_agent_id));
    }
    for (const agentId of recipientIds) {
      const name = membersById.get(agentId);
      if (name !== undefined) {
        recipients.add(name);
      }
    }
  }
  return recipients;
}

function viewerWasTagged(
  rows: Array<Record<string, unknown>>,
  viewerName: string,
  deliveredThrough: number,
): boolean {
  if (!viewerName) {
    return false;
  }
  for (const row of rows) {
    if (Number(row.seq) <= deliveredThrough) {
      continue;
    }
    if (storedTags(row).includes(viewerName)) {
      return true;
    }
  }
  return false;
}

export function groupChatUserMessage(args: {
  members: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  viewerName?: string;
  deliveredThrough?: number;
}): [Record<string, unknown>, Record<string, unknown>] {
  const viewerName = args.viewerName ?? "";
  const deliveredThrough = args.deliveredThrough ?? 0;
  const history = groupChatHistory(args.rows);
  const latest = history.length ? history[history.length - 1] : null;
  const info = {
    latestMessage: latest,
    youWereTagged: viewerWasTagged(args.rows, viewerName, deliveredThrough),
  };
  const payload = {
    role: "user",
    content: `Group Chat info: ${JSON.stringify(info, null, 2)}`,
  };
  const metadata: Record<string, unknown> = { source: "group_chat" };
  if (args.rows.length) {
    const last = args.rows[args.rows.length - 1] as Record<string, unknown>;
    metadata.group_message_id = last.id;
    metadata.group_seq = last.seq;
    metadata.author_type = last.author_type;
    metadata.author_name = last.author_name;
    metadata.tagged = latest ? latest.tagged : [];
    metadata.you_were_tagged = info.youWereTagged;
    metadata.recipients = [
      ...recipientNamesAfter(args.rows, args.members, deliveredThrough),
    ].sort();
  }
  return [payload, metadata];
}

export type GroupChatDatabase = {
  getGroupChatState(guildId: string): Promise<Record<string, unknown> | null>;
  updateGroupAgentMessageLimit(
    guildId: string,
    limit: number,
    now: Date,
  ): Promise<Record<string, unknown> | null>;
  getGuild(guildId: string): Promise<Record<string, unknown> | null>;
  listGroupMessages(
    guildId: string,
    options?: { throughSeq?: number | null },
  ): Promise<Array<Record<string, unknown>>>;
  listAgents(guildId: string): Promise<Array<Record<string, unknown>>>;
  postUserGroupMessage(
    guildId: string,
    content: string,
    taggedNames: string[],
    taggedAgentIds: string[],
    taggedUserIds: string[],
    now: Date,
    options?: { authorName?: string },
  ): Promise<Record<string, unknown> | null>;
  postAgentGroupMessage(
    guildId: string,
    agentId: string,
    authorName: string,
    sourceRunId: string,
    content: string,
    taggedNames: string[],
    taggedAgentIds: string[],
    taggedUserIds: string[],
    now: Date,
  ): Promise<Record<string, unknown> | null>;
  getRun(runId: string): Promise<Record<string, unknown> | null>;
  getAgent(agentId: string): Promise<Record<string, unknown> | null>;
  listPendingGroupAgents(guildId: string, chatSeq: number): Promise<Array<Record<string, unknown>>>;
  advanceGroupCursor(agentId: string, seq: number): Promise<void>;
  appendGroupChatError(
    guildId: string,
    entry: Record<string, unknown>,
    now: Date,
  ): Promise<unknown[]>;
  listGuilds?(orgId?: string | null): Promise<Array<Record<string, unknown>>>;
};

export type GuildEventObserver = (
  guildId: string,
  event: string,
  data: Record<string, unknown>,
) => Promise<void>;

export type GroupRunner = {
  agent_is_busy(agentId: string): boolean;
  wait_lock_release(seen: number): Promise<void>;
  deliver_group_run(agentId: string, throughSeq: number, deliveredThrough: number): Promise<void>;
  lock_generation: number;
};

type DispatchHandle = {
  promise: Promise<void>;
  done(): boolean;
};

export class GroupChat {
  db: GroupChatDatabase;
  _is_deleting: (guildId: string) => boolean;
  _runner: GroupRunner | null = null;
  _subs = new Map<string, Set<EventQueue<[string, Record<string, unknown>]>>>();
  _observers: GuildEventObserver[] = [];
  _dispatch_tasks = new Map<string, DispatchHandle>();
  _active_agent = new Map<string, { id: string; name: string }>();
  _router: GroupRouter;
  lastRecipientDecision: RecipientDecision | null = null;
  _recipientCache: { guildId: string; snapshot: number; decision: RecipientDecision } | null = null;

  constructor(
    db: GroupChatDatabase,
    options: { is_deleting: (guildId: string) => boolean; router?: GroupRouter },
  ) {
    this.db = db;
    this._is_deleting = options.is_deleting;
    this._router = options.router ?? defaultGroupRouter();
  }

  bind(runner: GroupRunner): void {
    this._runner = runner;
  }

  isDispatching(guildId: string): boolean {
    return this.is_dispatching(guildId);
  }

  is_dispatching(guildId: string): boolean {
    const task = this._dispatch_tasks.get(guildId);
    return task !== undefined && !task.done();
  }

  subscribe(guildId: string): EventQueue<[string, Record<string, unknown>]> {
    const queue = new EventQueue<[string, Record<string, unknown>]>();
    const listeners = this._subs.get(guildId) ?? new Set();
    listeners.add(queue);
    this._subs.set(guildId, listeners);
    return queue;
  }

  unsubscribe(guildId: string, queue: EventQueue<[string, Record<string, unknown>]>): void {
    const listeners = this._subs.get(guildId);
    if (listeners) {
      listeners.delete(queue);
      if (!listeners.size) {
        this._subs.delete(guildId);
      }
    }
  }

  /** Runs `observer` on every guild event after the guild's streams get it. */
  observe(observer: GuildEventObserver): void {
    this._observers.push(observer);
  }

  async publish(guildId: string, event: string, data: Record<string, unknown>): Promise<void> {
    for (const queue of [...(this._subs.get(guildId) ?? [])]) {
      if (queue.size >= EVENT_QUEUE_LIMIT) {
        this.unsubscribe(guildId, queue);
        continue;
      }
      await queue.put([event, data]);
    }
    for (const observer of this._observers) {
      try {
        await observer(guildId, event, data);
      } catch (error) {
        writeLog("error", "group.observer_failed", { operation: "group.observer", guild_id: guildId }, error);
      }
    }
  }

  async wake(guildId: string): Promise<void> {
    if (this._runner === null || this._is_deleting(guildId)) {
      return;
    }
    const state = await this.state(guildId);
    if (Number(state.pending_agent_count) === 0) {
      return;
    }
    this._ensure_dispatch(guildId);
  }

  async resume_all(): Promise<void> {
    if (this._runner === null || !this.db.listGuilds) {
      return;
    }
    for (const guild of await this.db.listGuilds()) {
      await this.wake(String(guild.id));
    }
  }

  async resumeAll(): Promise<void> {
    await this.resume_all();
  }

  async stopDispatchers(): Promise<void> {
    const handles = [...this._dispatch_tasks.values()];
    this._dispatch_tasks.clear();
    await Promise.allSettled(handles.map((handle) => handle.promise));
  }

  async state(guildId: string): Promise<Record<string, unknown>> {
    const row = await this.db.getGroupChatState(guildId);
    if (row === null) {
      throw new GroupChatError(404, "guild not found");
    }
    return this._state_view(row);
  }

  async set_limit(guildId: string, limit: number): Promise<Record<string, unknown>> {
    if (this._is_deleting(guildId)) {
      throw new GroupChatError(409, "guild is being deleted");
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new GroupChatError(422, "agent_message_limit must be a positive integer");
    }
    const row = await this.db.updateGroupAgentMessageLimit(guildId, limit, new Date());
    if (row === null) {
      throw new GroupChatError(404, "guild not found");
    }
    return this._state_view(row);
  }

  async setLimit(guildId: string, limit: number): Promise<Record<string, unknown>> {
    return this.set_limit(guildId, limit);
  }

  async list_messages(guildId: string): Promise<Array<Record<string, unknown>>> {
    const guild = await this.db.getGuild(guildId);
    if (guild === null) {
      throw new GroupChatError(404, "guild not found");
    }
    return (await this.db.listGroupMessages(guildId)).map((row) => groupMessageItem(row));
  }

  async listMessages(guildId: string): Promise<Array<Record<string, unknown>>> {
    return this.list_messages(guildId);
  }

  async post_user(
    guildId: string,
    content: string,
    options: { author_name?: string } = {},
  ): Promise<Record<string, unknown>> {
    if (this._is_deleting(guildId)) {
      throw new GroupChatError(409, "guild is being deleted");
    }
    const text = requireContent(content);
    const tags = await this._tags(guildId, text);
    let row: Record<string, unknown> | null;
    try {
      row = await this.db.postUserGroupMessage(
        guildId,
        text,
        tags.names,
        tags.agentIds,
        tags.userIds,
        new Date(),
        {
          authorName: options.author_name ?? "user",
        },
      );
    } catch (error) {
      if (error instanceof GuildInactive) {
        throw new GroupChatError(409, "guild is archived");
      }
      throw error;
    }
    if (row === null) {
      throw new GroupChatError(404, "guild not found");
    }
    const message = groupMessageItem(row);
    await this._after_commit(guildId, message);
    return message;
  }

  async postUser(
    guildId: string,
    content: string,
    options: { author_name?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.post_user(guildId, content, options);
  }

  async post_from_run(
    runId: string,
    agentId: string,
    guildId: string,
    agentName: string,
    content: string,
  ): Promise<string> {
    if (this._is_deleting(guildId)) {
      throw new Error("guild is being deleted");
    }
    const text = content && content.trim() ? content : "";
    if (!text) {
      throw new Error("content must contain non-whitespace text");
    }
    const tags = await this._tags(guildId, text);
    const run = await this.db.getRun(runId);
    if (run === null || run.agent_id !== agentId) {
      throw new Error("source run is not available");
    }
    const agent = await this.db.getAgent(agentId);
    if (agent === null || agent.guild_id !== guildId) {
      throw new Error("agent is not a member of this guild");
    }
    let row: Record<string, unknown> | null;
    try {
      row = await this.db.postAgentGroupMessage(
        guildId,
        agentId,
        agentName,
        runId,
        content,
        tags.names,
        tags.agentIds,
        tags.userIds,
        new Date(),
      );
    } catch (error) {
      if (error instanceof GuildInactive) {
        throw new Error("guild is archived", { cause: error });
      }
      if (error instanceof AgentMessageLimitReached) {
        return limitError(error.limit);
      }
      throw error;
    }
    if (row === null) {
      throw new Error("guild is not available");
    }
    const message = groupMessageItem(row);
    await this._after_commit(guildId, message);
    return `posted id=${message.id} seq=${message.seq}`;
  }

  async postFromRun(
    runId: string,
    agentId: string,
    guildId: string,
    agentName: string,
    content: string,
  ): Promise<string> {
    return this.post_from_run(runId, agentId, guildId, agentName, content);
  }

  async _tags(guildId: string, text: string): Promise<GroupTags> {
    const members = await this.db.listAgents(guildId);
    const guild = await this.db.getGuild(guildId);
    return recognizedTags(text, members, guild ? guildOperators(guild) : []);
  }

  async _after_commit(guildId: string, message: Record<string, unknown>): Promise<void> {
    await this.publish(guildId, "group.message.committed", message);
    const state = await this.state(guildId);
    if (state.limit_reached) {
      await this.publish(guildId, "group.limit_reached", state);
    }
    if (Number(state.pending_agent_count) === 0) {
      await this.publish(guildId, "group.idle", state);
    }
    await this.wake(guildId);
  }

  _ensure_dispatch(guildId: string): void {
    const task = this._dispatch_tasks.get(guildId);
    if (task !== undefined && !task.done()) {
      return;
    }
    let finished = false;
    const handle: DispatchHandle = {
      promise: Promise.resolve(),
      done: () => finished,
    };
    this._dispatch_tasks.set(guildId, handle);
    handle.promise = this._dispatch(guildId).finally(() => {
      finished = true;
    });
  }

  async _recipient_names(
    guildId: string,
    pending: Array<Record<string, unknown>>,
    snapshot: number,
  ): Promise<Set<string>> {
    if (
      this._recipientCache &&
      this._recipientCache.guildId === guildId &&
      this._recipientCache.snapshot === snapshot
    ) {
      this.lastRecipientDecision = this._recipientCache.decision;
      return this._recipientCache.decision.names;
    }
    const rows = await this.db.listGroupMessages(guildId, { throughSeq: snapshot });
    if (!rows.length) {
      const empty: RecipientDecision = { source: "tags", names: new Set() };
      this.lastRecipientDecision = empty;
      this._recipientCache = { guildId, snapshot, decision: empty };
      return empty.names;
    }
    const members = await this.db.listAgents(guildId);
    const tagged = new Set<string>();
    const fanout = new Set<string>();
    for (const agent of pending) {
      const name = String(agent.name);
      const deliveredThrough = Number(agent.group_chat_delivered_through);
      if (taggedRecipientNamesAfter(rows, members, deliveredThrough).has(name)) {
        tagged.add(name);
      }
      if (recipientNamesAfter(rows, members, deliveredThrough).has(name)) {
        fanout.add(name);
      }
    }
    let decision: RecipientDecision;
    if (!this._router.configured) {
      decision = { source: "tags", names: fanout };
    } else {
      decision = await this._router.recipients({
        rows,
        members,
        pending,
        taggedNames: tagged,
        ruleNames: fanout,
      });
    }
    this.lastRecipientDecision = decision;
    this._recipientCache = { guildId, snapshot, decision };
    // A `none` verdict creates no run, so this line is its only trace.
    const summary = serializeRecipientDecision(decision);
    writeLog(
      "info",
      `group recipients through ${snapshot}: source=${decision.source} choice=${decision.choice ?? "-"}` +
        ` confidence=${decision.confidence === undefined ? "-" : decision.confidence.toFixed(3)}` +
        ` names=${JSON.stringify(summary.names)}`,
      { guild_id: guildId, operation: "group.recipients" },
    );
    return decision.names;
  }

  recipientMetadata(): Record<string, unknown> | null {
    return this.lastRecipientDecision
      ? serializeRecipientDecision(this.lastRecipientDecision)
      : null;
  }

  async _dispatch(guildId: string): Promise<void> {
    const current = this._dispatch_tasks.get(guildId);
    try {
      while (!this._is_deleting(guildId)) {
        const runner = this._runner;
        if (runner === null) {
          return;
        }
        const state = await this.state(guildId);
        const pending = await this.db.listPendingGroupAgents(guildId, Number(state.chat_seq));
        if (!pending.length) {
          await this.publish(guildId, "group.idle", await this.state(guildId));
          return;
        }
        let snapshot = Number(state.chat_seq);
        const recipients = await this._recipient_names(guildId, pending, snapshot);
        const actionable = pending.filter((agent) => recipients.has(String(agent.name)));
        for (const agent of pending) {
          if (!recipients.has(String(agent.name))) {
            await this.db.advanceGroupCursor(String(agent.id), snapshot);
          }
        }
        if (!actionable.length) {
          await this.publish(guildId, "group.idle", await this.state(guildId));
          return;
        }
        const idle = actionable.filter((agent) => !runner.agent_is_busy(String(agent.id)));
        if (!idle.length) {
          const seen = runner.lock_generation;
          await runner.wait_lock_release(seen);
          continue;
        }
        const agent = idle[0];
        if (!agent) {
          return;
        }
        snapshot = Number((await this.state(guildId)).chat_seq);
        const deliveredThrough = Number(agent.group_chat_delivered_through);
        this._active_agent.set(guildId, { id: String(agent.id), name: String(agent.name) });
        await this.publish(guildId, "group.delivery.started", {
          agent_id: agent.id,
          agent_name: agent.name,
          through_seq: snapshot,
        });
        try {
          await runner.deliver_group_run(String(agent.id), snapshot, deliveredThrough);
          await this.db.advanceGroupCursor(String(agent.id), snapshot);
          await this.publish(guildId, "group.delivery.finished", {
            agent_id: agent.id,
            through_seq: snapshot,
          });
        } catch (error) {
          if (error instanceof DeliveryBusyError) {
            const seen = runner.lock_generation;
            await runner.wait_lock_release(seen);
            continue;
          }
          if (error instanceof DeliveryCreateError) {
            await this._delivery_failed(guildId, String(agent.id), snapshot, error);
          } else {
            writeLog(
              "error",
              "group delivery failed",
              {
                guild_id: guildId,
                agent_id: String(agent.id),
                operation: "group.delivery",
                error_type: error instanceof Error ? error.name : "Error",
              },
              error,
            );
            await this._delivery_failed(guildId, String(agent.id), snapshot, error);
          }
        } finally {
          this._active_agent.delete(guildId);
        }
      }
    } catch (error) {
      writeLog(
        "error",
        "group dispatch failed",
        {
          guild_id: guildId,
          operation: "group.dispatch",
          error_type: error instanceof Error ? error.name : "Error",
        },
        error,
      );
    } finally {
      this._active_agent.delete(guildId);
      if (this._dispatch_tasks.get(guildId) === current) {
        this._dispatch_tasks.delete(guildId);
      }
    }
  }

  async _delivery_failed(
    guildId: string,
    agentId: string,
    snapshot: number,
    exc: unknown,
  ): Promise<void> {
    const now = new Date();
    const entry = {
      at: now.toISOString(),
      agent_id: agentId,
      operation: "group.delivery",
      error_type: exc instanceof Error ? exc.name : "Error",
      message: String(exc instanceof Error ? exc.message : exc),
    };
    await this.db.appendGroupChatError(guildId, entry, now);
    await this.db.advanceGroupCursor(agentId, snapshot);
    await this.publish(guildId, "group.delivery.failed", entry);
  }

  _state_view(row: Record<string, unknown>): Record<string, unknown> {
    const errors = jsonObj(row.errors);
    const count = Number(row.agent_message_count);
    const limit = Number(row.agent_message_limit);
    const guildId = String(row.guild_id);
    const active = this._active_agent.get(guildId);
    return {
      guild_id: guildId,
      chat_seq: Number(row.chat_seq),
      agent_message_count: count,
      agent_message_limit: limit,
      dispatching: this.is_dispatching(guildId),
      pending_agent_count: Number(row.pending_agent_count),
      active_agent_id: active ? active.id : null,
      active_agent_name: active ? active.name : null,
      limit_reached: count >= limit,
      errors: Array.isArray(errors) ? errors : [],
      last_recipient_decision:
        this._recipientCache && this._recipientCache.guildId === guildId
          ? {
              through_seq: this._recipientCache.snapshot,
              ...serializeRecipientDecision(this._recipientCache.decision),
            }
          : null,
    };
  }
}
