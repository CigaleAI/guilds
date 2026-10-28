import { ArtifactError } from "../artifacts/errors.js";
import { memoryTimeline } from "../artifacts/service.js";
import { artifactAt, parseActorPath } from "../artifacts/notes.js";
import { listFileChanges, type FileChangeView } from "../db/file-changes.js";
import { wrapEvidence } from "../conversation/trust.js";
import { isoOrNull } from "../db/views.js";
import { memoryDiffText, type MemoryTimelineEntry } from "../artifacts/memory-timeline.js";
import { issueItem } from "../issues/index.js";
import { scheduleItem } from "../schedules/item.js";
import { capBytes } from "../toolbox/output.js";
import { STUDIO_FOCUS_EXCERPT_BYTES } from "./constants.js";
import { ACTIVITY_MAX_HOURS } from "./activity.js";
import { StudioUnprocessableError } from "./errors.js";
import { studioReachesParsed } from "./reach.js";
import { getAgent, getAgentTask, type AgentRow } from "../db/agents.js";
import { getRun, listMessages, type MessageRow } from "../db/runs.js";
import { getSchedule } from "../db/schedules.js";
import { getIssue } from "../db/issues.js";
import { listGuildToolCallStats, listGuildToolCalls } from "../db/activity.js";
import type { Queryable } from "../db/pg.js";
import type { StudioFocus, StudioFocusKind, ToolCall } from "../db/schema/index.js";
import type { UserRow } from "../db/users.js";
import { operatorContext, type ArtifactStore } from "../artifacts/store.js";

// A focus pin names one piece of evidence the operator is asking about: a
// run (optionally one step of it), a memory version, a routine, a file, an
// issue an agent reported, or a tool the guild's agents call.
// The client sends ids; the server checks they belong to the source guild,
// fills in what it can, and writes the evidence block the coach reads.

export const STUDIO_FOCUS_SOURCE = "studio_focus";
export type StudioFocusDeps = {
  db: Queryable;
  artifacts: ArtifactStore;
  orgId: string;
  sourceGuildId: string;
  user: UserRow;
};

function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function excerpt(text: string): string {
  return capBytes(text, STUDIO_FOCUS_EXCERPT_BYTES)[0];
}

function runKindLabel(kind: string): string {
  if (kind === "schedule") return "Schedule wake-up";
  if (kind === "group") return "Group delivery";
  return "Direct run";
}

function emptyFocus(kind: StudioFocusKind, agent: Pick<AgentRow, "id" | "name">): StudioFocus {
  return {
    kind,
    agent_id: agent.id,
    agent_name: String(agent.name ?? ""),
    label: "",
    run_id: null,
    seq: null,
    call_id: null,
    tool_name: null,
    revision_id: null,
    version_index: null,
    schedule_id: null,
    display_path: null,
    change_id: null,
    issue_id: null,
  };
}

async function guildAgent(
  deps: StudioFocusDeps,
  agentId: string,
): Promise<AgentRow> {
  const agent = agentId ? await getAgent(deps.db, agentId) : null;
  if (
    !agent ||
    agent.guild_id !== deps.sourceGuildId ||
    agent.org_id !== deps.orgId
  ) {
    throw new StudioUnprocessableError("focus agent is not in the source guild");
  }
  return agent;
}

function evidenceBlock(
  source: string,
  coordinates: Record<string, unknown>,
  body: string,
  tail: string,
): string {
  return `${wrapEvidence({ source, coordinates, body })}\n\n${tail}`;
}

/** The assistant message of `rows` that made the call `callId`, and the call. */
function callRequest(rows: MessageRow[], callId: string): { row: MessageRow; call: ToolCall } | undefined {
  for (const row of rows) {
    const call = row.payload.role === "assistant" ? row.payload.tool_calls?.find((item) => item.id === callId) : undefined;
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
function focusedMessages(
  rows: MessageRow[],
  at: { seq: number | null; callId: string },
): { target: MessageRow | undefined; request: { row: MessageRow; call: ToolCall } | undefined } {
  if (at.callId) {
    const target = rows.find((row) => row.payload.role === "tool" && row.payload.tool_call_id === at.callId);
    const request = callRequest(rows, at.callId);
    if (!target && !request) {
      throw new StudioUnprocessableError("focus tool call not found in that run");
    }
    return { target, request };
  }
  const target = rows.find((row) => row.seq === at.seq);
  if (!target) {
    throw new StudioUnprocessableError("focus message not found in that run");
  }
  return { target, request: undefined };
}

async function resolveRun(
  deps: StudioFocusDeps,
  input: Record<string, unknown>,
): Promise<{ focus: StudioFocus; content: string }> {
  const runId = trimmedText(input.run_id);
  const run = runId ? await getRun(deps.db, runId) : null;
  if (!run) {
    throw new StudioUnprocessableError("focus run not found");
  }
  const agent = await guildAgent(deps, run.agent_id);
  const errorList = run.errors;
  const kind = run.kind;
  const createdAt = isoOrNull(run.created_at);
  const focus = emptyFocus("run", agent);
  focus.run_id = runId;
  focus.label = `${runKindLabel(kind)} · ${runId}`;

  const coordinates: Record<string, unknown> = {
    run_id: runId,
    agent_id: agent.id,
    kind,
    status: run.status,
    created_at: createdAt,
    schedule_id: run.schedule_id,
    error_count: errorList.length,
  };
  const lines: string[] = [
    `${runKindLabel(kind)} ${runId} by ${agent.name} (${run.status})${createdAt ? ` started ${createdAt}` : ""}.`,
  ];
  if (errorList.length) {
    lines.push(
      `Run errors: ${errorList
        .map((entry) => `${entry.operation}${entry.message ? ` (${entry.message})` : ""}`)
        .join("; ")}.`,
    );
  }

  const seq = nonNegativeInt(input.seq);
  const callId = trimmedText(input.call_id);
  let tail = `Load the transcript with studio_get_run(run_id="${runId}").`;
  if (seq !== null || callId) {
    const rows = await listMessages(deps.db, runId);
    const { target, request } = focusedMessages(rows, { seq, callId });
    const focusedSeq = target?.seq ?? request?.row.seq ?? null;
    focus.seq = focusedSeq;
    focus.call_id = callId || null;
    coordinates.seq = focusedSeq;
    coordinates.call_id = callId || null;
    if (request) {
      const fn = request.call.function;
      focus.tool_name = fn.name.trim() || null;
      coordinates.tool_name = focus.tool_name;
      lines.push("", `Requested at seq ${request.row.seq}: ${fn.name} with arguments`, excerpt(fn.arguments));
    }
    if (target) {
      const { payload, metadata } = target;
      if (!focus.tool_name && payload.role === "tool") {
        focus.tool_name = metadata.tool_name?.trim() || null;
        coordinates.tool_name = focus.tool_name;
      }
      const label =
        payload.role === "tool" ? `Tool result at seq ${target.seq}` : `${payload.role} message at seq ${target.seq}`;
      lines.push("", `${label}${metadata.error ? ` (error: ${metadata.error})` : ""}:`, excerpt(payload.content));
    }
    focus.label = `${runKindLabel(kind)} · ${focus.tool_name ? `${focus.tool_name} · ` : ""}seq ${String(focusedSeq)}`;
    tail = `Load the surrounding steps with studio_get_run(run_id="${runId}", seq_start, seq_end) around seq ${String(focusedSeq)}.`;
  }
  return {
    focus,
    content: evidenceBlock("studio.focus.run", coordinates, lines.join("\n"), tail),
  };
}

function findEntry(
  entries: MemoryTimelineEntry[],
  input: Record<string, unknown>,
): MemoryTimelineEntry | undefined {
  const revisionId = trimmedText(input.revision_id);
  if (revisionId && revisionId !== "live") {
    return entries.find((entry) => entry.revision_id === revisionId);
  }
  const index = nonNegativeInt(input.version_index);
  if (index !== null) {
    return entries.find((entry) => entry.index === index);
  }
  return entries.find((entry) => entry.revision_id === null);
}

async function resolveMemoryVersion(
  deps: StudioFocusDeps,
  input: Record<string, unknown>,
): Promise<{ focus: StudioFocus; content: string }> {
  const agent = await guildAgent(deps, trimmedText(input.agent_id));
  const actor = operatorContext(
    deps.orgId,
    String(deps.user.id),
    String(deps.user.name ?? "operator"),
    {
      guildId: deps.sourceGuildId,
      agentId: agent.id,
    },
  );
  const { entries } = await memoryTimeline(deps.artifacts, actor, agent.id);
  const entry = findEntry(entries, input);
  if (!entry) {
    throw new StudioUnprocessableError("focus memory version not found");
  }
  const focus = emptyFocus("memory_version", agent);
  focus.revision_id = entry.revision_id;
  focus.version_index = entry.index;
  focus.run_id = entry.run_id;
  focus.label = `Memory v${entry.index}${entry.revision_id === null ? " (live)" : ""}`;
  const writer =
    entry.actor.type === "unknown"
      ? "unknown (oldest archived version)"
      : entry.actor.detail || `${entry.actor.type} ${entry.actor.name ?? ""}`;
  const body = [
    `Memory version ${entry.index} of ${agent.name}${entry.revision_id === null ? " (the live memory)" : ""}.`,
    `Written by: ${writer}${entry.written_at ? ` at ${entry.written_at}` : ""}.`,
    entry.previous_content === null
      ? "This is the oldest version on record; there is no previous version to compare."
      : `Change versus the previous version: +${entry.stats.added} −${entry.stats.removed} lines.`,
  ];
  if (entry.previous_content !== null) {
    const diff = memoryDiffText(entry.previous_content, entry.content);
    if (diff) {
      body.push("", "Changes versus the previous version:", excerpt(diff));
    }
  } else {
    body.push("", "Content:", excerpt(entry.content));
  }
  const versionRef = entry.revision_id
    ? `revision_id="${entry.revision_id}"`
    : `version_index=${entry.index}`;
  const tail = [
    `Load the full version with studio_get_memory_version(agent_id="${agent.id}", ${versionRef}).`,
    entry.run_id
      ? `The run that wrote it: studio_get_run(run_id="${entry.run_id}", tool_name="memory_write") returns its memory_write call and result.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    focus,
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

async function resolveRoutine(
  deps: StudioFocusDeps,
  input: Record<string, unknown>,
): Promise<{ focus: StudioFocus; content: string }> {
  const agent = await guildAgent(deps, trimmedText(input.agent_id));
  const scheduleId = trimmedText(input.schedule_id);
  const row = scheduleId ? await getSchedule(deps.db, agent.id, scheduleId) : null;
  if (!row) {
    throw new StudioUnprocessableError("focus routine not found");
  }
  const item = scheduleItem(row);
  const focus = emptyFocus("routine", agent);
  focus.schedule_id = scheduleId;
  focus.label = `Routine · ${String(item.description || item.label)}`;
  const timing = item.cron ? `${String(item.cron)} (${String(item.label)})` : String(item.label);
  const body = [
    `Routine ${scheduleId} of ${agent.name}: ${timing}, ${item.paused ? "paused" : "active"}.`,
    `Description: ${String(item.description || "")}`,
    `Next fire: ${String(item.next_run_at ?? "—")}. Last fire: ${String(item.last_run_at ?? "never")}.`,
    "",
    "Instruction:",
    excerpt(String(item.instruction ?? "")),
  ];
  return {
    focus,
    content: evidenceBlock(
      "studio.focus.routine",
      {
        schedule_id: scheduleId,
        agent_id: agent.id,
        cron: item.cron,
        window: item.window,
        paused: item.paused,
        instruction_hash: item.instruction_hash,
        next_run_at: item.next_run_at,
        last_run_at: item.last_run_at,
      },
      body.join("\n"),
      `List the runs this routine produced with studio_list_runs(agent_id="${agent.id}", schedule_id="${scheduleId}"), then studio_get_run on one of them.`,
    ),
  };
}

async function loadFileForFocus(
  deps: StudioFocusDeps,
  displayPath: string,
): Promise<{
  agent: AgentRow | null;
  kind: string;
  version: number | null;
  content: string;
}> {
  const actor = operatorContext(deps.orgId, String(deps.user.id), String(deps.user.name ?? "operator"), {
    guildId: deps.sourceGuildId,
  });
  try {
    const parsed = parseActorPath(actor, displayPath);
    if (parsed.kind === "collection") {
      throw new StudioUnprocessableError("focus on a collection is not supported; pick a record");
    }
    let agent: AgentRow | null = null;
    if (parsed.kind === "revision" || (parsed.kind === "artifact" && parsed.level === "agent")) {
      agent = await guildAgent(deps, parsed.kind === "revision" ? parsed.agentId : parsed.ownerId);
    } else if (!(await studioReachesParsed(deps, parsed))) {
      throw new StudioUnprocessableError(
        "focus file is not in the source guild or the organisation's shared files",
      );
    }
    if (
      parsed.kind === "artifact" &&
      parsed.level === "agent" &&
      parsed.path === "" &&
      parsed.key === "task.md" &&
      agent
    ) {
      const task = await getAgentTask(deps.db, deps.orgId, agent.id);
      return {
        agent,
        kind: "task",
        version: task?.version ?? null,
        content: task?.content_text ?? "",
      };
    }
    const view = await artifactAt(deps.artifacts, actor, displayPath);
    if (view.kind === "revision") {
      return { agent, kind: "memory_revision", version: null, content: view.content };
    }
    const row = view.row;
    const content =
      row.kind === "object"
        ? JSON.stringify(row.content_json ?? {}, null, 2)
        : String(row.content_text ?? "");
    return {
      agent,
      kind: view.deleted ? `${row.kind} (deleted)` : String(row.kind),
      version: row.version,
      content,
    };
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw new StudioUnprocessableError(error.message);
    }
    throw error;
  }
}

function changeSummary(change: FileChangeView): string {
  const who =
    change.actor.type === "run"
      ? `run ${change.run?.id ?? change.actor.id}${change.run?.kind ? ` (${runKindLabel(change.run.kind).toLowerCase()})` : ""}${change.tool?.name ? ` via ${change.tool.name}` : ""}`
      : `${change.actor.type} ${change.actor.name}`;
  return `${change.operation} to v${change.version} by ${who} at ${change.created_at}`;
}

async function resolveFile(
  deps: StudioFocusDeps,
  input: Record<string, unknown>,
): Promise<{ focus: StudioFocus; content: string }> {
  const displayPath = trimmedText(input.display_path);
  if (!displayPath) {
    throw new StudioUnprocessableError("focus file needs a display_path");
  }
  const file = await loadFileForFocus(deps, displayPath);
  const agent =
    file.agent ?? (await guildAgent(deps, trimmedText(input.agent_id)).catch(() => null));
  const changes = await listFileChanges(deps.db, deps.orgId, displayPath);
  const changeId = trimmedText(input.change_id);
  const change = changeId ? changes.find((row) => row.id === changeId) : changes[0];
  if (changeId && !change) {
    throw new StudioUnprocessableError("focus file change not found");
  }
  const focus: StudioFocus = {
    ...emptyFocus("file", agent ?? { id: "", name: "" }),
    display_path: displayPath,
    change_id: change?.id ?? null,
    run_id: change?.run?.id ?? null,
    call_id: change?.tool?.call_id ?? null,
    tool_name: change?.tool?.name ?? null,
  };
  focus.label = `File · ${displayPath.split("/").pop() ?? displayPath}`;
  const body = [
    `${file.kind} ${displayPath}${file.version !== null ? ` (v${file.version})` : ""}.`,
    change
      ? `${changeId ? "Focused change" : "Latest change"}: ${changeSummary(change)}.`
      : "No recorded change history for this path.",
    changes.length > 1 ? `${changes.length} recorded changes in total.` : "",
    "",
    "Content:",
    excerpt(file.content),
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
  const tail = [
    `Full change history: studio_list_file_changes(display_path="${displayPath}").`,
    change?.run?.id
      ? `The writing run: studio_get_run(run_id="${change.run.id}")${change.tool?.call_id ? `; its tool call id is ${change.tool.call_id}` : ""}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    focus,
    content: evidenceBlock(
      "studio.focus.file",
      {
        display_path: displayPath,
        kind: file.kind,
        version: file.version,
        change_id: change?.id ?? null,
        change_operation: change?.operation ?? null,
        change_actor_type: change?.actor.type ?? null,
        change_actor_name: change?.actor.name ?? null,
        change_run_id: change?.run?.id ?? null,
        change_run_kind: change?.run?.kind ?? null,
        change_tool_call_id: change?.tool?.call_id ?? null,
        change_tool_name: change?.tool?.name ?? null,
        change_at: change?.created_at ?? null,
      },
      body.join("\n"),
      tail,
    ),
  };
}

async function resolveIssue(
  deps: StudioFocusDeps,
  input: Record<string, unknown>,
): Promise<{ focus: StudioFocus; content: string }> {
  const issueId = trimmedText(input.issue_id);
  const row = issueId ? await getIssue(deps.db, deps.sourceGuildId, issueId) : null;
  if (!row) {
    throw new StudioUnprocessableError("focus issue not found");
  }
  const issue = issueItem(row);
  const agentId = issue.agent_id ? String(issue.agent_id) : "";
  const agent = agentId ? await guildAgent(deps, agentId).catch(() => null) : null;
  const runId = issue.run_id ? String(issue.run_id) : null;
  const focus: StudioFocus = {
    ...emptyFocus("issue", agent ?? { id: "", name: issue.agent_name }),
    issue_id: issueId,
    run_id: runId,
    tool_name: issue.tool_name ? String(issue.tool_name) : null,
  };
  focus.label = `Issue · ${String(issue.summary)}`;
  const body = [
    `Issue ${issueId} reported by ${String(issue.agent_name)} at ${String(issue.created_at)}: ${String(issue.kind)}, severity ${String(issue.severity)}, ${String(issue.status)}.`,
    issue.tool_name ? `Failing tool: ${String(issue.tool_name)}.` : "",
    `Summary: ${String(issue.summary)}`,
    "",
    "Detail:",
    excerpt(String(issue.detail ?? "")),
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "");
  const tail = runId
    ? `The reporting run: studio_get_run(run_id="${runId}", tool_name="report_issue") returns the report; load the steps before it with seq_start and seq_end to find the failure.`
    : "The run that reported this issue no longer exists.";
  return {
    focus,
    content: evidenceBlock(
      "studio.focus.issue",
      {
        issue_id: issueId,
        agent_id: agent ? agent.id : null,
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

function toolUsageLines(stats: Array<Record<string, unknown>>): string[] {
  const lines = stats
    .filter((stat) => stat.agent_id !== null)
    .map(
      (stat) =>
        `- ${String(stat.agent_id)}: ${String(stat.calls)} calls, ${String(stat.errors)} failed`,
    );
  return lines.length ? lines : ["- no agent called it"];
}

function toolFailureLines(rows: Array<Record<string, unknown>>): string[] {
  return rows.map(
    (row) =>
      `- run ${String(row.run_id)}, call ${String(row.call_id ?? "?")} (${String(row.agent_id)}): ${excerpt(String(row.error ?? ""))}`,
  );
}

// A tool pin: how each agent called the tool over the longest activity window,
// and its latest failures, with where to read further.
async function resolveTool(
  deps: StudioFocusDeps,
  input: Record<string, unknown>,
): Promise<{ focus: StudioFocus; content: string }> {
  const name = trimmedText(input.tool_name).trim();
  if (!TOOL_NAME.test(name)) {
    throw new StudioUnprocessableError("focus tool_name must be a tool name");
  }
  const until = new Date();
  const since = new Date(until.getTime() - ACTIVITY_MAX_HOURS * 3_600_000);
  const stats = (await listGuildToolCallStats(deps.db, deps.sourceGuildId, since, until)).filter(
    (stat) => stat.tool_name === name,
  );
  const failures = await listGuildToolCalls(deps.db, deps.sourceGuildId, name, {
    since,
    until,
    errorsOnly: true,
    before: null,
    limit: TOOL_FOCUS_FAILURES,
  });
  const focus: StudioFocus = {
    ...emptyFocus("tool", { id: "", name: "" }),
    tool_name: name,
    label: `Tool · ${name}`,
  };
  const body = [
    `Tool ${name}, called by the guild's agents in the last ${ACTIVITY_MAX_HOURS / 24} days:`,
    ...toolUsageLines(stats),
    ...(failures.length ? ["", "Latest failed calls:", ...toolFailureLines(failures)] : []),
  ];
  return {
    focus,
    content: evidenceBlock(
      "studio.focus.tool",
      { tool_name: name, since: since.toISOString(), until: until.toISOString() },
      body.join("\n"),
      `What an agent is offered: studio_get_agent_access(agent_id). A call in full: studio_get_run(run_id, tool_name="${name}").`,
    ),
  };
}

export async function resolveStudioFocus(
  deps: StudioFocusDeps,
  input: unknown,
): Promise<{ focus: StudioFocus; content: string }> {
  const raw =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  if (!raw) {
    throw new StudioUnprocessableError("focus must be an object");
  }
  const kind = trimmedText(raw.kind) as StudioFocusKind;
  switch (kind) {
    case "run":
      return resolveRun(deps, raw);
    case "memory_version":
      return resolveMemoryVersion(deps, raw);
    case "routine":
      return resolveRoutine(deps, raw);
    case "file":
      return resolveFile(deps, raw);
    case "issue":
      return resolveIssue(deps, raw);
    case "tool":
      return resolveTool(deps, raw);
    default:
      throw new StudioUnprocessableError(
        "focus kind must be run, memory_version, routine, file, issue, or tool",
      );
  }
}
