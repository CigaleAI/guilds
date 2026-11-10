import { Type, type Static } from "typebox";
import { memoryDiffText, memoryTimeline, type MemoryTimelineEntry } from "../artifacts/memory.js";
import type { EvidenceAttributes } from "../conversation/trust.js";
import { isoOrNull } from "../db/views.js";
import { issueItem, type IssueItem } from "../issues/index.js";
import { scheduleItem, type ScheduleItem } from "../schedules/item.js";
import { ACTIVITY_MAX_HOURS, windowBefore, type ActivityWindow } from "./activity.js";
import { StudioUnprocessableError } from "./errors.js";
import type { StudioReachDeps } from "./reach.js";
import type { AgentRow } from "../db/agents.js";
import { getRun, listMessages, type MessageRow, type RunRow } from "../db/runs.js";
import { getSchedule } from "../db/schedules.js";
import { getIssue } from "../db/issues.js";
import {
  listGuildToolCallStats,
  listGuildToolCalls,
  type GuildToolCallRow,
  type GuildToolCallStatRow,
} from "../db/activity.js";
import type { StudioFocus, ToolCall } from "../db/schema/index.js";
import { studioActor, type StudioOperator } from "./actor.js";
import { findGuildAgent, requireGuildAgent } from "./source-guild.js";
import {
  emptyFocus,
  evidenceBlock,
  excerpt,
  RUN_KIND_LABELS,
  withoutRepeatedBlankLines,
  type ResolvedFocus,
} from "./focus-evidence.js";
import { formatFileFocus, loadFileEvidence } from "./focus-file.js";

// A focus pin names one piece of evidence the operator is asking about: a
// run (optionally one step of it), a memory version, a routine, a file, an
// issue an agent reported, or a tool the guild's agents call.
// The client sends ids; the server loads the evidence they name, checks it
// belongs to the source guild, and formats the focus it stores and the
// evidence block the coach reads.

export const STUDIO_FOCUS_SOURCE = "studio_focus";

/** An id or path a focus pin names; null or left out when it names none. */
const FocusId = Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()]));

/** A step or version a focus pin names, a non-negative integer; null or left out when it names none. */
const FocusIndex = Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]));

/** The evidence an operator pins to a Studio message: its kind and the ids that name it. */
export const StudioFocusRequestSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("run"),
    Type.Literal("memory_version"),
    Type.Literal("routine"),
    Type.Literal("file"),
    Type.Literal("issue"),
    Type.Literal("tool"),
  ]),
  agent_id: FocusId,
  run_id: FocusId,
  seq: FocusIndex,
  call_id: FocusId,
  revision_id: FocusId,
  version_index: FocusIndex,
  schedule_id: FocusId,
  display_path: FocusId,
  change_id: FocusId,
  issue_id: FocusId,
  tool_name: FocusId,
});

export type StudioFocusRequest = Static<typeof StudioFocusRequestSchema>;

/** The agent of the source guild a memory version or routine pin names; refused when the pin names none. */
async function requirePinnedAgent(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
): Promise<AgentRow> {
  if (!input.agent_id) {
    throw new StudioUnprocessableError(`focus ${input.kind} needs an agent_id`);
  }
  return requireGuildAgent(deps.db, operator.sourceGuildId, operator.orgId, input.agent_id);
}

/** Where in a run a focus points: a step by its sequence, or a tool call by its id. */
type RunPoint = { seq: number | null; callId: string | null };

/** A tool call of a run: the assistant message that made it, and the call. */
type CallRequest = { row: MessageRow; call: ToolCall };

/**
 * The messages a run focus names: the call it names, if any, the step or the call's result, and
 * the message that made the call.
 */
export type FocusedMessages = {
  callId: string | null;
  target: MessageRow | undefined;
  request: CallRequest | undefined;
};

/** A run a pin names, the agent that ran it, and the messages of the step or call it points at; null for the whole run. */
export type RunEvidence = { run: RunRow; agent: AgentRow; focused: FocusedMessages | null };

/** The assistant message of `rows` that made the call `callId`, and the call. */
function callRequest(rows: MessageRow[], callId: string): CallRequest | undefined {
  for (const row of rows) {
    const call =
      row.payload.role === "assistant"
        ? row.payload.tool_calls?.find((item) => item.id === callId)
        : undefined;
    if (call) {
      return { row, call };
    }
  }
  return undefined;
}

/**
 * The message a run focus names: by call id, the call's result and the message that made the
 * call, at least one of which must exist; else the message at `seq`.
 */
function focusedMessages(rows: MessageRow[], at: RunPoint): FocusedMessages {
  const { callId } = at;
  if (callId !== null) {
    const target = rows.find(
      (row) => row.payload.role === "tool" && row.payload.tool_call_id === callId,
    );
    const request = callRequest(rows, callId);
    if (!target && !request) {
      throw new StudioUnprocessableError("focus tool call not found in that run");
    }
    return { callId, target, request };
  }
  const target = rows.find((row) => row.seq === at.seq);
  if (!target) {
    throw new StudioUnprocessableError("focus message not found in that run");
  }
  return { callId: null, target, request: undefined };
}

/** The run a pin names, of an agent of the source guild, with the step or call it points at. */
async function loadRunEvidence(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
): Promise<RunEvidence> {
  const run = input.run_id ? await getRun(deps.db, input.run_id) : null;
  if (!run) {
    throw new StudioUnprocessableError("focus run not found");
  }
  const agent = await requireGuildAgent(
    deps.db,
    operator.sourceGuildId,
    operator.orgId,
    run.agent_id,
  );
  const at: RunPoint = { seq: input.seq ?? null, callId: input.call_id ?? null };
  if (at.seq === null && at.callId === null) {
    return { run, agent, focused: null };
  }
  return { run, agent, focused: focusedMessages(await listMessages(deps.db, run.id), at) };
}

/** The tool a focused step names: the call's own name, else the tool its result records. */
function focusedToolName({ target, request }: FocusedMessages): string | null {
  const recorded = target?.payload.role === "tool" ? target.metadata.tool_name : undefined;
  return request?.call.function.name.trim() || recorded?.trim() || null;
}

/** The lines that quote a focused step: the call as it was requested, then the step or the call's result. */
function focusedMessageLines({ target, request }: FocusedMessages): string[] {
  const requested = request
    ? [
        "",
        `Requested at seq ${request.row.seq}: ${request.call.function.name} with arguments`,
        excerpt(request.call.function.arguments),
      ]
    : [];
  if (!target) {
    return requested;
  }
  const { payload, metadata } = target;
  const label =
    payload.role === "tool"
      ? `Tool result at seq ${target.seq}`
      : `${payload.role} message at seq ${target.seq}`;
  return [
    ...requested,
    "",
    `${label}${metadata.error ? ` (error: ${metadata.error})` : ""}:`,
    excerpt(payload.content),
  ];
}

/** A run pin as the coach reads it: the run, its errors, and the step or call it points at. */
export function formatRunFocus({ run, agent, focused }: RunEvidence): ResolvedFocus {
  const kindLabel = RUN_KIND_LABELS[run.kind];
  const createdAt = isoOrNull(run.created_at);
  const coordinates: EvidenceAttributes = {
    run_id: run.id,
    agent_id: agent.id,
    kind: run.kind,
    status: run.status,
    created_at: createdAt,
    schedule_id: run.schedule_id,
    error_count: run.errors.length,
  };
  const lines = [
    `${kindLabel} ${run.id} by ${agent.name} (${run.status})${createdAt ? ` started ${createdAt}` : ""}.`,
    ...(run.errors.length
      ? [
          `Run errors: ${run.errors
            .map((entry) => `${entry.operation}${entry.message ? ` (${entry.message})` : ""}`)
            .join("; ")}.`,
        ]
      : []),
  ];
  const focus: StudioFocus = { ...emptyFocus("run", agent), run_id: run.id };
  if (!focused) {
    return {
      focus: { ...focus, label: `${kindLabel} · ${run.id}` },
      content: evidenceBlock(
        "studio.focus.run",
        coordinates,
        lines.join("\n"),
        `Load the transcript with studio_get_run(run_id="${run.id}").`,
      ),
    };
  }
  const seq = focused.target?.seq ?? focused.request?.row.seq ?? null;
  const toolName = focusedToolName(focused);
  return {
    focus: {
      ...focus,
      seq,
      call_id: focused.callId,
      tool_name: toolName,
      label: `${kindLabel} · ${toolName ? `${toolName} · ` : ""}seq ${String(seq)}`,
    },
    content: evidenceBlock(
      "studio.focus.run",
      { ...coordinates, seq, call_id: focused.callId, tool_name: toolName },
      [...lines, ...focusedMessageLines(focused)].join("\n"),
      `Load the surrounding steps with studio_get_run(run_id="${run.id}", seq_start, seq_end) around seq ${String(seq)}.`,
    ),
  };
}

/** A version of an agent's Memory a pin names, and the agent. */
export type MemoryVersionEvidence = { agent: AgentRow; entry: MemoryTimelineEntry };

/** The version a pin names: by revision id, else by index, else the live one. */
function findEntry(
  entries: MemoryTimelineEntry[],
  input: StudioFocusRequest,
): MemoryTimelineEntry | undefined {
  const revisionId = input.revision_id;
  if (revisionId && revisionId !== "live") {
    return entries.find((entry) => entry.revision_id === revisionId);
  }
  const index = input.version_index ?? null;
  if (index !== null) {
    return entries.find((entry) => entry.index === index);
  }
  return entries.find((entry) => entry.revision_id === null);
}

/** The Memory version a pin names, of an agent of the source guild, as the session's operator reads it. */
async function loadMemoryVersionEvidence(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
): Promise<MemoryVersionEvidence> {
  const agent = await requirePinnedAgent(deps, operator, input);
  const { entries } = await memoryTimeline(
    deps.artifacts,
    studioActor(operator, { agentId: agent.id }),
    agent.id,
  );
  const entry = findEntry(entries, input);
  if (!entry) {
    throw new StudioUnprocessableError("focus memory version not found");
  }
  return { agent, entry };
}

/** What a Memory version changed: its diff from the previous version, or its whole text when it is the oldest. */
function memoryChangeLines(entry: MemoryTimelineEntry): string[] {
  if (entry.previous_content === null) {
    return [
      "This is the oldest version on record; there is no previous version to compare.",
      "",
      "Content:",
      excerpt(entry.content),
    ];
  }
  const diff = memoryDiffText(entry.previous_content, entry.content);
  return [
    `Change versus the previous version: +${entry.stats.added} −${entry.stats.removed} lines.`,
    ...(diff ? ["", "Changes versus the previous version:", excerpt(diff)] : []),
  ];
}

/** A Memory version pin as the coach reads it: who wrote the version, what it changed, and where to load it. */
export function formatMemoryVersionFocus({ agent, entry }: MemoryVersionEvidence): ResolvedFocus {
  const isLive = entry.revision_id === null;
  const writer =
    entry.actor.type === "unknown"
      ? "unknown (oldest archived version)"
      : entry.actor.detail || `${entry.actor.type} ${entry.actor.name ?? ""}`;
  const body = [
    `Memory version ${entry.index} of ${agent.name}${isLive ? " (the live memory)" : ""}.`,
    `Written by: ${writer}${entry.written_at ? ` at ${entry.written_at}` : ""}.`,
    ...memoryChangeLines(entry),
  ];
  const versionRef = entry.revision_id
    ? `revision_id="${entry.revision_id}"`
    : `version_index=${entry.index}`;
  const tail = [
    `Load the full version with studio_get_memory_version(agent_id="${agent.id}", ${versionRef}).`,
    ...(entry.run_id
      ? [
          `The run that wrote it: studio_get_run(run_id="${entry.run_id}", tool_name="memory_write") returns its memory_write call and result.`,
        ]
      : []),
  ].join(" ");
  return {
    focus: {
      ...emptyFocus("memory_version", agent),
      revision_id: entry.revision_id,
      version_index: entry.index,
      run_id: entry.run_id,
      label: `Memory v${entry.index}${isLive ? " (live)" : ""}`,
    },
    content: evidenceBlock(
      "studio.focus.memory_version",
      {
        agent_id: agent.id,
        revision_id: entry.revision_id,
        version_index: entry.index,
        written_at: entry.written_at,
        actor_type: entry.actor.type,
        actor_name: entry.actor.name,
        run_id: entry.run_id,
        archive_display_path: entry.archive_display_path,
      },
      body.join("\n"),
      tail,
    ),
  };
}

/** A routine a pin names, and the agent it wakes. */
export type RoutineEvidence = { agent: AgentRow; routine: ScheduleItem };

/** The routine a pin names, of an agent of the source guild. */
async function loadRoutineEvidence(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
): Promise<RoutineEvidence> {
  const agent = await requirePinnedAgent(deps, operator, input);
  const row = input.schedule_id ? await getSchedule(deps.db, agent.id, input.schedule_id) : null;
  if (!row) {
    throw new StudioUnprocessableError("focus routine not found");
  }
  return { agent, routine: scheduleItem(row) };
}

/** A routine pin as the coach reads it: its timing, its instruction, and where its runs are listed. */
export function formatRoutineFocus({ agent, routine }: RoutineEvidence): ResolvedFocus {
  const timing = routine.cron ? `${routine.cron} (${routine.label})` : routine.label;
  const body = [
    `Routine ${routine.id} of ${agent.name}: ${timing}, ${routine.paused ? "paused" : "active"}.`,
    `Description: ${routine.description}`,
    `Next fire: ${routine.next_run_at}. Last fire: ${routine.last_run_at ?? "never"}.`,
    "",
    "Instruction:",
    excerpt(routine.instruction),
  ];
  return {
    focus: {
      ...emptyFocus("routine", agent),
      schedule_id: routine.id,
      label: `Routine · ${routine.description || routine.label}`,
    },
    content: evidenceBlock(
      "studio.focus.routine",
      {
        schedule_id: routine.id,
        agent_id: agent.id,
        cron: routine.cron,
        window: routine.window ? JSON.stringify(routine.window) : null,
        paused: routine.paused,
        instruction_hash: routine.instruction_hash,
        next_run_at: routine.next_run_at,
        last_run_at: routine.last_run_at,
      },
      body.join("\n"),
      `List the runs this routine produced with studio_list_runs(agent_id="${agent.id}", schedule_id="${routine.id}"), then studio_get_run on one of them.`,
    ),
  };
}

/** An issue a pin names, and its reporting agent while that agent is in the source guild. */
export type IssueEvidence = { issue: IssueItem; agent: AgentRow | null };

/** The issue a pin names, of the source guild, with its reporting agent. */
async function loadIssueEvidence(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
): Promise<IssueEvidence> {
  const row = input.issue_id
    ? await getIssue(deps.db, operator.sourceGuildId, input.issue_id)
    : null;
  if (!row) {
    throw new StudioUnprocessableError("focus issue not found");
  }
  const issue = issueItem(row);
  const agent = issue.agent_id
    ? await findGuildAgent(deps.db, operator.sourceGuildId, operator.orgId, issue.agent_id)
    : null;
  return { issue, agent };
}

/** An issue pin as the coach reads it: the report, and the run that reported it. */
export function formatIssueFocus({ issue, agent }: IssueEvidence): ResolvedFocus {
  const runId = issue.run_id || null;
  const body = withoutRepeatedBlankLines([
    `Issue ${issue.id} reported by ${issue.agent_name} at ${issue.created_at}: ${issue.kind}, severity ${issue.severity}, ${issue.status}.`,
    issue.tool_name ? `Failing tool: ${issue.tool_name}.` : "",
    `Summary: ${issue.summary}`,
    "",
    "Detail:",
    excerpt(issue.detail),
  ]);
  const tail = runId
    ? `The reporting run: studio_get_run(run_id="${runId}", tool_name="report_issue") returns the report; load the steps before it with seq_start and seq_end to find the failure.`
    : "The run that reported this issue no longer exists.";
  return {
    focus: {
      ...emptyFocus("issue", agent),
      agent_name: agent?.name ?? issue.agent_name,
      issue_id: issue.id,
      run_id: runId,
      tool_name: issue.tool_name || null,
      label: `Issue · ${issue.summary}`,
    },
    content: evidenceBlock(
      "studio.focus.issue",
      {
        issue_id: issue.id,
        agent_id: agent?.id ?? null,
        agent_name: issue.agent_name,
        run_id: runId,
        kind: issue.kind,
        severity: issue.severity,
        status: issue.status,
        tool_name: issue.tool_name,
        created_at: issue.created_at,
      },
      body.join("\n"),
      tail,
    ),
  };
}

// A tool name as runs record it: a native, script, or namespaced connection tool.
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
// The latest failed calls a tool pin quotes.
const TOOL_FOCUS_FAILURES = 5;

/** A tool a pin names, how each agent of the guild called it over the window, and its latest failed calls. */
export type ToolEvidence = {
  name: string;
  window: ActivityWindow;
  stats: GuildToolCallStatRow[];
  failures: GuildToolCallRow[];
};

/** How the guild's agents called the tool a pin names over the longest activity window up to `now`. */
async function loadToolEvidence(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
  now: Date,
): Promise<ToolEvidence> {
  const name = input.tool_name;
  if (!name || !TOOL_NAME.test(name)) {
    throw new StudioUnprocessableError("focus tool_name must be a tool name");
  }
  const window = windowBefore(now, ACTIVITY_MAX_HOURS);
  const stats = await listGuildToolCallStats(
    deps.db,
    operator.sourceGuildId,
    window.since,
    window.until,
  );
  const failures = await listGuildToolCalls(deps.db, operator.sourceGuildId, name, {
    ...window,
    errorsOnly: true,
    before: null,
    limit: TOOL_FOCUS_FAILURES,
  });
  return { name, window, stats: stats.filter((stat) => stat.tool_name === name), failures };
}

/** A tool pin as the coach reads it: each agent's calls and failures, and the latest failed calls. */
export function formatToolFocus({ name, window, stats, failures }: ToolEvidence): ResolvedFocus {
  const usage = stats.flatMap((stat) =>
    stat.agent_id === null
      ? []
      : [`- ${stat.agent_id}: ${stat.calls} calls, ${stat.errors} failed`],
  );
  const failureLines = failures.map(
    (row) =>
      `- run ${row.run_id}, call ${row.call_id ?? "?"} (${row.agent_id}): ${excerpt(row.error ?? "")}`,
  );
  const body = [
    `Tool ${name}, called by the guild's agents in the last ${ACTIVITY_MAX_HOURS / 24} days:`,
    ...(usage.length ? usage : ["- no agent called it"]),
    ...(failureLines.length ? ["", "Latest failed calls:", ...failureLines] : []),
  ];
  return {
    focus: { ...emptyFocus("tool", null), tool_name: name, label: `Tool · ${name}` },
    content: evidenceBlock(
      "studio.focus.tool",
      { tool_name: name, since: window.since.toISOString(), until: window.until.toISOString() },
      body.join("\n"),
      `What an agent is offered: studio_get_agent_access(agent_id). A call in full: studio_get_run(run_id, tool_name="${name}").`,
    ),
  };
}

/** What a focus pin names, read through `deps` as the session's operator at `now`, ready to quote to the coach. */
export async function resolveStudioFocus(
  deps: StudioReachDeps,
  operator: StudioOperator,
  input: StudioFocusRequest,
  now: Date,
): Promise<ResolvedFocus> {
  switch (input.kind) {
    case "run":
      return formatRunFocus(await loadRunEvidence(deps, operator, input));
    case "memory_version":
      return formatMemoryVersionFocus(await loadMemoryVersionEvidence(deps, operator, input));
    case "routine":
      return formatRoutineFocus(await loadRoutineEvidence(deps, operator, input));
    case "file":
      return formatFileFocus(await loadFileEvidence(deps, operator, input));
    case "issue":
      return formatIssueFocus(await loadIssueEvidence(deps, operator, input));
    case "tool":
      return formatToolFocus(await loadToolEvidence(deps, operator, input, now));
  }
}
