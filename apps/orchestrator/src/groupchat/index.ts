import { jsonObj } from "../db/json.js";
import { AgentMessageLimitReached, GroupChatCleared } from "../db/errors.js";
import { groupMessageItem } from "../db/views.js";
import { AsyncEvent, EventQueue } from "../lib/event.js";
import { writeLog } from "../observability/log.js";
import {
  defaultGroupRouter,
  serializeRecipientDecision,
  type GroupRouter,
  type RecipientDecision,
} from "../typesafe/index.js";
import { groupChatHistory, storedTags } from "./history.js";
import { advanceGroupCursor,
  appendGroupChatError,
  clearGroupMessages,
  getGroupChatState,
  listGroupMessages,
  listPendingGroupAgents,
  postAgentGroupMessage,
  postUserGroupMessage,
  updateGroupAgentMessageLimit, type GroupChatStateRow, type GroupMessageRow, type PendingGroupAgentRow } from "../db/group-chat.js";
import { getGuild, listGuilds, type GuildOperatorRow } from "../db/guilds.js";
import { getAgent, listAgents } from "../db/agents.js";
import { getRun, type RunMessage } from "../db/runs.js";
import type { RecipientRouting, UserMessage } from "../db/schema/index.js";
import { bindQuery, type Queryable } from "../db/pg.js";

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

export const CLEARED_ERROR =
  "ERROR: the group chat was cleared after this run started; nothing was posted";

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
  operators: GuildOperatorRow[] = [],
): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    names.add(String(member.name));
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
  operators: GuildOperatorRow[] = [],
): GroupTags {
  const names = parseTags(content, taggableNames(members, operators));
  const agentIdsByName = new Map<string, string>();
  for (const member of members) {
    agentIdsByName.set(String(member.name), String(member.id));
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
    membersById.set(String(member.id), String(member.name));
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
    membersById.set(String(member.id), String(member.name));
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

function tagsAgent(row: Record<string, unknown>, agentId: string): boolean {
  const selfTag = row.author_type === "agent" && row.author_agent_id === agentId;
  return !selfTag && storedTagAgentIds(row).includes(agentId);
}

/**
 * The public row that woke an agent's group run: the latest row after its
 * cursor that tags it, else the latest operator row that tags no agent, else
 * the latest row after its cursor. Null when no row is after the cursor.
 */
export function wakeMessage(
  rows: Array<Record<string, unknown>>,
  agentId: string,
  deliveredThrough: number,
): Record<string, unknown> | null {
  const unseen = rows.filter((row) => Number(row.seq) > deliveredThrough);
  const tagging = unseen.filter((row) => tagsAgent(row, agentId));
  const broadcast = unseen.filter((row) => row.author_type === "user" && !storedTagAgentIds(row).length);
  return tagging.at(-1) ?? broadcast.at(-1) ?? unseen.at(-1) ?? null;
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
  rows: GroupMessageRow[];
  viewerName?: string;
  deliveredThrough?: number;
}): RunMessage {
  const viewerName = args.viewerName ?? "";
  const deliveredThrough = args.deliveredThrough ?? 0;
  const history = groupChatHistory(args.rows);
  const latest = history.length ? history[history.length - 1] : null;
  const info = {
    latestMessage: latest,
    youWereTagged: viewerWasTagged(args.rows, viewerName, deliveredThrough),
  };
  const payload: UserMessage = {
    role: "user",
    content: `Group Chat info: ${JSON.stringify(info, null, 2)}`,
  };
  const last = args.rows.at(-1);
  if (last === undefined) {
    return [payload, { source: "group_chat" }];
  }
  return [
    payload,
    {
      source: "group_chat",
      group_message_id: last.id,
      group_seq: last.seq,
      author_type: last.author_type,
      author_name: last.author_name,
      tagged: latest ? latest.tagged : [],
      you_were_tagged: info.youWereTagged,
      recipients: [...recipientNamesAfter(args.rows, args.members, deliveredThrough)].sort(),
    },
  ];
}

/** The db/ functions a guild's group chat is read and written through, on `db`. */
export function groupChatDatabase(db: Queryable) {
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

type RecipientPick = { decision: RecipientDecision; tagged: Set<string> };

type DispatchHandle = {
  promise: Promise<void>;
  done(): boolean;
};

/** A pending agent as the dispatcher reads it: who it is, and how far it has seen the chat. */
type PendingAgent = Pick<PendingGroupAgentRow, "id" | "name" | "group_chat_delivered_through">;

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
    if (this.is_dispatching(guildId)) {
      this._kick(guildId).set();
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

  /** Deletes the guild's public messages for everyone and tells open chats. */
  async clear(guildId: string): Promise<Record<string, unknown>> {
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

  /**
   * Posts an operator message. With `interrupt`, it then stops the group runs the message
   * targets, so they start again with it in view.
   */
  async post_user(
    guildId: string,
    content: string,
    options: { author_name?: string; author_user_id?: string; interrupt?: boolean } = {},
  ): Promise<Record<string, unknown>> {
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
        authorName: options.author_name ?? "user",
        authorUserId: options.author_user_id ?? null,
      },
      new Date(),
    );
    if (row === null) {
      throw new GroupChatError(404, "guild not found");
    }
    const message = groupMessageItem(row);
    await this._after_commit(guildId, message);
    if (options.interrupt) {
      await this._interrupt(guildId, tags.agentIds);
    }
    return message;
  }

  async postUser(
    guildId: string,
    content: string,
    options: { author_name?: string; author_user_id?: string; interrupt?: boolean } = {},
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

  async postFromRun(
    runId: string,
    agentId: string,
    guildId: string,
    agentName: string,
    content: string,
  ): Promise<string> {
    return this.post_from_run(runId, agentId, guildId, agentName, content);
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
    const snapshot = Number((await this.state(guildId)).chat_seq);
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

  _state_view(row: GroupChatStateRow): Record<string, unknown> {
    const count = row.agent_message_count;
    const limit = row.agent_message_limit;
    const guildId = row.guild_id;
    const active = [...(this._active.get(guildId)?.values() ?? [])];
    return {
      guild_id: guildId,
      chat_seq: row.chat_seq,
      agent_message_count: count,
      agent_message_limit: limit,
      dispatching: this.is_dispatching(guildId),
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
