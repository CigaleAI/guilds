import { Type, type Static } from "@sinclair/typebox";
import type { ScheduleRow } from "../db/schedules.js";
import { iso } from "../db/views.js";
import { rowDescription } from "../schedules/item.js";
import { describeTiming, rowTiming } from "../schedules/timing.js";
import { StudioUnprocessableError } from "./errors.js";
import { listAgents, type AgentSummaryRow } from "../db/agents.js";
import {
  listGuildActivityRuns,
  listRunActivityStats,
  listRunActivitySteps,
  listRunFileChanges,
  listRunGroupDeliveries,
  listRunGroupPosts,
  listRunOpenings,
  type GuildActivityRunRow,
  type RunActivityStatsRow,
  type RunActivityStepRow,
  type RunFileChangeRow,
  type RunGroupDeliveryRow,
  type RunGroupPostRow,
  type RunOpeningRow,
} from "../db/activity.js";
import type { RunError, RunMetadata } from "../db/schema/index.js";
import { listSchedulesForGuild } from "../db/schedules.js";
import type { MessageMetadata } from "../db/schema/index.js";
import { listGroupMessagesForActivity, type ActivityGroupMessageRow } from "../db/group-chat.js";
import type { Queryable } from "../db/pg.js";

// The guild activity ledger: one row per wake (a run of any kind) with what
// started it, how it was routed, the tools it called, and what it produced,
// plus the public rows those wakes answered and posted. Read-only over runs,
// messages, group_messages, file_changes, and schedules. A run stores the
// public row that woke it; a run without one has its row inferred from tags.

export const ACTIVITY_DEFAULT_HOURS = 24;
export const ACTIVITY_MAX_HOURS = 24 * 7;
// Enough of a public row to recognise it; the chat keeps the full text.
export const ACTIVITY_PREVIEW_CHARS = 400;
// Enough of a tool call's arguments to recognise it; the run keeps them all.
export const ACTIVITY_ARGUMENT_CHARS = 160;
// A wake lists at most this many tool calls; `tool_call_count` counts them all.
export const ACTIVITY_TOOL_CALLS_MAX = 200;
// A tag search walks back at most this many sequences from the snapshot.
const TRIGGER_SCAN_MAX = 500;

export type ActivityWindow = { since: Date; until: Date };

/** The window a guild's activity is read over, the time it counts as now, and which runs are still generating. */
export type GuildActivityWindow = ActivityWindow & { now?: Date; generating?: (runId: string) => boolean };

export type ActivityAgent = Pick<AgentSummaryRow, "id" | "name" | "avatar_color" | "avatar_shape">;

// `label` is the timing in words; `instruction` is what each firing tells the agent.
export type ActivityRoutine = { id: string; agent_id: string; description: string; label: string; instruction: string };

export type ActivityMessage = {
  seq: number;
  created_at: string;
  author_type: "user" | "agent";
  author_name: string;
  author_agent_id: string | null;
  // The person who posted an operator row; null for an agent's row.
  author_user_id: string | null;
  source_run_id: string | null;
  tagged: string[];
  preview: string;
  length: number;
};

export type ActivityRouting = {
  source: string;
  choice: string | null;
  confidence: number | null;
};

export type ActivityTriggerReason = "tag" | "jev" | "rules" | "fallback";

// `inferred` is true when the run stored no waking row and `seq` comes from a tag scan.
export type ActivityTrigger =
  | {
      type: "message";
      seq: number | null;
      through_seq: number | null;
      reason: ActivityTriggerReason;
      routing: ActivityRouting | null;
      inferred: boolean;
    }
  | { type: "routine"; schedule_id: string | null }
  | { type: "direct"; user_id: string | null };

export type ActivityWriteKind = "record" | "note" | "script" | "memory" | "code";

/** What a coding wake changed in one repository, between its checkpoints. */
export type ActivityCodeChange = {
  branch: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
};

export type ActivityWrite = {
  kind: ActivityWriteKind;
  target: string;
  display_path: string;
  operation: string;
  tool_name: string | null;
  call_id: string | null;
  at: string;
  code?: ActivityCodeChange;
};

export type ActivityError = { operation: string | null; message: string | null; at: string | null };

// One tool call a wake made inside the window, with its result's error and duration.
export type ActivityToolCall = {
  call_id: string | null;
  name: string;
  arguments: string;
  error: string | null;
  duration_ms: number | null;
  at: string;
};

export type ActivityWake = {
  run_id: string;
  agent_id: string;
  kind: "group" | "schedule" | "direct";
  started_at: string;
  ended_at: string;
  running: boolean;
  trigger: ActivityTrigger;
  outcome: "posted" | "wrote" | "silent";
  failed: boolean;
  errors: ActivityError[];
  posts: Array<{ seq: number; call_id: string | null; at: string }>;
  writes: ActivityWrite[];
  tool_calls: ActivityToolCall[];
  tool_call_count: number;
  // The last text the agent wrote inside the window.
  reply: string | null;
  // A direct chat's first operator message inside the window.
  opening: string | null;
  last_seq: number | null;
  cost_usd: number;
};

export type ActivityView = {
  guild_id: string;
  since: string;
  until: string;
  agents: ActivityAgent[];
  routines: ActivityRoutine[];
  messages: ActivityMessage[];
  wakes: ActivityWake[];
};

export type ActivityInput = {
  guildId: string;
  since: Date;
  until: Date;
  now: Date;
  agents: ActivityAgent[];
  runs: GuildActivityRunRow[];
  stats: RunActivityStatsRow[];
  deliveries: RunGroupDeliveryRow[];
  posts: RunGroupPostRow[];
  changes: RunFileChangeRow[];
  steps: RunActivityStepRow[];
  openings: RunOpeningRow[];
  messages: ActivityGroupMessageRow[];
  schedules: ScheduleRow[];
  generating: (runId: string) => boolean;
};

/** The window a Studio query asks for: how many hours back, and until when, both as query text. */
export const ActivityWindowQuerySchema = Type.Object({
  hours: Type.Optional(Type.String()),
  until: Type.Optional(Type.String()),
});

export type ActivityWindowQuery = Static<typeof ActivityWindowQuerySchema>;

// `hours` back from `until` (default now, never later than now).
export function activityWindow(query: ActivityWindowQuery, now: Date): ActivityWindow {
  const rawHours = query.hours === undefined || query.hours === "" ? ACTIVITY_DEFAULT_HOURS : Number(query.hours);
  if (!Number.isFinite(rawHours) || rawHours <= 0) {
    throw new StudioUnprocessableError("hours must be a positive number");
  }
  const hours = Math.min(rawHours, ACTIVITY_MAX_HOURS);
  let until = now;
  if (query.until !== undefined && query.until !== "") {
    const parsed = new Date(query.until);
    if (Number.isNaN(parsed.getTime())) {
      throw new StudioUnprocessableError("until must be an ISO timestamp");
    }
    until = parsed.getTime() > now.getTime() ? now : parsed;
  }
  return { since: new Date(until.getTime() - hours * 3_600_000), until };
}

/** The `hours` up to now, as a query names them; the default window when it names none. */
export function hoursWindow(hours: string | undefined, now: Date): ActivityWindow {
  return activityWindow(hours === undefined ? {} : { hours }, now);
}

/** A stored timestamp as milliseconds, or null when it is not a time. */
function ms(value: string): number | null {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** A numeric column the driver returns as text, as a number, or null when it holds none. */
function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function preview(content: string, chars: number): string {
  return content.length > chars ? `${content.slice(0, chars).trimEnd()}…` : content;
}

// What a file change touched: a collection record, a note, a script, or memory.
export function classifyWrite(displayPath: string, toolName: string | null): { kind: ActivityWriteKind; target: string } {
  const parts = displayPath.split("/");
  const collectionAt = parts.indexOf("collections");
  if (collectionAt >= 0 && parts.length > collectionAt + 1) {
    return { kind: "record", target: parts[collectionAt + 1] ?? displayPath };
  }
  const name = parts[parts.length - 1] || displayPath;
  if (toolName === "memory_write" || name === "memory.md") {
    return { kind: "memory", target: "memory.md" };
  }
  if (parts[parts.length - 2] === "scripts") {
    return { kind: "script", target: name };
  }
  return { kind: "note", target: name };
}

// `group_post` answers "posted id=<id> seq=<seq>".
export function groupPostSeq(content: string | null): number | null {
  const match = content === null ? null : /\bseq=(\d+)/.exec(content);
  return match ? Number(match[1]) : null;
}

function routingOf(runMetadata: RunMetadata): ActivityRouting | null {
  const recipients = runMetadata.typesafe?.recipients;
  if (!recipients) {
    return null;
  }
  return {
    source: recipients.source,
    choice: recipients.choice ?? null,
    confidence: recipients.confidence ?? null,
  };
}

function agentTags(message: ActivityGroupMessageRow | undefined): string[] {
  return message ? message.tagged_names.filter((name) => name !== "user") : [];
}

function isJevPick(routing: ActivityRouting | null, agentName: string): boolean {
  return routing?.source === "typesafe" && routing.choice === agentName;
}

function triggerReason(tagged: boolean, routing: ActivityRouting | null, agentName: string): ActivityTriggerReason {
  if (tagged) {
    return "tag";
  }
  if (routing?.source === "fallback") {
    return "fallback";
  }
  return isJevPick(routing, agentName) ? "jev" : "rules";
}

type WakeReason = { reason: ActivityTriggerReason; agentName: string };

// The reasons whose waking row a tag scan finds; the others woke on the snapshot's last row.
const SCANNED_REASONS = new Set<ActivityTriggerReason>(["tag", "rules"]);

function wokeOn(message: ActivityGroupMessageRow | undefined, why: WakeReason): boolean {
  if (!message) {
    return false;
  }
  const tags = agentTags(message);
  return why.reason === "tag" ? tags.includes(why.agentName) : message.author_type === "user" && tags.length === 0;
}

// The lowest sequence a tag scan reaches back to, exclusive.
function scanFloor(run: GuildActivityRunRow, throughSeq: number): number {
  return Math.max(run.previous_through_seq ?? 0, throughSeq - TRIGGER_SCAN_MAX);
}

// The waking row of a run that stored none. A tag always selects its target,
// so a tagged agent woke on the latest row that tags it; an untagged operator
// row wakes every member; otherwise the snapshot's latest row decided it.
function inferWakeSeq(
  run: GuildActivityRunRow,
  why: WakeReason,
  messagesBySeq: Map<number, ActivityGroupMessageRow>,
): number | null {
  const throughSeq = run.group_chat_through_seq;
  if (throughSeq === null || !SCANNED_REASONS.has(why.reason)) {
    return throughSeq;
  }
  const scanned = Array.from({ length: Math.max(0, throughSeq - scanFloor(run, throughSeq)) }, (_, at) => throughSeq - at);
  return scanned.find((seq) => wokeOn(messagesBySeq.get(seq), why)) ?? throughSeq;
}

// The public row that woke a group run: the one the run stored, or for an
// older run the one its tags point to.
function messageTrigger(
  run: GuildActivityRunRow,
  agentName: string,
  delivery: MessageMetadata,
  messagesBySeq: Map<number, ActivityGroupMessageRow>,
): ActivityTrigger {
  const routing = routingOf(run.metadata);
  const reason = triggerReason(delivery.you_were_tagged === true, routing, agentName);
  const stored = run.wake_seq;
  return {
    type: "message",
    seq: stored ?? inferWakeSeq(run, { reason, agentName }, messagesBySeq),
    through_seq: run.group_chat_through_seq,
    reason,
    routing,
    inferred: stored === null,
  };
}

function errorsOf(errors: RunError[], sinceMs: number): ActivityError[] {
  return errors
    .filter((entry) => Date.parse(entry.at) >= sinceMs)
    .map((entry) => ({ operation: entry.operation, message: entry.message, at: entry.at }));
}

type WakeSteps = { calls: ActivityToolCall[]; count: number; reply: string | null };

// Each run's tool calls in order, paired with their results, and its last text.
function stepsByRun(rows: RunActivityStepRow[]): Map<string, WakeSteps> {
  const resultKey = (runId: string, callId: string) => `${runId}\u0000${callId}`;
  const results = new Map<string, RunActivityStepRow>();
  for (const row of rows) {
    if (row.role === "tool" && row.tool_call_id) {
      results.set(resultKey(row.run_id, row.tool_call_id), row);
    }
  }
  const byRun = new Map<string, WakeSteps>();
  for (const row of rows) {
    if (row.role !== "assistant") {
      continue;
    }
    const runId = row.run_id;
    const steps = byRun.get(runId) ?? { calls: [], count: 0, reply: null };
    for (const call of row.tool_calls ?? []) {
      steps.count += 1;
      if (steps.calls.length >= ACTIVITY_TOOL_CALLS_MAX) {
        continue;
      }
      const result = call.id ? results.get(resultKey(runId, call.id)) : undefined;
      steps.calls.push({
        call_id: call.id || null,
        name: call.function.name,
        arguments: preview(call.function.arguments, ACTIVITY_ARGUMENT_CHARS),
        error: result?.error || null,
        duration_ms: num(result?.duration_ms),
        at: iso(row.created_at),
      });
    }
    const said = row.text?.trim() ?? "";
    if (said) {
      steps.reply = preview(said, ACTIVITY_PREVIEW_CHARS);
    }
    byRun.set(runId, steps);
  }
  return byRun;
}

export function projectActivity(input: ActivityInput): ActivityView {
  const sinceMs = input.since.getTime();
  const nowIso = input.now.toISOString();
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const statsByRun = new Map(input.stats.map((row) => [row.run_id, row]));
  const deliveryByRun = new Map(input.deliveries.map((row) => [row.run_id, row.metadata]));
  const messagesBySeq = new Map(input.messages.map((message) => [message.seq, message]));

  const postsByRun = new Map<string, ActivityWake["posts"]>();
  for (const row of input.posts) {
    const seq = groupPostSeq(row.content);
    const atMs = ms(row.created_at);
    if (seq === null || atMs === null || atMs < sinceMs) {
      continue;
    }
    const posts = postsByRun.get(row.run_id) ?? [];
    posts.push({ seq, call_id: row.call_id, at: iso(row.created_at) });
    postsByRun.set(row.run_id, posts);
  }

  const writesByRun = new Map<string, ActivityWrite[]>();
  for (const row of input.changes) {
    const atMs = ms(row.created_at);
    if (row.run_id === null || atMs === null || atMs < sinceMs) {
      continue;
    }
    const toolName = row.tool_name;
    const { kind, target } = classifyWrite(row.display_path, toolName);
    const writes = writesByRun.get(row.run_id) ?? [];
    writes.push({
      kind,
      target,
      display_path: row.display_path,
      operation: row.operation,
      tool_name: toolName,
      call_id: row.tool_call_id,
      at: iso(row.created_at),
    });
    writesByRun.set(row.run_id, writes);
  }

  const stepsOf = stepsByRun(input.steps);
  const openingByRun = new Map<string, string>();
  for (const row of input.openings) {
    const said = row.text?.trim() ?? "";
    if (said) {
      openingByRun.set(row.run_id, preview(said, ACTIVITY_PREVIEW_CHARS));
    }
  }

  const wakes: ActivityWake[] = [];
  for (const run of input.runs) {
    const runId = run.id;
    const agentId = run.agent_id;
    const agent = agentsById.get(agentId);
    const kind = run.kind;
    const stats = statsByRun.get(runId);
    const running = input.generating(runId);
    const firstAt = stats?.first_at ?? null;
    if (kind === "direct" && firstAt === null && !running) {
      // A direct chat whose only activity predates the window.
      continue;
    }
    const startedAt = kind === "direct" && firstAt !== null ? iso(firstAt) : iso(run.created_at);
    const lastAt = stats?.last_at ?? run.updated_at;
    const endedAt = running ? nowIso : iso(lastAt);
    let trigger: ActivityTrigger;
    if (kind === "group") {
      trigger = messageTrigger(run, agent?.name ?? "", deliveryByRun.get(runId) ?? {}, messagesBySeq);
    } else if (kind === "schedule") {
      trigger = { type: "routine", schedule_id: run.schedule_id };
    } else {
      trigger = { type: "direct", user_id: run.started_by_user_id };
    }
    const posts = postsByRun.get(runId) ?? [];
    const writes = [...(writesByRun.get(runId) ?? []), ...codeWrites(run, endedAt)];
    const errors = errorsOf(run.errors, sinceMs);
    const outcome = posts.length ? "posted" : writes.some((write) => write.kind !== "memory") ? "wrote" : "silent";
    const steps = stepsOf.get(runId);
    wakes.push({
      run_id: runId,
      agent_id: agentId,
      kind,
      started_at: startedAt,
      ended_at: endedAt,
      running,
      trigger,
      outcome,
      failed: errors.length > 0,
      errors,
      posts,
      writes,
      tool_calls: steps?.calls ?? [],
      tool_call_count: steps?.count ?? 0,
      reply: steps?.reply ?? null,
      opening: kind === "direct" ? (openingByRun.get(runId) ?? null) : null,
      last_seq: stats?.last_seq ?? null,
      cost_usd: num(stats?.cost_usd) ?? 0,
    });
  }
  wakes.sort((left, right) => (ms(left.started_at) ?? 0) - (ms(right.started_at) ?? 0));

  const messages: ActivityMessage[] = input.messages.map((row) => ({
    seq: row.seq,
    created_at: iso(row.created_at),
    author_type: row.author_type,
    author_name: row.author_name,
    author_agent_id: row.author_agent_id,
    author_user_id: row.author_user_id,
    source_run_id: row.source_run_id,
    tagged: row.tagged_names,
    preview: preview(row.content, ACTIVITY_PREVIEW_CHARS),
    length: row.content.length,
  }));

  return {
    guild_id: input.guildId,
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    agents: input.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      avatar_color: agent.avatar_color,
      avatar_shape: agent.avatar_shape,
    })),
    routines: input.schedules.map((row) => ({
      id: row.id,
      agent_id: row.agent_id,
      description: rowDescription(row),
      label: describeTiming(rowTiming(row)),
      instruction: row.instruction,
    })),
    messages,
    wakes,
  };
}

/** A coding wake's repositories with changes, from `metadata.repos`, as writes of kind `code`. */
function codeWrites(run: GuildActivityRunRow, at: string): ActivityWrite[] {
  return (run.metadata.repos ?? [])
    .filter((repo) => repo.files_changed > 0)
    .map((repo) => ({
      kind: "code" as const,
      target: repo.name,
      display_path: `repos/${repo.name}`,
      operation: "change",
      tool_name: null,
      call_id: null,
      at,
      code: {
        branch: repo.branch,
        files_changed: repo.files_changed,
        insertions: repo.insertions,
        deletions: repo.deletions,
      },
    }));
}

/**
 * The sequence after which a group run's waking row lies: just before the
 * row it stored, or the bottom of its tag scan. Null for any other run.
 */
export function messageFloor(run: GuildActivityRunRow): number | null {
  const throughSeq = run.group_chat_through_seq;
  if (run.kind !== "group" || throughSeq === null) {
    return null;
  }
  const stored = run.wake_seq;
  return stored !== null ? stored - 1 : scanFloor(run, throughSeq);
}

export async function loadGuildActivity(
  db: Queryable,
  guildId: string,
  window: GuildActivityWindow,
): Promise<ActivityView> {
  const { since, until } = window;
  const [agents, runs, schedules] = await Promise.all([
    listAgents(db, guildId),
    listGuildActivityRuns(db, guildId, since, until),
    listSchedulesForGuild(db, guildId),
  ]);
  const runIds = runs.map((run) => run.id);
  const groupRunIds = runs.filter((run) => run.kind === "group").map((run) => run.id);
  const directRunIds = runs.filter((run) => run.kind === "direct").map((run) => run.id);
  const floors = runs.map(messageFloor).filter((floor): floor is number => floor !== null);
  const afterSeq = floors.length ? Math.min(...floors) : null;
  const [stats, deliveries, posts, changes, steps, openings, messages] = await Promise.all([
    listRunActivityStats(db, runIds, since),
    listRunGroupDeliveries(db, groupRunIds),
    listRunGroupPosts(db, runIds),
    listRunFileChanges(db, runIds),
    listRunActivitySteps(db, runIds, since),
    listRunOpenings(db, directRunIds, since),
    listGroupMessagesForActivity(db, guildId, { since, until, afterSeq }),
  ]);
  return projectActivity({
    guildId,
    since,
    until,
    now: window.now ?? new Date(),
    agents,
    runs,
    stats,
    deliveries,
    posts,
    changes,
    steps,
    openings,
    messages,
    schedules,
    generating: window.generating ?? (() => false),
  });
}
