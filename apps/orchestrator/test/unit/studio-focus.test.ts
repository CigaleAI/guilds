import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryTimelineEntry } from "../../src/artifacts/memory.js";
import type { GuildIssueRow } from "../../src/db/issues.js";
import type { MessageRow, RunRow } from "../../src/db/runs.js";
import { StudioNotFoundError } from "../../src/studio/errors.js";
import { issueItem } from "../../src/issues/index.js";
import { scheduleItem } from "../../src/schedules/item.js";
import {
  formatIssueFocus,
  formatMemoryVersionFocus,
  formatRoutineFocus,
  formatRunFocus,
  formatToolFocus,
} from "../../src/studio/focus.js";
import { scheduleRow } from "../helpers/generation.js";
import {
  curator,
  FOCUS_NOW,
  focusTables,
  isUnprocessable,
  memoryFocusTables,
  resolveFocus,
} from "../helpers/focus.js";

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "r_1",
    agent_id: "a_1",
    kind: "schedule",
    status: "completed",
    errors: [],
    schedule_id: "sch_1",
    created_at: new Date("2026-11-10T09:00:00.000Z"),
    ...overrides,
  } as never;
}

function message(
  seq: number,
  payload: MessageRow["payload"],
  metadata: MessageRow["metadata"] = {},
): MessageRow {
  return { id: seq, run_id: "r_1", seq, payload, metadata } as never;
}

const callMessages = [
  message(0, { role: "user", content: "Compile the digest" }),
  message(1, {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "memory_write", arguments: '{"content":"kept"}' },
      },
    ],
  }),
  message(
    2,
    { role: "tool", tool_call_id: "call_1", content: "written" },
    { tool_name: "memory_write" },
  ),
];

test("a run pin names the run and tells the coach to load its transcript", async () => {
  const resolved = await resolveFocus(focusTables({ runs: [run()] }), {
    kind: "run",
    run_id: "r_1",
  });
  assert.equal(resolved.focus.kind, "run");
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.agent_name, "curator");
  assert.equal(resolved.focus.run_id, "r_1");
  assert.equal(resolved.focus.seq, null);
  assert.equal(resolved.focus.label, "Schedule wake-up · r_1");
  assert.match(resolved.content, /source="studio\.focus\.run"/);
  assert.match(resolved.content, /Load the transcript with studio_get_run\(run_id="r_1"\)/);
});

test("a run pin lists the run's errors", async () => {
  const failed = run({
    kind: "direct",
    errors: [{ operation: "memory_write", message: "too long" }],
  } as never);
  const resolved = await resolveFocus(focusTables({ runs: [failed] }), {
    kind: "run",
    run_id: "r_1",
  });
  assert.equal(resolved.focus.label, "Direct run · r_1");
  assert.match(resolved.content, /Run errors: memory_write \(too long\)\./);
});

test("a run pin on a tool call quotes the call and its result", async () => {
  const resolved = await resolveFocus(focusTables({ runs: [run()], messages: callMessages }), {
    kind: "run",
    run_id: "r_1",
    call_id: "call_1",
  });
  assert.equal(resolved.focus.call_id, "call_1");
  assert.equal(resolved.focus.tool_name, "memory_write");
  assert.equal(resolved.focus.seq, 2);
  assert.equal(resolved.focus.label, "Schedule wake-up · memory_write · seq 2");
  assert.match(resolved.content, /Requested at seq 1: memory_write with arguments/);
  assert.match(resolved.content, /Tool result at seq 2:/);
  assert.match(resolved.content, /around seq 2/);
});

test("a run pin on a step quotes the message at that step", async () => {
  const resolved = await resolveFocus(
    focusTables({ runs: [run({ kind: "group" })], messages: callMessages }),
    {
      kind: "run",
      run_id: "r_1",
      seq: 0,
    },
  );
  assert.equal(resolved.focus.seq, 0);
  assert.equal(resolved.focus.tool_name, null);
  assert.equal(resolved.focus.label, "Group delivery · seq 0");
  assert.match(resolved.content, /user message at seq 0:/);
});

test("a run pin on a tool result names the tool its metadata records", async () => {
  const resolved = await resolveFocus(focusTables({ runs: [run()], messages: callMessages }), {
    kind: "run",
    run_id: "r_1",
    seq: 2,
  });
  assert.equal(resolved.focus.tool_name, "memory_write");
});

test("a run pin refuses a run that does not exist", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "run", run_id: "r_gone" }),
    isUnprocessable("focus run not found"),
  );
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "run" }),
    isUnprocessable("focus run not found"),
  );
});

test("a run pin refuses a run of an agent outside the source guild", async () => {
  await assert.rejects(
    resolveFocus(focusTables({ runs: [run({ agent_id: "a_far" })] }), {
      kind: "run",
      run_id: "r_1",
    }),
    StudioNotFoundError,
  );
});

test("a run pin refuses a step or a call the run does not have", async () => {
  const data = focusTables({ runs: [run()], messages: callMessages });
  await assert.rejects(
    resolveFocus(data, { kind: "run", run_id: "r_1", seq: 9 }),
    isUnprocessable("focus message not found in that run"),
  );
  await assert.rejects(
    resolveFocus(data, { kind: "run", run_id: "r_1", call_id: "call_gone" }),
    isUnprocessable("focus tool call not found in that run"),
  );
});

test("a memory version pin without a revision names the live memory and its change", async () => {
  const resolved = await resolveFocus(memoryFocusTables(), {
    kind: "memory_version",
    agent_id: "a_1",
  });
  assert.equal(resolved.focus.kind, "memory_version");
  assert.equal(resolved.focus.revision_id, null);
  assert.equal(resolved.focus.version_index, 1);
  assert.equal(resolved.focus.label, "Memory v1 (live)");
  assert.match(resolved.content, /Memory version 1 of curator \(the live memory\)\./);
  assert.match(resolved.content, /Written by: user operator/);
  assert.match(resolved.content, /\+ new line/);
  assert.match(resolved.content, /version_index=1\)/);
});

test("a memory version pin on the live revision names the live memory", async () => {
  const resolved = await resolveFocus(memoryFocusTables(), {
    kind: "memory_version",
    agent_id: "a_1",
    revision_id: "live",
  });
  assert.equal(resolved.focus.label, "Memory v1 (live)");
});

test("a memory version pin on an archived revision quotes the oldest version whole", async () => {
  const resolved = await resolveFocus(memoryFocusTables(), {
    kind: "memory_version",
    agent_id: "a_1",
    revision_id: "rev_1",
  });
  assert.equal(resolved.focus.revision_id, "rev_1");
  assert.equal(resolved.focus.version_index, 0);
  assert.equal(resolved.focus.label, "Memory v0");
  assert.match(resolved.content, /Written by: unknown \(oldest archived version\)/);
  assert.match(resolved.content, /This is the oldest version on record/);
  assert.match(resolved.content, /Content:\nold line/);
  assert.match(resolved.content, /revision_id="rev_1"\)/);
});

test("a memory version pin finds a version by its index", async () => {
  const resolved = await resolveFocus(memoryFocusTables(), {
    kind: "memory_version",
    agent_id: "a_1",
    version_index: 0,
  });
  assert.equal(resolved.focus.revision_id, "rev_1");
});

test("a memory version pin refuses a version the timeline does not have", async () => {
  await assert.rejects(
    resolveFocus(memoryFocusTables(), {
      kind: "memory_version",
      agent_id: "a_1",
      revision_id: "rev_gone",
    }),
    isUnprocessable("focus memory version not found"),
  );
});

test("a memory version or routine pin refuses a pin that names no agent", async () => {
  await assert.rejects(
    resolveFocus(memoryFocusTables(), { kind: "memory_version" }),
    isUnprocessable("focus memory_version needs an agent_id"),
  );
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "routine", schedule_id: "sch_1" }),
    isUnprocessable("focus routine needs an agent_id"),
  );
});

test("a memory version pin refuses an agent outside the source guild", async () => {
  await assert.rejects(
    resolveFocus(memoryFocusTables(), { kind: "memory_version", agent_id: "a_far" }),
    StudioNotFoundError,
  );
});

test("a routine pin quotes the routine's timing and instruction", async () => {
  const routine = scheduleRow({
    id: "sch_1",
    agent_id: "a_1",
    description: "Weekly digest",
    instruction: "Compile the weekly digest",
  });
  const resolved = await resolveFocus(focusTables({ schedules: [routine] }), {
    kind: "routine",
    agent_id: "a_1",
    schedule_id: "sch_1",
  });
  assert.equal(resolved.focus.kind, "routine");
  assert.equal(resolved.focus.schedule_id, "sch_1");
  assert.equal(resolved.focus.label, "Routine · Weekly digest");
  assert.match(resolved.content, /Routine sch_1 of curator: \*\/30 \* \* \* \* \(.+\), active\./);
  assert.match(resolved.content, /Compile the weekly digest/);
});

test("a routine pin refuses a routine the agent does not have", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "routine", agent_id: "a_1", schedule_id: "sch_gone" }),
    isUnprocessable("focus routine not found"),
  );
});

function issue(overrides: Partial<GuildIssueRow> = {}): GuildIssueRow {
  return {
    id: "iss_1",
    guild_id: "guild_1",
    org_id: "org_1",
    agent_id: "a_1",
    agent_name: "curator",
    run_id: "r_1",
    kind: "api",
    severity: "high",
    status: "open",
    summary: "Digest feed returned 401",
    detail: "The feed login expired.",
    tool_name: "feed_fetch",
    created_at: new Date("2026-11-10T10:00:00.000Z"),
    updated_at: new Date("2026-11-10T10:00:00.000Z"),
    resolved_at: null,
    resolved_by: null,
    live_agent_name: "curator",
    avatar_shape: null,
    avatar_color: null,
    ...overrides,
  } as never;
}

test("an issue pin quotes the issue and points at the reporting run", async () => {
  const resolved = await resolveFocus(focusTables({ issues: [issue()] }), {
    kind: "issue",
    issue_id: "iss_1",
  });
  assert.equal(resolved.focus.kind, "issue");
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.issue_id, "iss_1");
  assert.equal(resolved.focus.run_id, "r_1");
  assert.equal(resolved.focus.tool_name, "feed_fetch");
  assert.equal(resolved.focus.label, "Issue · Digest feed returned 401");
  assert.match(resolved.content, /Failing tool: feed_fetch\./);
  assert.match(resolved.content, /studio_get_run\(run_id="r_1", tool_name="report_issue"\)/);
});

test("an issue pin whose agent and run are gone stores no agent and says the run is gone", async () => {
  const orphan = issue({ agent_id: null, run_id: null, tool_name: null, agent_name: "retired" });
  const resolved = await resolveFocus(focusTables({ issues: [orphan] }), {
    kind: "issue",
    issue_id: "iss_1",
  });
  assert.equal(resolved.focus.agent_id, null);
  assert.equal(resolved.focus.agent_name, "retired");
  assert.equal(resolved.focus.run_id, null);
  assert.doesNotMatch(resolved.content, /Failing tool/);
  assert.match(resolved.content, /The run that reported this issue no longer exists\./);
});

test("an issue pin refuses an issue the source guild does not have", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "issue", issue_id: "iss_gone" }),
    isUnprocessable("focus issue not found"),
  );
});

test("a tool pin with no calls says no agent called it", async () => {
  const resolved = await resolveFocus(focusTables(), { kind: "tool", tool_name: "web_fetch" });
  assert.equal(resolved.focus.kind, "tool");
  assert.equal(resolved.focus.agent_id, null);
  assert.equal(resolved.focus.agent_name, null);
  assert.equal(resolved.focus.tool_name, "web_fetch");
  assert.equal(resolved.focus.label, "Tool · web_fetch");
  assert.match(resolved.content, /- no agent called it/);
  assert.doesNotMatch(resolved.content, /Latest failed calls/);
  assert.match(
    resolved.content,
    /since="2026-11-03T12:00:00\.000Z" until="2026-11-10T12:00:00\.000Z"/,
  );
});

test("a tool pin lists each agent's calls and the latest failures", async () => {
  const resolved = await resolveFocus(
    focusTables({
      toolStats: [
        {
          tool_name: "web_fetch",
          agent_id: "a_1",
          calls: 4,
          errors: 1,
          median_ms: 120,
          last_at: null,
        },
        {
          tool_name: "web_fetch",
          agent_id: null,
          calls: 1,
          errors: 0,
          median_ms: null,
          last_at: null,
        },
        {
          tool_name: "memory_write",
          agent_id: "a_1",
          calls: 9,
          errors: 0,
          median_ms: null,
          last_at: null,
        },
      ],
      toolCalls: [
        { run_id: "r_1", call_id: "call_1", agent_id: "a_1", error: "timeout" },
        { run_id: "r_2", call_id: null, agent_id: "a_1", error: null },
      ] as never,
    }),
    { kind: "tool", tool_name: "web_fetch" },
  );
  assert.match(resolved.content, /- a_1: 4 calls, 1 failed/);
  assert.doesNotMatch(resolved.content, /9 calls/);
  assert.match(
    resolved.content,
    /Latest failed calls:\n- run r_1, call call_1 \(a_1\): timeout\n- run r_2, call \? \(a_1\):/,
  );
});

test("a tool pin refuses a name that is not a tool name", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "tool", tool_name: "web fetch" }),
    isUnprocessable("focus tool_name must be a tool name"),
  );
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "tool" }),
    isUnprocessable("focus tool_name must be a tool name"),
  );
});

test("format_run_focus_quotes_a_call_whose_result_is_missing_and_names_it_from_the_request", () => {
  const request = callMessages[1]!;
  const call = request.payload.role === "assistant" ? request.payload.tool_calls![0]! : null;
  const resolved = formatRunFocus({
    run: run(),
    agent: curator,
    focused: { callId: "call_1", target: undefined, request: { row: request, call: call! } },
  });
  assert.equal(resolved.focus.seq, 1);
  assert.equal(resolved.focus.tool_name, "memory_write");
  assert.equal(resolved.focus.label, "Schedule wake-up · memory_write · seq 1");
  assert.match(
    resolved.content,
    /Requested at seq 1: memory_write with arguments\n\{"content":"kept"\}/,
  );
  assert.doesNotMatch(resolved.content, /Tool result/);
  assert.match(resolved.content, /call_id="call_1" tool_name="memory_write"/);
});

test("format_run_focus_says_when_the_focused_step_failed", () => {
  const failed = message(
    2,
    { role: "tool", tool_call_id: "call_1", content: "boom" },
    { tool_name: "memory_write", error: "too long" },
  );
  const resolved = formatRunFocus({
    run: run(),
    agent: curator,
    focused: { callId: null, target: failed, request: undefined },
  });
  assert.match(resolved.content, /Tool result at seq 2 \(error: too long\):\nboom/);
  assert.equal(resolved.focus.call_id, null);
});

test("format_run_focus_leaves_the_start_out_when_the_run_has_no_time", () => {
  const resolved = formatRunFocus({
    run: run({ created_at: null } as never),
    agent: curator,
    focused: null,
  });
  assert.match(resolved.content, /Schedule wake-up r_1 by curator \(completed\)\./);
});

/** A Memory version as the timeline lists it. */
function entry(overrides: Partial<MemoryTimelineEntry> = {}): MemoryTimelineEntry {
  return {
    index: 2,
    revision_id: "rev_2",
    archive_display_path: "org/org_1/agents/a_1/memory/history/v2.md",
    written_at: "2026-11-09T08:00:00.000Z",
    actor: { type: "run", id: "r_1", name: "curator", detail: null },
    run_id: "r_1",
    content: "same line",
    content_hash: "h",
    previous_content: "same line",
    stats: { added: 0, removed: 0 },
    ...overrides,
  };
}

test("format_memory_version_focus_points_at_the_run_that_wrote_it_and_quotes_no_empty_diff", () => {
  const resolved = formatMemoryVersionFocus({ agent: curator, entry: entry() });
  assert.equal(resolved.focus.run_id, "r_1");
  assert.equal(resolved.focus.label, "Memory v2");
  assert.match(resolved.content, /Written by: run curator at 2026-11-09T08:00:00\.000Z\./);
  assert.match(resolved.content, /Change versus the previous version: \+0 −0 lines\./);
  assert.doesNotMatch(resolved.content, /Changes versus the previous version:/);
  assert.match(resolved.content, /studio_get_run\(run_id="r_1", tool_name="memory_write"\)/);
});

test("format_memory_version_focus_names_the_writer_by_its_detail_and_leaves_out_an_unknown_time", () => {
  const resolved = formatMemoryVersionFocus({
    agent: curator,
    entry: entry({
      actor: { type: "user", id: "u", name: "operator", detail: "user operator (Files pane)" },
      written_at: null,
      run_id: null,
    }),
  });
  assert.match(resolved.content, /Written by: user operator \(Files pane\)\./);
  assert.doesNotMatch(resolved.content, /The run that wrote it/);
});

test("format_routine_focus_names_a_paused_window_routine_by_its_timing", () => {
  const item = scheduleItem(
    scheduleRow({ id: "sch_1", agent_id: "a_1", description: "", instruction: "", paused: true }),
  );
  const windowed = {
    ...item,
    cron: null,
    window: { timezone: "UTC", start: "09:00", end: "17:00", max_wakes: 2 },
    label: "Weekdays 9–17",
  } as never;
  const resolved = formatRoutineFocus({ agent: curator, routine: windowed });
  assert.equal(resolved.focus.label, "Routine · Weekdays 9–17");
  assert.match(resolved.content, /Routine sch_1 of curator: Weekdays 9–17, paused\./);
  assert.match(resolved.content, /Last fire: never\./);
  assert.match(resolved.content, /window="\{&quot;timezone&quot;:&quot;UTC&quot;/);
});

test("format_issue_focus_takes_the_live_agent_name_when_the_agent_is_in_the_guild", () => {
  const resolved = formatIssueFocus({
    issue: issueItem(issue({ agent_name: "old name" })),
    agent: curator,
  });
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.agent_name, "curator");
  assert.match(resolved.content, /reported by old name at /);
  assert.match(resolved.content, /agent_id="a_1" agent_name="old name"/);
});

test("format_issue_focus_quotes_an_issue_without_detail", () => {
  const resolved = formatIssueFocus({
    issue: issueItem(issue({ detail: "", tool_name: null })),
    agent: null,
  });
  assert.equal(resolved.focus.tool_name, null);
  assert.match(resolved.content, /Summary: Digest feed returned 401\n\nDetail:\n/);
});

test("format_tool_focus_quotes_the_window_it_counted_over", () => {
  const window = { since: new Date("2026-11-03T12:00:00.000Z"), until: FOCUS_NOW };
  const resolved = formatToolFocus({
    name: "web_fetch",
    window,
    stats: [
      {
        tool_name: "web_fetch",
        agent_id: "a_1",
        calls: 2,
        errors: 0,
        median_ms: null,
        last_at: null,
      },
    ],
    failures: [],
  });
  assert.equal(resolved.focus.agent_id, null);
  assert.match(resolved.content, /in the last 7 days:\n- a_1: 2 calls, 0 failed\n<\/evidence>/);
  assert.match(
    resolved.content,
    /since="2026-11-03T12:00:00\.000Z" until="2026-11-10T12:00:00\.000Z"/,
  );
});
