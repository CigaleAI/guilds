import assert from "node:assert/strict";
import type { ToolCall } from "../../src/db/schema/index.js";
import type { RunActivityStepRow } from "../../src/db/activity.js";
import { test } from "node:test";
import {
  activityWindow,
  classifyWrite,
  groupPostSeq,
  hoursWindow,
  messageFloor,
  projectActivity,
  type ActivityInput,
} from "../../src/studio/activity.js";
import type { GuildActivityRunRow } from "../../src/db/activity.js";
import { StudioUnprocessableError } from "../../src/studio/errors.js";

const NOW = new Date("2026-09-25T17:40:00Z");
const since = new Date("2026-09-25T13:40:00Z");
const ts = (hhmmss: string) => new Date(`2026-09-25T${hhmmss}Z`);

/** A run as the activity query returns it: a completed run with no errors, metadata or group snapshot unless given. */
function activityRun(
  fields: Partial<Omit<GuildActivityRunRow, "created_at" | "updated_at">> & { id: string; created_at: Date; updated_at: Date },
): GuildActivityRunRow {
  return {
    agent_id: "a_desk",
    kind: "direct",
    status: "completed",
    errors: [],
    metadata: {},
    schedule_id: null,
    group_chat_through_seq: null,
    started_by_user_id: null,
    wake_seq: null,
    previous_through_seq: null,
    ...fields,
    created_at: fields.created_at.toISOString(),
    updated_at: fields.updated_at.toISOString(),
  };
}

/** A run of `fields` at a fixed time, for what its group snapshot decides. */
function floorRun(fields: Partial<Omit<GuildActivityRunRow, "created_at" | "updated_at">>): GuildActivityRunRow {
  return activityRun({ id: "r_floor", created_at: NOW, updated_at: NOW, ...fields });
}

function input(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    guildId: "g_1",
    since,
    until: NOW,
    now: NOW,
    agents: [
      { id: "a_scout", name: "scout", avatar_color: "#ff4d8d", avatar_shape: "critters" },
      { id: "a_desk", name: "desk", avatar_color: "#fbbf24", avatar_shape: "critters" },
    ],
    runs: [],
    stats: [],
    deliveries: [],
    posts: [],
    changes: [],
    steps: [],
    openings: [],
    messages: [],
    schedules: [],
    generating: () => false,
    ...overrides,
  };
}

const message = (seq: number, time: string, author: string | null, tagged: string[], sourceRunId: string | null = null) => ({
  id: seq,
  seq: String(seq),
  author_type: author ? "agent" : "user",
  author_name: author ?? "operator",
  author_agent_id: author ? `a_${author}` : null,
  source_run_id: sourceRunId,
  content: `message ${seq}`,
  tagged_names: tagged,
  created_at: ts(time),
});

test("the window is hours back from until, capped, and never in the future", () => {
  const window = activityWindow({ hours: "6" }, NOW);
  assert.equal(window.until.toISOString(), NOW.toISOString());
  assert.equal(window.since.toISOString(), "2026-09-25T11:40:00.000Z");
  assert.equal(activityWindow({}, NOW).since.toISOString(), "2026-09-24T17:40:00.000Z");
  assert.equal(activityWindow({ hours: "10000" }, NOW).since.toISOString(), "2026-09-18T17:40:00.000Z");
  assert.equal(activityWindow({ hours: "1", until: "2030-01-01T00:00:00Z" }, NOW).until.toISOString(), NOW.toISOString());
  assert.throws(() => activityWindow({ hours: "0" }, NOW), StudioUnprocessableError);
  assert.throws(() => activityWindow({ hours: "soon" }, NOW), StudioUnprocessableError);
  assert.throws(() => activityWindow({ until: "yesterday" }, NOW), StudioUnprocessableError);
});

test("an hours window ends now and takes the default when it names no hours", () => {
  assert.equal(hoursWindow("6", NOW).since.toISOString(), "2026-09-25T11:40:00.000Z");
  assert.equal(hoursWindow(undefined, NOW).since.toISOString(), "2026-09-24T17:40:00.000Z");
  assert.equal(hoursWindow(undefined, NOW).until.toISOString(), NOW.toISOString());
});

test("writes are classified by display path", () => {
  assert.deepEqual(classifyWrite("org/o/collections/degen-projects/62", "record_update"), { kind: "record", target: "degen-projects" });
  assert.deepEqual(classifyWrite("org/o/agents/a_1/memory.md", "memory_write"), { kind: "memory", target: "memory.md" });
  assert.deepEqual(classifyWrite("org/o/agents/a_1/scripts/rh-balance", "script_create"), { kind: "script", target: "rh-balance" });
  assert.deepEqual(classifyWrite("org/o/guilds/g_1/degen_thesis.md", "note_write"), { kind: "note", target: "degen_thesis.md" });
  assert.equal(groupPostSeq("posted id=133 seq=11\n\nremaining_tool_calls: 44"), 11);
  assert.equal(groupPostSeq("ERROR: waiting for the operator"), null);
});

test("a tagged wake points at the latest row that tagged it, not the snapshot's last row", () => {
  const view = projectActivity(
    input({
      messages: [message(4, "14:00:00", null, ["desk"]), message(5, "14:00:30", "scout", [])],
      runs: [
        activityRun({
          id: "r_desk",
          agent_id: "a_desk",
          kind: "group",
          errors: [],
          metadata: { typesafe: { recipients: { source: "typesafe", names: [], choice: "none", confidence: 0.51 } } },
          group_chat_through_seq: 5,
          previous_through_seq: 3,
          created_at: ts("14:00:31"),
          updated_at: ts("14:01:00"),
        }),
      ],
      stats: [{ run_id: "r_desk", last_seq: 6, first_at: ts("14:00:31"), last_at: ts("14:01:00"), cost_usd: "0.012" }],
      deliveries: [{ run_id: "r_desk", metadata: { source: "group_chat", you_were_tagged: true } }],
    }),
  );
  const [wake] = view.wakes;
  assert.deepEqual(wake?.trigger, {
    type: "message",
    seq: 4,
    through_seq: 5,
    reason: "tag",
    routing: { source: "typesafe", choice: "none", confidence: 0.51 },
    inferred: true,
  });
  assert.equal(wake?.outcome, "silent");
  assert.equal(wake?.cost_usd, 0.012);
  assert.equal(wake?.ended_at, "2026-09-25T14:01:00.000Z");
});

test("untagged operator rows and Jev picks are told apart", () => {
  const runs = [
    activityRun({
      id: "r_fanout",
      agent_id: "a_scout",
      kind: "group",
      errors: [],
      metadata: { typesafe: { recipients: { source: "low_confidence", names: ["desk"], choice: "desk", confidence: 0.41 } } },
      group_chat_through_seq: 8,
      previous_through_seq: 6,
      created_at: ts("15:00:00"),
      updated_at: ts("15:00:10"),
    }),
    activityRun({
      id: "r_jev",
      agent_id: "a_desk",
      kind: "group",
      errors: [],
      metadata: { typesafe: { recipients: { source: "typesafe", names: ["desk"], choice: "desk", confidence: 0.55 } } },
      group_chat_through_seq: 9,
      previous_through_seq: 7,
      created_at: ts("15:01:00"),
      updated_at: ts("15:01:10"),
    }),
  ];
  const view = projectActivity(
    input({
      runs,
      messages: [message(7, "14:59:00", null, []), message(8, "14:59:30", "desk", []), message(9, "15:00:50", "scout", ["user"])],
      deliveries: runs.map((run) => ({ run_id: run.id, metadata: { source: "group_chat", you_were_tagged: false } })),
    }),
  );
  const byRun = new Map(view.wakes.map((wake) => [wake.run_id, wake]));
  const fanout = byRun.get("r_fanout")?.trigger;
  assert.equal(fanout?.type === "message" && fanout.reason, "rules");
  assert.equal(fanout?.type === "message" && fanout.seq, 7);
  const jev = byRun.get("r_jev")?.trigger;
  assert.equal(jev?.type === "message" && jev.reason, "jev");
  assert.equal(jev?.type === "message" && jev.seq, 9);
});

test("a group run that stored its waking row points there, not at an inferred row", () => {
  const view = projectActivity(
    input({
      messages: [message(4, "14:00:00", null, ["desk"]), message(5, "14:00:30", null, ["desk"])],
      runs: [
        activityRun({
          id: "r_desk",
          agent_id: "a_desk",
          kind: "group",
          errors: [],
          metadata: {},
          group_chat_through_seq: 5,
          previous_through_seq: 3,
          wake_seq: 4,
          created_at: ts("14:00:31"),
          updated_at: ts("14:01:00"),
        }),
      ],
      deliveries: [{ run_id: "r_desk", metadata: { source: "group_chat", you_were_tagged: true } }],
    }),
  );
  const trigger = view.wakes[0]?.trigger;
  assert.equal(trigger?.type === "message" && trigger.seq, 4);
  assert.equal(trigger?.type === "message" && trigger.inferred, false);
});

test("a direct chat nobody is recorded as starting has no user", () => {
  const view = projectActivity(
    input({
      runs: [activityRun({ id: "r_chat", agent_id: "a_desk", kind: "direct", errors: [], metadata: {}, created_at: ts("09:00:00"), updated_at: ts("16:00:00") })],
      stats: [{ run_id: "r_chat", last_seq: 4, first_at: ts("15:58:00"), last_at: ts("16:00:00"), cost_usd: "0" }],
    }),
  );
  assert.deepEqual(view.wakes[0]?.trigger, { type: "direct", user_id: null });
});

test("the message floor sits before a stored waking row, or at the bottom of the tag scan", () => {
  assert.equal(messageFloor(floorRun({ kind: "group", group_chat_through_seq: 900, previous_through_seq: 10, wake_seq: 850 })), 849);
  assert.equal(messageFloor(floorRun({ kind: "group", group_chat_through_seq: 900, previous_through_seq: 10 })), 400);
  assert.equal(messageFloor(floorRun({ kind: "group", group_chat_through_seq: 20, previous_through_seq: 10 })), 10);
  assert.equal(messageFloor(floorRun({ kind: "group", group_chat_through_seq: null })), null);
  assert.equal(messageFloor(floorRun({ kind: "direct", group_chat_through_seq: 5 })), null);
});

test("posts, writes, and errors inside the window decide the outcome", () => {
  const view = projectActivity(
    input({
      runs: [
        activityRun({
          id: "r_scout",
          agent_id: "a_scout",
          kind: "schedule",
          schedule_id: "sch_1",
          errors: [
            { at: "2026-09-25T13:00:00Z", generation: 1, operation: "llm.complete", error_type: "Error", message: "old failure" },
            { at: "2026-09-25T14:02:00Z", generation: 1, operation: "generation.max_tool_calls", error_type: "Error", message: "Tool call limit reached." },
          ],
          metadata: {},
          group_chat_through_seq: null,
          previous_through_seq: null,
          created_at: ts("14:00:00"),
          updated_at: ts("14:02:00"),
        }),
      ],
      posts: [
        { run_id: "r_scout", seq: 9, created_at: ts("14:01:00"), content: "posted id=40 seq=12", call_id: "call_post" },
        { run_id: "r_scout", seq: 11, created_at: ts("14:01:30"), content: "ERROR: limit", call_id: "call_bad" },
      ],
      changes: [
        { run_id: "r_scout", display_path: "org/o/collections/leads/3", operation: "create", tool_name: "record_add", tool_call_id: "call_add", created_at: ts("14:00:40") },
        { run_id: "r_scout", display_path: "org/o/agents/a_scout/memory.md", operation: "update", tool_name: "memory_write", tool_call_id: "call_mem", created_at: ts("14:01:50") },
      ],
      schedules: [
        {
          id: "sch_1",
          agent_id: "a_scout",
          cron: "0 * * * *",
          wake_window: null,
          window_fires: 0,
          description: "Hunt",
          instruction: "Hunt for leads.",
          paused: false,
          next_run_at: "2026-09-25T15:00:00.000Z",
          last_run_at: null,
          created_at: "2026-09-20T09:00:00.000Z",
          updated_at: "2026-09-20T09:00:00.000Z",
        },
      ],
    }),
  );
  const [wake] = view.wakes;
  assert.deepEqual(wake?.trigger, { type: "routine", schedule_id: "sch_1" });
  assert.equal(wake?.outcome, "posted");
  assert.deepEqual(wake?.posts, [{ seq: 12, call_id: "call_post", at: "2026-09-25T14:01:00.000Z" }]);
  assert.deepEqual(wake?.writes.map((write) => [write.kind, write.target, write.call_id]), [
    ["record", "leads", "call_add"],
    ["memory", "memory.md", "call_mem"],
  ]);
  assert.equal(wake?.failed, true);
  assert.deepEqual(wake?.errors.map((error) => error.message), ["Tool call limit reached."]);
  assert.deepEqual(view.routines, [
    { id: "sch_1", agent_id: "a_scout", description: "Hunt", label: "Every hour (UTC)", instruction: "Hunt for leads." },
  ]);
});

test("a direct chat is a wake only when it has steps in the window, and a running run ends now", () => {
  const view = projectActivity(
    input({
      runs: [
        activityRun({ id: "r_old", agent_id: "a_desk", kind: "direct", errors: [], metadata: {}, created_at: ts("09:00:00"), updated_at: ts("13:50:00") }),
        activityRun({ id: "r_chat", agent_id: "a_desk", kind: "direct", errors: [], metadata: {}, started_by_user_id: "user_ada", created_at: ts("09:00:00"), updated_at: ts("16:00:00") }),
        activityRun({ id: "r_live", agent_id: "a_scout", kind: "group", errors: [], metadata: {}, group_chat_through_seq: 3, created_at: ts("17:39:00"), updated_at: ts("17:39:30") }),
      ],
      stats: [
        { run_id: "r_old", last_seq: 20, first_at: null, last_at: ts("13:30:00"), cost_usd: "0" },
        { run_id: "r_chat", last_seq: 40, first_at: ts("15:58:00"), last_at: ts("16:00:00"), cost_usd: "0.3" },
      ],
      generating: (runId) => runId === "r_live",
    }),
  );
  assert.deepEqual(view.wakes.map((wake) => wake.run_id), ["r_chat", "r_live"]);
  assert.equal(view.wakes[0]?.started_at, "2026-09-25T15:58:00.000Z");
  assert.deepEqual(view.wakes[0]?.trigger, { type: "direct", user_id: "user_ada" });
  assert.equal(view.wakes[1]?.running, true);
  assert.equal(view.wakes[1]?.ended_at, NOW.toISOString());
});

test("a wake lists its tool calls with their results, its last text, and a direct chat's opening", () => {
  const call = (id: string, name: string, args: string) => ({ id, type: "function" as const, function: { name, arguments: args } }) satisfies ToolCall;
  const step = (row: Pick<RunActivityStepRow, "run_id" | "seq" | "created_at" | "role"> & Partial<RunActivityStepRow>): RunActivityStepRow => ({
    tool_calls: null,
    text: null,
    tool_call_id: null,
    error: null,
    duration_ms: null,
    ...row,
  });
  const view = projectActivity(
    input({
      runs: [
        activityRun({ id: "r_chat", agent_id: "a_desk", kind: "direct", errors: [], metadata: {}, created_at: ts("09:00:00"), updated_at: ts("15:00:00") }),
        activityRun({ id: "r_tick", agent_id: "a_scout", kind: "schedule", schedule_id: "sch_1", errors: [], metadata: {}, created_at: ts("14:00:00"), updated_at: ts("14:01:00") }),
      ],
      stats: [{ run_id: "r_chat", last_seq: 12, first_at: ts("14:58:00"), last_at: ts("15:00:00"), cost_usd: "0" }],
      steps: [
        step({ run_id: "r_tick", seq: 1, created_at: ts("14:00:10").toISOString(), role: "assistant", tool_calls: [call("c_bal", "wallet_get_balance", '{"chain":"base"}'), call("c_note", "note_get", `{"path":"${"p".repeat(300)}"}`)], text: "" }),
        step({ run_id: "r_tick", seq: 2, created_at: ts("14:00:11").toISOString(), role: "tool", tool_call_id: "c_bal", error: "wallet credentials are missing", duration_ms: "98" }),
        step({ run_id: "r_tick", seq: 3, created_at: ts("14:00:12").toISOString(), role: "tool", tool_call_id: "c_note", error: null, duration_ms: "4" }),
        step({ run_id: "r_tick", seq: 4, created_at: ts("14:00:40").toISOString(), role: "assistant", tool_calls: null, text: "  Balances unavailable; nothing to post.  " }),
        step({ run_id: "r_chat", seq: 11, created_at: ts("14:59:00").toISOString(), role: "assistant", tool_calls: [], text: "Here are the likes." }),
      ],
      openings: [{ run_id: "r_chat", text: "how many likes on my last post?" }, { run_id: "r_tick", text: "Schedule wake-up: {}" }],
    }),
  );
  const byRun = new Map(view.wakes.map((wake) => [wake.run_id, wake]));
  const tick = byRun.get("r_tick");
  assert.deepEqual(tick?.tool_calls.map((entry) => [entry.call_id, entry.name, entry.error, entry.duration_ms]), [
    ["c_bal", "wallet_get_balance", "wallet credentials are missing", 98],
    ["c_note", "note_get", null, 4],
  ]);
  assert.equal(tick?.tool_calls[0]?.arguments, '{"chain":"base"}');
  assert.equal(tick?.tool_calls[1]?.arguments.length, 161);
  assert.equal(tick?.tool_call_count, 2);
  assert.equal(tick?.reply, "Balances unavailable; nothing to post.");
  assert.equal(tick?.opening, null);
  const chat = byRun.get("r_chat");
  assert.deepEqual(chat?.tool_calls, []);
  assert.equal(chat?.reply, "Here are the likes.");
  assert.equal(chat?.opening, "how many likes on my last post?");
});

test("public rows carry a bounded preview and their tags", () => {
  const long = "x".repeat(900);
  const view = projectActivity(input({ messages: [{ ...message(1, "14:00:00", null, ["scout", "user"]), content: long }] }));
  const [row] = view.messages;
  assert.equal(row?.seq, 1);
  assert.equal(row?.length, 900);
  assert.equal(row?.preview.length, 401);
  assert.deepEqual(row?.tagged, ["scout", "user"]);
  assert.equal(row?.author_type, "user");
  assert.equal(row?.author_user_id, null);
  const posted = projectActivity(input({ messages: [{ ...message(2, "14:00:00", null, []), author_user_id: "user_ada" }] }));
  assert.equal(posted.messages[0]?.author_user_id, "user_ada");
});

test("a coding wake lists what it changed in each repository as code writes", () => {
  const view = projectActivity(
    input({
      runs: [
        activityRun({
          id: "r_code",
          agent_id: "a_desk",
          kind: "schedule",
          errors: [],
          metadata: {
            repos: [
              { name: "shop", branch: "agent/desk/refunds", head_sha: "h", start_sha: "s", end_sha: "e", files_changed: 3, insertions: 40, deletions: 2 },
              { name: "docs", branch: "main", head_sha: "h", start_sha: "s", end_sha: "e", files_changed: 0, insertions: 0, deletions: 0 },
            ],
          },
          created_at: ts("15:00:00"),
          updated_at: ts("15:10:00"),
        }),
      ],
    }),
  );
  const wake = view.wakes[0]!;
  assert.equal(wake.outcome, "wrote");
  assert.deepEqual(wake.writes, [
    {
      kind: "code",
      target: "shop",
      display_path: "repos/shop",
      operation: "change",
      tool_name: null,
      call_id: null,
      at: wake.ended_at,
      code: { branch: "agent/desk/refunds", files_changed: 3, insertions: 40, deletions: 2 },
    },
  ]);
});
