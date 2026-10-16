import type { Repositories } from "../db/repositories.js";
import { jsonObj } from "../db/json.js";
import { iso } from "../db/views.js";
import { rowDescription } from "../schedules/item.js";
import { describeTiming, rowTiming } from "../schedules/timing.js";
import { StudioUnprocessableError } from "./errors.js";

// The guild activity ledger: one row per wake (a run of any kind) with what
// started it, how it was routed, the tools it called, and what it produced,
// plus the public rows those wakes answered and posted. Read-only over runs,
// messages, group_messages, file_changes, and schedules.

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

export type ActivityAgent = {
  id: string;
  name: string;
  avatar_color: string;
  avatar_shape: string;
  archived: boolean;
};

// `label` is the timing in words; `instruction` is what each firing tells the agent.
export type ActivityRoutine = { id: string; agent_id: string; description: string; label: string; instruction: string };

export type ActivityMessage = {
  seq: number;
  created_at: string;
  author_type: "user" | "agent";
  author_name: string;
  author_agent_id: string | null;
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

export type ActivityTrigger =
  | {
      type: "message";
      seq: number | null;
      through_seq: number | null;
      reason: ActivityTriggerReason;
      routing: ActivityRouting | null;
    }
  | { type: "routine"; schedule_id: string | null }
  | { type: "direct" };

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
  agents: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  stats: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  posts: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  openings: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
  generating: (runId: string) => boolean;
};

// `hours` back from `until` (default now, never later than now).
export function activityWindow(query: { hours?: unknown; until?: unknown }, now: Date): ActivityWindow {
  const rawHours = query.hours === undefined || query.hours === "" ? ACTIVITY_DEFAULT_HOURS : Number(query.hours);
  if (!Number.isFinite(rawHours) || rawHours <= 0) {
    throw new StudioUnprocessableError("hours must be a positive number");
  }
  const hours = Math.min(rawHours, ACTIVITY_MAX_HOURS);
  let until = now;
  if (query.until !== undefined && query.until !== "") {
    const parsed = new Date(String(query.until));
    if (Number.isNaN(parsed.getTime())) {
      throw new StudioUnprocessableError("until must be an ISO timestamp");
    }
    until = parsed.getTime() > now.getTime() ? now : parsed;
  }
  return { since: new Date(until.getTime() - hours * 3_600_000), until };
}

function ms(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isNaN(time) ? null : time;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function obj(value: unknown): Record<string, unknown> {
  const parsed = jsonObj(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  const parsed = jsonObj(value);
  return Array.isArray(parsed) ? parsed : [];
}

function names(value: unknown): string[] {
  return list(value).map((item) => String(item));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
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
export function groupPostSeq(content: unknown): number | null {
  const match = typeof content === "string" ? /\bseq=(\d+)/.exec(content) : null;
  return match ? Number(match[1]) : null;
}

function routingOf(runMetadata: Record<string, unknown>): ActivityRouting | null {
  const recipients = obj(obj(runMetadata.typesafe).recipients);
  const source = text(recipients.source);
  if (!source) {
    return null;
  }
  return {
    source,
    choice: text(recipients.choice),
    confidence: num(recipients.confidence),
  };
}

function agentTags(message: Record<string, unknown> | undefined): string[] {
  return message ? names(message.tagged_names).filter((name) => name !== "user") : [];
}

// The public row that woke a group run. A tag always selects its target, so a
// tagged agent woke on the latest row that tags it; an untagged operator row
// wakes every member; otherwise the snapshot's latest row decided it.
function messageTrigger(
  run: Record<string, unknown>,
  agentName: string,
  delivery: Record<string, unknown>,
  messagesBySeq: Map<number, Record<string, unknown>>,
): ActivityTrigger {
  const throughSeq = num(run.group_chat_through_seq);
  const previousSeq = num(run.previous_through_seq) ?? 0;
  const routing = routingOf(obj(run.metadata));
  const tagged = delivery.you_were_tagged === true;
  let reason: ActivityTriggerReason;
  if (tagged) {
    reason = "tag";
  } else if (routing?.source === "typesafe" && routing.choice === agentName) {
    reason = "jev";
  } else if (routing?.source === "fallback") {
    reason = "fallback";
  } else {
    reason = "rules";
  }
  let seq = throughSeq;
  if (throughSeq !== null && (reason === "tag" || reason === "rules")) {
    const floor = Math.max(previousSeq, throughSeq - TRIGGER_SCAN_MAX);
    for (let candidate = throughSeq; candidate > floor; candidate -= 1) {
      const message = messagesBySeq.get(candidate);
      if (!message) {
        continue;
      }
      const tags = agentTags(message);
      const wakes = reason === "tag" ? tags.includes(agentName) : message.author_type === "user" && tags.length === 0;
      if (wakes) {
        seq = candidate;
        break;
      }
    }
  }
  return { type: "message", seq, through_seq: throughSeq, reason, routing };
}

function errorsOf(value: unknown, sinceMs: number): ActivityError[] {
  const out: ActivityError[] = [];
  for (const entry of list(value)) {
    const row = obj(entry);
    const at = text(row.at);
    const atMs = ms(at);
    if (atMs !== null && atMs < sinceMs) {
      continue;
    }
    out.push({ operation: text(row.operation), message: text(row.message), at });
  }
  return out;
}

type WakeSteps = { calls: ActivityToolCall[]; count: number; reply: string | null };

// Each run's tool calls in order, paired with their results, and its last text.
function stepsByRun(rows: Array<Record<string, unknown>>): Map<string, WakeSteps> {
  const resultKey = (runId: unknown, callId: unknown) => `${String(runId)}\u0000${String(callId)}`;
  const results = new Map<string, Record<string, unknown>>();
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
    const runId = String(row.run_id);
    const steps = byRun.get(runId) ?? { calls: [], count: 0, reply: null };
    for (const entry of list(row.tool_calls)) {
      const call = obj(entry);
      const fn = obj(call.function);
      const callId = text(call.id);
      steps.count += 1;
      if (steps.calls.length >= ACTIVITY_TOOL_CALLS_MAX) {
        continue;
      }
      const result = callId ? results.get(resultKey(runId, callId)) : undefined;
      const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      steps.calls.push({
        call_id: callId,
        name: String(fn.name ?? ""),
        arguments: preview(args, ACTIVITY_ARGUMENT_CHARS),
        error: text(result?.error),
        duration_ms: num(result?.duration_ms),
        at: iso(row.created_at),
      });
    }
    const said = typeof row.text === "string" ? row.text.trim() : "";
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
  const agentsById = new Map(input.agents.map((agent) => [String(agent.id), agent]));
  const statsByRun = new Map(input.stats.map((row) => [String(row.run_id), row]));
  const deliveryByRun = new Map(input.deliveries.map((row) => [String(row.run_id), obj(row.metadata)]));
  const messagesBySeq = new Map<number, Record<string, unknown>>();
  for (const message of input.messages) {
    const seq = num(message.seq);
    if (seq !== null) {
      messagesBySeq.set(seq, message);
    }
  }

  const postsByRun = new Map<string, ActivityWake["posts"]>();
  for (const row of input.posts) {
    const seq = groupPostSeq(row.content);
    const atMs = ms(row.created_at);
    if (seq === null || atMs === null || atMs < sinceMs) {
      continue;
    }
    const runId = String(row.run_id);
    const posts = postsByRun.get(runId) ?? [];
    posts.push({ seq, call_id: text(row.call_id), at: iso(row.created_at) });
    postsByRun.set(runId, posts);
  }

  const writesByRun = new Map<string, ActivityWrite[]>();
  for (const row of input.changes) {
    const atMs = ms(row.created_at);
    if (atMs === null || atMs < sinceMs) {
      continue;
    }
    const runId = String(row.run_id);
    const displayPath = String(row.display_path);
    const toolName = text(row.tool_name);
    const { kind, target } = classifyWrite(displayPath, toolName);
    const writes = writesByRun.get(runId) ?? [];
    writes.push({
      kind,
      target,
      display_path: displayPath,
      operation: String(row.operation),
      tool_name: toolName,
      call_id: text(row.tool_call_id),
      at: iso(row.created_at),
    });
    writesByRun.set(runId, writes);
  }

  const stepsOf = stepsByRun(input.steps);
  const openingByRun = new Map<string, string>();
  for (const row of input.openings) {
    const said = typeof row.text === "string" ? row.text.trim() : "";
    if (said) {
      openingByRun.set(String(row.run_id), preview(said, ACTIVITY_PREVIEW_CHARS));
    }
  }

  const wakes: ActivityWake[] = [];
  for (const run of input.runs) {
    const runId = String(run.id);
    const agentId = String(run.agent_id);
    const agent = agentsById.get(agentId);
    const kind = run.kind === "group" || run.kind === "schedule" ? run.kind : "direct";
    const stats = statsByRun.get(runId);
    const running = input.generating(runId);
    const firstAt = stats?.first_at ?? null;
    if (kind === "direct" && firstAt === null && !running) {
      // A direct chat whose only activity predates the window.
      continue;
    }
    const startedAt = kind === "direct" && firstAt !== null ? iso(firstAt) : iso(run.created_at);
    const lastAt = stats?.last_at ?? run.updated_at ?? run.created_at;
    const endedAt = running ? nowIso : iso(lastAt);
    let trigger: ActivityTrigger;
    if (kind === "group") {
      trigger = messageTrigger(run, String(agent?.name ?? ""), deliveryByRun.get(runId) ?? {}, messagesBySeq);
    } else if (kind === "schedule") {
      trigger = { type: "routine", schedule_id: text(run.schedule_id) };
    } else {
      trigger = { type: "direct" };
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
      last_seq: num(stats?.last_seq),
      cost_usd: num(stats?.cost_usd) ?? 0,
    });
  }
  wakes.sort((left, right) => (ms(left.started_at) ?? 0) - (ms(right.started_at) ?? 0));

  const messages: ActivityMessage[] = input.messages.map((row) => {
    const content = String(row.content ?? "");
    return {
      seq: Number(row.seq),
      created_at: iso(row.created_at),
      author_type: row.author_type === "user" ? "user" : "agent",
      author_name: String(row.author_name ?? ""),
      author_agent_id: text(row.author_agent_id),
      source_run_id: text(row.source_run_id),
      tagged: names(row.tagged_names),
      preview: preview(content, ACTIVITY_PREVIEW_CHARS),
      length: content.length,
    };
  });

  return {
    guild_id: input.guildId,
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    agents: input.agents.map((agent) => ({
      id: String(agent.id),
      name: String(agent.name),
      avatar_color: String(agent.avatar_color ?? ""),
      avatar_shape: String(agent.avatar_shape ?? ""),
      archived: agent.archived_at !== null && agent.archived_at !== undefined,
    })),
    routines: input.schedules.map((row) => ({
      id: String(row.id),
      agent_id: String(row.agent_id),
      description: rowDescription(row),
      label: describeTiming(rowTiming(row)),
      instruction: String(row.instruction ?? ""),
    })),
    messages,
    wakes,
  };
}

/** A coding wake's repositories with changes, from `metadata.repos`, as writes of kind `code`. */
function codeWrites(run: Record<string, unknown>, at: string): ActivityWrite[] {
  const repos = obj(run.metadata).repos;
  if (!Array.isArray(repos)) {
    return [];
  }
  return repos.flatMap((raw) => {
    const repo = obj(raw);
    const files = num(repo.files_changed) ?? 0;
    if (!files || typeof repo.name !== "string") {
      return [];
    }
    return [
      {
        kind: "code" as const,
        target: repo.name,
        display_path: `repos/${repo.name}`,
        operation: "change",
        tool_name: null,
        call_id: null,
        at,
        code: {
          branch: text(repo.branch),
          files_changed: files,
          insertions: num(repo.insertions) ?? 0,
          deletions: num(repo.deletions) ?? 0,
        },
      },
    ];
  });
}

export async function loadGuildActivity(
  repo: Repositories,
  guildId: string,
  window: ActivityWindow & { now?: Date; generating?: (runId: string) => boolean },
): Promise<ActivityView> {
  const { since, until } = window;
  const [agents, runs, schedules] = await Promise.all([
    repo.listAgents(guildId),
    repo.listGuildActivityRuns(guildId, since, until),
    repo.listSchedulesForGuild(guildId),
  ]);
  const runIds = runs.map((run) => String(run.id));
  const groupRunIds = runs.filter((run) => run.kind === "group").map((run) => String(run.id));
  const directRunIds = runs.filter((run) => run.kind === "direct").map((run) => String(run.id));
  let afterSeq: number | null = null;
  for (const run of runs) {
    const throughSeq = num(run.group_chat_through_seq);
    if (run.kind !== "group" || throughSeq === null) {
      continue;
    }
    const floor = Math.max(num(run.previous_through_seq) ?? 0, throughSeq - TRIGGER_SCAN_MAX);
    afterSeq = afterSeq === null ? floor : Math.min(afterSeq, floor);
  }
  const [stats, deliveries, posts, changes, steps, openings, messages] = await Promise.all([
    repo.listRunActivityStats(runIds, since),
    repo.listRunGroupDeliveries(groupRunIds),
    repo.listRunGroupPosts(runIds),
    repo.listRunFileChanges(runIds),
    repo.listRunActivitySteps(runIds, since),
    repo.listRunOpenings(directRunIds, since),
    repo.listGroupMessagesForActivity(guildId, since, until, afterSeq),
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
