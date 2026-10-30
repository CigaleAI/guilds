import { AgentMessageLimitReached, GroupChatCleared } from "../db/errors.js";
import { groupMessageItem, type GroupMessageView } from "../db/views.js";
import { AsyncEvent, EventQueue } from "../lib/event.js";
import { writeLog } from "../observability/log.js";
import { serializeRecipientDecision, type GroupRouter, type RecipientDecision } from "./router.js";
import { recognizedTags, type GroupTags } from "./tags.js";
import { recipientNamesAfter, taggedRecipientNamesAfter } from "./recipients.js";
import {
  DeliveryBusyError,
  DeliveryCreateError,
  deliveriesToStart,
  interruptTargets,
  withActiveCursors,
  type ActiveDelivery,
  type GroupDelivery,
  type GroupRunner,
  type PendingAgent,
} from "./delivery.js";
import { advanceGroupCursor,
  appendGroupChatError,
  clearGroupMessages,
  getGroupChatState,
  listGroupMessages,
  listPendingGroupAgents,
  postAgentGroupMessage,
  postUserGroupMessage,
  updateGroupAgentMessageLimit, type GroupChatStateRow, type GroupMessageRow } from "../db/group-chat.js";
import { getGuild, listGuilds } from "../db/guilds.js";
import { getAgent, listAgents } from "../db/agents.js";
import { getRun } from "../db/runs.js";
import type { RecipientRouting } from "../db/schema/index.js";
import { bindQuery, type Queryable } from "../db/pg.js";

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

export function requireContent(content: string): string {
  if (!content || !content.trim()) {
    throw new GroupChatError(422, "content must contain non-whitespace text");
  }
  return content;
}

export function limitError(limit: number): string {
  return `ERROR: group chat is waiting for a user message after ${limit} consecutive agent messages`;
}

export const CLEARED_ERROR =
  "ERROR: the group chat was cleared after this run started; nothing was posted";

/** The operator posting: the user the message is written as. */
export type MessageAuthor = { id: string; name: string };

/** The db/ functions a guild's group chat is read and written through, on `db`. */
function groupChatDatabase(db: Queryable) {
  return {
    getGroupChatState: bindQuery(db, getGroupChatState),
    updateGroupAgentMessageLimit: bindQuery(db, updateGroupAgentMessageLimit),
    clearGroupMessages: bindQuery(db, clearGroupMessages),
    getGuild: bindQuery(db, getGuild),
    listGroupMessages: bindQuery(db, listGroupMessages),
    listAgents: bindQuery(db, listAgents),
    postUserGroupMessage: bindQuery(db, postUserGroupMessage),
    postAgentGroupMessage: bindQuery(db, postAgentGroupMessage),
    getRun: bindQuery(db, getRun),
    getAgent: bindQuery(db, getAgent),
    listPendingGroupAgents: bindQuery(db, listPendingGroupAgents),
    advanceGroupCursor: bindQuery(db, advanceGroupCursor),
    appendGroupChatError: bindQuery(db, appendGroupChatError),
    listGuilds: bindQuery(db, listGuilds),
  };
}

export type GroupChatDatabase = ReturnType<typeof groupChatDatabase>;

export type GuildEventObserver = (
  guildId: string,
  event: string,
  data: Record<string, unknown>,
) => Promise<void>;

type RecipientPick = { decision: RecipientDecision; tagged: Set<string> };

type DispatchHandle = {
  promise: Promise<void>;
  done(): boolean;
};

/** A group run under way as the chat's state names it. */
export type ActiveAgent = Pick<ActiveDelivery, "id" | "name">;

/** A guild's group chat as its operators and streams see it: its counters, its runs, its last pick. */
export type GroupChatView = {
  guild_id: GroupChatStateRow["guild_id"];
  chat_seq: GroupChatStateRow["chat_seq"];
  agent_message_count: GroupChatStateRow["agent_message_count"];
  agent_message_limit: GroupChatStateRow["agent_message_limit"];
  dispatching: boolean;
  pending_agent_count: GroupChatStateRow["pending_agent_count"];
  active_agents: ActiveAgent[];
  limit_reached: boolean;
  errors: GroupChatStateRow["errors"];
  last_recipient_decision: (RecipientRouting & { through_seq: number }) | null;
};

/** What a group chat runs with beside its database: whether a guild is being deleted, and the recipient router. */
export type GroupChatServices = { is_deleting: (guildId: string) => boolean; router: GroupRouter };

export class GroupChat {
  db: GroupChatDatabase;
  _is_deleting: (guildId: string) => boolean;
  _runner: GroupRunner | null = null;
  _subs = new Map<string, Set<EventQueue<[string, Record<string, unknown>]>>>();
  _observers: GuildEventObserver[] = [];
  _dispatch_tasks = new Map<string, DispatchHandle>();
  /** Each guild's group runs under way, by agent id. */
  _active = new Map<string, Map<string, ActiveDelivery>>();
  /** Set when something may let a guild's dispatcher start another run. */
  _kicks = new Map<string, AsyncEvent>();
  _router: GroupRouter;
  lastRecipientDecision: RecipientDecision | null = null;
  _recipientCache: {
    guildId: string;
    snapshot: number;
    decision: RecipientDecision;
    tagged: Set<string>;
  } | null = null;

  constructor(db: GroupChatDatabase, options: GroupChatServices) {
    this.db = db;
    this._is_deleting = options.is_deleting;
    this._router = options.router;
  }

  bind(runner: GroupRunner): void {
    this._runner = runner;
  }

  isDispatching(guildId: string): boolean {
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
    if (this.isDispatching(guildId)) {
      this._kick(guildId).set();
      return;
    }
    const state = await this.state(guildId);
    if (state.pending_agent_count === 0) {
      return;
    }
    this._ensure_dispatch(guildId);
  }

  async resumeAll(): Promise<void> {
    if (this._runner === null || !this.db.listGuilds) {
      return;
    }
    for (const guild of await this.db.listGuilds()) {
      await this.wake(String(guild.id));
    }
  }

  async stopDispatchers(): Promise<void> {
    const handles = [...this._dispatch_tasks.values()];
    this._dispatch_tasks.clear();
    await Promise.allSettled(handles.map((handle) => handle.promise));
  }

  async state(guildId: string): Promise<GroupChatView> {
    const row = await this.db.getGroupChatState(guildId);
    if (row === null) {
      throw new GroupChatError(404, "guild not found");
    }
    return this._state_view(row);
  }

  async setLimit(guildId: string, limit: number): Promise<GroupChatView> {
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

  /** Deletes the guild's public messages for everyone and tells open chats. */
  async clear(guildId: string): Promise<GroupChatView> {
    if (this._is_deleting(guildId)) {
      throw new GroupChatError(409, "guild is being deleted");
    }
    const row = await this.db.clearGroupMessages(guildId, new Date());
    if (row === null) {
      throw new GroupChatError(404, "guild not found");
    }
    if (this._recipientCache?.guildId === guildId) {
      this._recipientCache = null;
    }
    const state = this._state_view(row);
    await this.publish(guildId, "group.cleared", state);
    return state;
  }

  async listMessages(guildId: string): Promise<GroupMessageView[]> {
    const guild = await this.db.getGuild(guildId);
    if (guild === null) {
      throw new GroupChatError(404, "guild not found");
    }
    return (await this.db.listGroupMessages(guildId)).map((row) => groupMessageItem(row));
  }

  /** Posts an operator message as `author`. */
  async postUser(
    guildId: string,
    content: string,
    author: MessageAuthor,
  ): Promise<GroupMessageView> {
    if (this._is_deleting(guildId)) {
      throw new GroupChatError(409, "guild is being deleted");
    }
    const text = requireContent(content);
    const tags = await this._tags(guildId, text);
    const row = await this.db.postUserGroupMessage(
      {
        guildId,
        content: text,
        taggedNames: tags.names,
        taggedAgentIds: tags.agentIds,
        taggedUserIds: tags.userIds,
        authorName: author.name,
        authorUserId: author.id,
      },
      new Date(),
    );
    if (row === null) {
      throw new GroupChatError(404, "guild not found");
    }
    const message = groupMessageItem(row);
    await this._after_commit(guildId, message);
    return message;
  }

  /**
   * Posts an operator message as `author`, then stops the group runs the message targets, so
   * they start again with it in view.
   */
  async postUserInterruption(
    guildId: string,
    content: string,
    author: MessageAuthor,
  ): Promise<GroupMessageView> {
    const message = await this.postUser(guildId, content, author);
    await this._interrupt(guildId, message.tagged_agent_ids);
    return message;
  }

  async postFromRun(
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
    let row: GroupMessageRow | null;
    try {
      row = await this.db.postAgentGroupMessage(
        {
          guildId,
          agentId,
          authorName: agentName,
          sourceRunId: runId,
          content,
          taggedNames: tags.names,
          taggedAgentIds: tags.agentIds,
          taggedUserIds: tags.userIds,
        },
        new Date(),
      );
    } catch (error) {
      if (error instanceof AgentMessageLimitReached) {
        return limitError(error.limit);
      }
      if (error instanceof GroupChatCleared) {
        return CLEARED_ERROR;
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

  async _interrupt(guildId: string, taggedAgentIds: string[]): Promise<void> {
    const runner = this._runner;
    if (runner === null) {
      return;
    }
    const targets = interruptTargets([...this._active_for(guildId).keys()], taggedAgentIds);
    await Promise.all(targets.map((agentId) => runner.cancelAgentRuns(agentId)));
  }

  async _tags(guildId: string, text: string): Promise<GroupTags> {
    const members = await this.db.listAgents(guildId);
    const guild = await this.db.getGuild(guildId);
    return recognizedTags(text, members, guild ? guild.operators : []);
  }

  async _after_commit(guildId: string, message: Record<string, unknown>): Promise<void> {
    await this.publish(guildId, "group.message.committed", message);
    const state = await this.state(guildId);
    if (state.limit_reached) {
      await this.publish(guildId, "group.limit_reached", state);
    }
    if (state.pending_agent_count === 0) {
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
      // A post that landed while the dispatcher was finishing found it still running.
      if (this._kick(guildId).isSet()) {
        void this.wake(guildId);
      }
    });
  }

  _kick(guildId: string): AsyncEvent {
    let kick = this._kicks.get(guildId);
    if (kick === undefined) {
      kick = new AsyncEvent();
      this._kicks.set(guildId, kick);
    }
    return kick;
  }

  _active_for(guildId: string): Map<string, ActiveDelivery> {
    let active = this._active.get(guildId);
    if (active === undefined) {
      active = new Map();
      this._active.set(guildId, active);
    }
    return active;
  }

  async _recipients(
    guildId: string,
    pending: PendingAgent[],
    snapshot: number,
  ): Promise<RecipientPick> {
    if (
      this._recipientCache &&
      this._recipientCache.guildId === guildId &&
      this._recipientCache.snapshot === snapshot
    ) {
      this.lastRecipientDecision = this._recipientCache.decision;
      return { decision: this._recipientCache.decision, tagged: this._recipientCache.tagged };
    }
    const rows = await this.db.listGroupMessages(guildId, { throughSeq: snapshot });
    if (!rows.length) {
      const empty: RecipientDecision = { source: "tags", names: new Set() };
      this.lastRecipientDecision = empty;
      this._recipientCache = { guildId, snapshot, decision: empty, tagged: new Set() };
      return { decision: empty, tagged: new Set() };
    }
    const members = await this.db.listAgents(guildId);
    const tagged = new Set<string>();
    const fanout = new Set<string>();
    for (const agent of pending) {
      const name = agent.name;
      const deliveredThrough = agent.group_chat_delivered_through;
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
    this._recipientCache = { guildId, snapshot, decision, tagged };
    // A `none` verdict creates no run, so this line is its only trace.
    const summary = serializeRecipientDecision(decision);
    writeLog(
      "info",
      `group recipients through ${snapshot}: source=${decision.source} choice=${decision.choice ?? "-"}` +
        ` confidence=${decision.confidence === undefined ? "-" : decision.confidence.toFixed(3)}` +
        ` names=${JSON.stringify(summary.names)}`,
      { guild_id: guildId, operation: "group.recipients" },
    );
    return { decision, tagged };
  }

  /**
   * Starts a run for every pending agent that may start now, and waits until something changes:
   * a post, a run ending, or a busy agent coming free. Each agent has at most one group run.
   */
  async _dispatch(guildId: string): Promise<void> {
    const current = this._dispatch_tasks.get(guildId);
    try {
      let more = true;
      while (more && !this._is_deleting(guildId) && this._runner !== null) {
        more = await this._dispatch_step(guildId, this._runner);
      }
      await this.publish(guildId, "group.idle", await this.state(guildId));
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
      await Promise.allSettled([...this._active_for(guildId).values()].map((item) => item.task));
      this._active.delete(guildId);
      if (this._dispatch_tasks.get(guildId) === current) {
        this._dispatch_tasks.delete(guildId);
      }
    }
  }

  /** One pass of the dispatcher; false once nothing is pending, under way, or waiting on a lock. */
  async _dispatch_step(guildId: string, runner: GroupRunner): Promise<boolean> {
    const kick = this._kick(guildId);
    kick.clear();
    const seen = runner.lockGeneration;
    const active = this._active_for(guildId);
    const snapshot = (await this.state(guildId)).chat_seq;
    const pending = withActiveCursors(
      await this.db.listPendingGroupAgents(guildId, snapshot),
      active,
      snapshot,
    );
    const plan = pending.length
      ? await this._plan(guildId, pending, snapshot, runner)
      : { start: [], waitsForRelease: false, pick: null };
    for (const agent of plan.start) {
      this._start_delivery(guildId, agent, { snapshot, pick: plan.pick });
    }
    if (!active.size && !plan.waitsForRelease) {
      return false;
    }
    const release = plan.waitsForRelease ? [runner.waitForLockRelease(seen)] : [];
    await Promise.race([kick.wait(), ...release]);
    return true;
  }

  /** Moves agents no unseen message picks past the snapshot, and says which picked ones start. */
  async _plan(
    guildId: string,
    pending: PendingAgent[],
    snapshot: number,
    runner: GroupRunner,
  ): Promise<{
    start: PendingAgent[];
    waitsForRelease: boolean;
    pick: RecipientPick;
  }> {
    const pick = await this._recipients(guildId, pending, snapshot);
    const actionable = pending.filter((agent) => pick.decision.names.has(agent.name));
    for (const agent of pending) {
      if (!pick.decision.names.has(agent.name)) {
        await this.db.advanceGroupCursor(agent.id, snapshot);
      }
    }
    const plan = deliveriesToStart({
      actionable,
      tagged: pick.tagged,
      active: this._active_for(guildId),
      isBusy: (agentId) => runner.isAgentBusy(agentId),
    });
    return { ...plan, pick };
  }

  _start_delivery(
    guildId: string,
    agent: PendingAgent,
    through: { snapshot: number; pick: RecipientPick | null },
  ): void {
    const active = this._active_for(guildId);
    const delivery: ActiveDelivery = {
      id: agent.id,
      name: agent.name,
      throughSeq: through.snapshot,
    };
    active.set(delivery.id, delivery);
    const recipients = through.pick ? serializeRecipientDecision(through.pick.decision) : null;
    delivery.task = this._deliver(guildId, {
      agentId: delivery.id,
      throughSeq: through.snapshot,
      deliveredThrough: agent.group_chat_delivered_through,
      recipients,
    }).finally(() => {
      active.delete(delivery.id);
      this._kick(guildId).set();
    });
  }

  async _deliver(guildId: string, delivery: GroupDelivery): Promise<void> {
    const runner = this._runner;
    if (runner === null) {
      return;
    }
    const active = this._active_for(guildId).get(delivery.agentId);
    await this.publish(guildId, "group.delivery.started", {
      agent_id: delivery.agentId,
      agent_name: active?.name ?? null,
      through_seq: delivery.throughSeq,
    });
    const seen = runner.lockGeneration;
    try {
      await runner.deliverGroupRun(delivery);
      await this.db.advanceGroupCursor(delivery.agentId, delivery.throughSeq);
      await this.publish(guildId, "group.delivery.finished", {
        agent_id: delivery.agentId,
        through_seq: delivery.throughSeq,
      });
    } catch (error) {
      await this._delivery_error(guildId, delivery, { error, seen });
    }
  }

  /** A busy agent waits for a lock to come free; any other failure is recorded and moves on. */
  async _delivery_error(
    guildId: string,
    delivery: GroupDelivery,
    failure: { error: unknown; seen: number },
  ): Promise<void> {
    const { error, seen } = failure;
    if (error instanceof DeliveryBusyError) {
      await this._runner?.waitForLockRelease(seen);
      return;
    }
    if (!(error instanceof DeliveryCreateError)) {
      writeLog(
        "error",
        "group delivery failed",
        {
          guild_id: guildId,
          agent_id: delivery.agentId,
          operation: "group.delivery",
          error_type: error instanceof Error ? error.name : "Error",
        },
        error,
      );
    }
    await this._delivery_failed(guildId, delivery.agentId, delivery.throughSeq, error);
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

  _state_view(row: GroupChatStateRow): GroupChatView {
    const count = row.agent_message_count;
    const limit = row.agent_message_limit;
    const guildId = row.guild_id;
    const active = [...(this._active.get(guildId)?.values() ?? [])];
    return {
      guild_id: guildId,
      chat_seq: row.chat_seq,
      agent_message_count: count,
      agent_message_limit: limit,
      dispatching: this.isDispatching(guildId),
      pending_agent_count: row.pending_agent_count,
      active_agents: active.map((delivery) => ({ id: delivery.id, name: delivery.name })),
      limit_reached: count >= limit,
      errors: row.errors,
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

/** The group chats of guilds, read and written on `db` and run with `services`. */
export function guildGroupChat(db: Queryable, services: GroupChatServices): GroupChat {
  return new GroupChat(groupChatDatabase(db), services);
}
