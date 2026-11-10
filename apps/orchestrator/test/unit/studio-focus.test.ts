import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryTimelineEntry } from "../../src/artifacts/memory.js";
import { revisionDisplayPath } from "../../src/artifacts/paths.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { NO_HIDDEN_GUILDS } from "../../src/artifacts/types.js";
import type { AgentRow } from "../../src/db/agents.js";
import type { GuildToolCallRow, GuildToolCallStatRow } from "../../src/db/activity.js";
import type { ArtifactOrTombstoneRow, MemoryRevisionRow } from "../../src/db/artifacts.js";
import type { GuildIssueRow } from "../../src/db/issues.js";
import type { Queryable } from "../../src/db/pg.js";
import type { MessageRow, RunRow } from "../../src/db/runs.js";
import type { ScheduleRow } from "../../src/db/schedules.js";
import type { StudioOperator } from "../../src/studio/actor.js";
import { StudioNotFoundError, StudioUnprocessableError } from "../../src/studio/errors.js";
import type { FileChangeView } from "../../src/db/file-changes.js";
import { issueItem } from "../../src/issues/index.js";
import { scheduleItem } from "../../src/schedules/item.js";
import {
  formatFileFocus,
  formatIssueFocus,
  formatMemoryVersionFocus,
  formatRoutineFocus,
  formatRunFocus,
  formatToolFocus,
  resolveStudioFocus,
  type FocusFile,
  type StudioFocusRequest,
} from "../../src/studio/focus.js";
import { artifactRow } from "../helpers/artifacts.js";
import { agentRow, scheduleRow } from "../helpers/generation.js";
import { userRow } from "../helpers/users.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");

/** What the fake database holds: the rows each query of a focus pin reads. */
type FocusTables = {
  agents: AgentRow[];
  runs: RunRow[];
  messages: MessageRow[];
  schedules: ScheduleRow[];
  issues: GuildIssueRow[];
  memory: { agent_id: string; content_text: string }[];
  revisions: MemoryRevisionRow[];
  toolStats: GuildToolCallStatRow[];
  toolCalls: GuildToolCallRow[];
  artifacts: ArtifactOrTombstoneRow[];
  /** Whether the organisation's notes and files have an access row for the source guild. */
  inGuildScope: boolean;
  changes: FileChangeRecord[];
};

/** A recorded change as the file-change query returns it. */
type FileChangeRecord = {
  id: string;
  artifact_id: string | null;
  task_agent_id: string | null;
  display_path: string;
  operation: "create" | "update" | "delete";
  version: number;
  actor_type: string;
  actor_id: string;
  actor_name: string;
  run_id: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  run_kind: string | null;
  created_at: string;
};

/** A database that answers each query a focus pin sends from `tables`, and every other query with no rows. */
function focusDatabase(tables: FocusTables): Queryable {
  const answers: Array<[RegExp, (params: unknown[]) => unknown[]]> = [
    [/AS calls/, () => tables.toolStats],
    [/AS call_id/, () => tables.toolCalls],
    [/FROM runs WHERE id = \$1/, ([id]) => tables.runs.filter((row) => row.id === id)],
    [/FROM messages WHERE run_id = \$1/, ([runId]) => tables.messages.filter((row) => row.run_id === runId)],
    [/WHERE a\.id = \$1/, ([id]) => tables.agents.filter((row) => row.id === id)],
    [/WHERE a\.guild_id = \$1/, ([guildId]) => tables.agents.filter((row) => row.guild_id === guildId)],
    [
      /task AS content_text/,
      ([orgId, id]) =>
        tables.agents
          .filter((row) => row.org_id === orgId && row.id === id)
          .map((row) => ({ agent_id: row.id, content_text: row.task, version: row.task_version })),
    ],
    [
      /FROM schedules WHERE id = \$1 AND agent_id = \$2/,
      ([id, agentId]) => tables.schedules.filter((row) => row.id === id && row.agent_id === agentId),
    ],
    [
      /FROM guild_issues i/,
      ([guildId, id]) => tables.issues.filter((row) => row.guild_id === guildId && row.id === id),
    ],
    [/a\.kind = 'memory'/, ([, agentId]) => tables.memory.filter((row) => row.agent_id === agentId)],
    [/FROM file_changes fc/, () => tables.changes],
    [/AS found/, () => [{ found: tables.inGuildScope }]],
    [/FROM artifacts a/, () => tables.artifacts],
    [/FROM memory_revisions/, ([, agentId]) => tables.revisions.filter((row) => row.agent_id === agentId)],
  ];
  return {
    query: async (text: string, params: unknown[] = []) => ({
      rows: answers.find(([pattern]) => pattern.test(text))?.[1](params) ?? [],
    }),
  } as unknown as Queryable;
}

function tables(overrides: Partial<FocusTables> = {}): FocusTables {
  return {
    agents: [
      agentRow({ id: "a_1", guild_id: "guild_1", org_id: "org_1", name: "curator", task: "Keep the digest.", task_version: 3 }),
      agentRow({ id: "a_far", guild_id: "guild_far", org_id: "org_1", name: "stranger" }),
    ],
    runs: [],
    messages: [],
    schedules: [],
    issues: [],
    memory: [],
    revisions: [],
    toolStats: [],
    toolCalls: [],
    artifacts: [],
    inGuildScope: false,
    changes: [],
    ...overrides,
  };
}

const operator: StudioOperator = {
  orgId: "org_1",
  sourceGuildId: "guild_1",
  user: userRow({ id: "user_operator", name: "operator" }),
  hidden: NO_HIDDEN_GUILDS,
};

function resolve(data: FocusTables, request: StudioFocusRequest) {
  const db = focusDatabase(data);
  return resolveStudioFocus({ db, artifacts: artifactStore(db) }, operator, request, NOW);
}

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

function message(seq: number, payload: MessageRow["payload"], metadata: MessageRow["metadata"] = {}): MessageRow {
  return { id: seq, run_id: "r_1", seq, payload, metadata } as never;
}

const callMessages = [
  message(0, { role: "user", content: "Compile the digest" }),
  message(1, {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "memory_write", arguments: '{"content":"kept"}' } }],
  }),
  message(2, { role: "tool", tool_call_id: "call_1", content: "written" }, { tool_name: "memory_write" }),
];

test("a run pin names the run and tells the coach to load its transcript", async () => {
  const resolved = await resolve(tables({ runs: [run()] }), { kind: "run", run_id: "r_1" });
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
  const failed = run({ kind: "direct", errors: [{ operation: "memory_write", message: "too long" }] } as never);
  const resolved = await resolve(tables({ runs: [failed] }), { kind: "run", run_id: "r_1" });
  assert.equal(resolved.focus.label, "Direct run · r_1");
  assert.match(resolved.content, /Run errors: memory_write \(too long\)\./);
});

test("a run pin on a tool call quotes the call and its result", async () => {
  const resolved = await resolve(tables({ runs: [run()], messages: callMessages }), {
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
  const resolved = await resolve(tables({ runs: [run({ kind: "group" })], messages: callMessages }), {
    kind: "run",
    run_id: "r_1",
    seq: 0,
  });
  assert.equal(resolved.focus.seq, 0);
  assert.equal(resolved.focus.tool_name, null);
  assert.equal(resolved.focus.label, "Group delivery · seq 0");
  assert.match(resolved.content, /user message at seq 0:/);
});

test("a run pin on a tool result names the tool its metadata records", async () => {
  const resolved = await resolve(tables({ runs: [run()], messages: callMessages }), { kind: "run", run_id: "r_1", seq: 2 });
  assert.equal(resolved.focus.tool_name, "memory_write");
});

test("a run pin refuses a run that does not exist", async () => {
  await assert.rejects(resolve(tables(), { kind: "run", run_id: "r_gone" }), unprocessable("focus run not found"));
  await assert.rejects(resolve(tables(), { kind: "run" }), unprocessable("focus run not found"));
});

test("a run pin refuses a run of an agent outside the source guild", async () => {
  await assert.rejects(
    resolve(tables({ runs: [run({ agent_id: "a_far" })] }), { kind: "run", run_id: "r_1" }),
    StudioNotFoundError,
  );
});

test("a run pin refuses a step or a call the run does not have", async () => {
  const data = tables({ runs: [run()], messages: callMessages });
  await assert.rejects(resolve(data, { kind: "run", run_id: "r_1", seq: 9 }), unprocessable("focus message not found in that run"));
  await assert.rejects(
    resolve(data, { kind: "run", run_id: "r_1", call_id: "call_gone" }),
    unprocessable("focus tool call not found in that run"),
  );
});

/** The revision that archived Memory's first text when the operator replaced it. */
const revision = {
  id: "rev_1",
  org_id: "org_1",
  agent_id: "a_1",
  content_text: "old line",
  replaced_at: "2026-11-09T08:00:00.000Z",
  replaced_by_type: "user",
  replaced_by_id: "user_operator",
  replaced_by_name: "operator",
  replaced_by_detail: "",
  created_at: "2026-11-09T08:00:00.000Z",
} as never as MemoryRevisionRow;

const memoryTables = () =>
  tables({ memory: [{ agent_id: "a_1", content_text: "old line\nnew line" }], revisions: [revision] });

test("a memory version pin without a revision names the live memory and its change", async () => {
  const resolved = await resolve(memoryTables(), { kind: "memory_version", agent_id: "a_1" });
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
  const resolved = await resolve(memoryTables(), { kind: "memory_version", agent_id: "a_1", revision_id: "live" });
  assert.equal(resolved.focus.label, "Memory v1 (live)");
});

test("a memory version pin on an archived revision quotes the oldest version whole", async () => {
  const resolved = await resolve(memoryTables(), { kind: "memory_version", agent_id: "a_1", revision_id: "rev_1" });
  assert.equal(resolved.focus.revision_id, "rev_1");
  assert.equal(resolved.focus.version_index, 0);
  assert.equal(resolved.focus.label, "Memory v0");
  assert.match(resolved.content, /Written by: unknown \(oldest archived version\)/);
  assert.match(resolved.content, /This is the oldest version on record/);
  assert.match(resolved.content, /Content:\nold line/);
  assert.match(resolved.content, /revision_id="rev_1"\)/);
});

test("a memory version pin finds a version by its index", async () => {
  const resolved = await resolve(memoryTables(), { kind: "memory_version", agent_id: "a_1", version_index: 0 });
  assert.equal(resolved.focus.revision_id, "rev_1");
});

test("a memory version pin refuses a version the timeline does not have", async () => {
  await assert.rejects(
    resolve(memoryTables(), { kind: "memory_version", agent_id: "a_1", revision_id: "rev_gone" }),
    unprocessable("focus memory version not found"),
  );
});

test("a memory version or routine pin refuses a pin that names no agent", async () => {
  await assert.rejects(resolve(memoryTables(), { kind: "memory_version" }), unprocessable("focus memory_version needs an agent_id"));
  await assert.rejects(resolve(tables(), { kind: "routine", schedule_id: "sch_1" }), unprocessable("focus routine needs an agent_id"));
});

test("a memory version pin refuses an agent outside the source guild", async () => {
  await assert.rejects(resolve(memoryTables(), { kind: "memory_version", agent_id: "a_far" }), StudioNotFoundError);
});

test("a routine pin quotes the routine's timing and instruction", async () => {
  const routine = scheduleRow({ id: "sch_1", agent_id: "a_1", description: "Weekly digest", instruction: "Compile the weekly digest" });
  const resolved = await resolve(tables({ schedules: [routine] }), { kind: "routine", agent_id: "a_1", schedule_id: "sch_1" });
  assert.equal(resolved.focus.kind, "routine");
  assert.equal(resolved.focus.schedule_id, "sch_1");
  assert.equal(resolved.focus.label, "Routine · Weekly digest");
  assert.match(resolved.content, /Routine sch_1 of curator: \*\/30 \* \* \* \* \(.+\), active\./);
  assert.match(resolved.content, /Compile the weekly digest/);
});

test("a routine pin refuses a routine the agent does not have", async () => {
  await assert.rejects(
    resolve(tables(), { kind: "routine", agent_id: "a_1", schedule_id: "sch_gone" }),
    unprocessable("focus routine not found"),
  );
});

test("a file pin on an agent's Task quotes the Task", async () => {
  const resolved = await resolve(tables(), { kind: "file", display_path: "org/org_1/agents/a_1/task.md" });
  assert.equal(resolved.focus.kind, "file");
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.display_path, "org/org_1/agents/a_1/task.md");
  assert.equal(resolved.focus.change_id, null);
  assert.equal(resolved.focus.label, "File · task.md");
  assert.match(resolved.content, /task org\/org_1\/agents\/a_1\/task\.md \(v3\)\./);
  assert.match(resolved.content, /No recorded change history for this path\./);
  assert.match(resolved.content, /Keep the digest\./);
});

function change(overrides: Partial<FileChangeRecord> = {}): FileChangeRecord {
  return {
    id: "fc_1",
    artifact_id: "art_1",
    task_agent_id: null,
    display_path: "org/org_1/agents/a_1/scripts/calc",
    operation: "update",
    version: 2,
    actor_type: "run",
    actor_id: "r_1",
    actor_name: "curator",
    run_id: "r_1",
    tool_call_id: "call_9",
    tool_name: "script_write",
    run_kind: "schedule",
    created_at: "2026-11-10T09:30:00.000Z",
    ...overrides,
  };
}

const SCRIPT_PATH = "org/org_1/agents/a_1/scripts/calc";

const script = (overrides: Partial<ArtifactOrTombstoneRow> = {}): ArtifactOrTombstoneRow => ({
  ...artifactRow({ agent_id: "a_1", kind: "script", path: "scripts", key: "calc", content_text: "print(1)", version: 2 }),
  deleted_at: null,
  ...overrides,
});

test("a file pin on an agent's script quotes it with its latest change and the writing run", async () => {
  const resolved = await resolve(
    tables({ artifacts: [script()], changes: [change(), change({ id: "fc_0", version: 1, operation: "create" })] }),
    { kind: "file", display_path: SCRIPT_PATH },
  );
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.change_id, "fc_1");
  assert.equal(resolved.focus.run_id, "r_1");
  assert.equal(resolved.focus.call_id, "call_9");
  assert.equal(resolved.focus.tool_name, "script_write");
  assert.equal(resolved.focus.label, "File · calc");
  assert.match(resolved.content, /script org\/org_1\/agents\/a_1\/scripts\/calc \(v2\)\./);
  assert.match(resolved.content, /Latest change: update to v2 by run r_1 \(schedule wake-up\) via script_write at /);
  assert.match(resolved.content, /2 recorded changes in total\./);
  assert.match(resolved.content, /print\(1\)/);
  assert.match(resolved.content, /The writing run: studio_get_run\(run_id="r_1"\); its tool call id is call_9\./);
});

test("a file pin on one change names that change", async () => {
  const resolved = await resolve(
    tables({ artifacts: [script()], changes: [change(), change({ id: "fc_0", version: 1, operation: "create", actor_type: "user", actor_name: "operator", run_id: null, tool_call_id: null })] }),
    { kind: "file", display_path: SCRIPT_PATH, change_id: "fc_0" },
  );
  assert.equal(resolved.focus.change_id, "fc_0");
  assert.equal(resolved.focus.run_id, null);
  assert.match(resolved.content, /Focused change: create to v1 by user operator at /);
  assert.doesNotMatch(resolved.content, /The writing run/);
});

test("a file pin on a deleted object quotes its fields and says it is deleted", async () => {
  const deleted = script({
    kind: "object",
    collection_id: "col_1",
    collection_name: "leads",
    content_text: null,
    content_json: { total: 3 },
    deleted_at: "2026-11-10T10:00:00.000Z",
  } as never);
  const resolved = await resolve(tables({ artifacts: [deleted] }), { kind: "file", display_path: SCRIPT_PATH });
  assert.match(resolved.content, /object \(deleted\) org\/org_1\/agents\/a_1\/scripts\/calc \(v2\)\./);
  assert.match(resolved.content, /"total": 3/);
});

test("a file pin on an archived Memory revision quotes the archived text", async () => {
  const displayPath = revisionDisplayPath("org_1", "a_1", "20261109T080000Z-operator.md");
  const resolved = await resolve(memoryTables(), { kind: "file", display_path: displayPath });
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.match(resolved.content, new RegExp(`memory_revision ${displayPath}\\.`));
  assert.match(resolved.content, /Content:\nold line/);
});

test("a file pin on an organisation note in reach takes its agent from the pin", async () => {
  const note = { ...artifactRow({ key: "brief.md", content_text: "Cite the source." }), deleted_at: null };
  const data = tables({ artifacts: [note], inGuildScope: true });
  const pinned = await resolve(data, { kind: "file", display_path: "org/org_1/brief.md", agent_id: "a_1" });
  assert.equal(pinned.focus.agent_id, "a_1");
  assert.equal(pinned.focus.agent_name, "curator");
  assert.match(pinned.content, /note org\/org_1\/brief\.md \(v1\)\./);
  const unpinned = await resolve(data, { kind: "file", display_path: "org/org_1/brief.md" });
  assert.equal(unpinned.focus.agent_id, null);
  assert.equal(unpinned.focus.agent_name, null);
  const foreign = await resolve(data, { kind: "file", display_path: "org/org_1/brief.md", agent_id: "a_far" });
  assert.equal(foreign.focus.agent_id, null);
});

test("a file pin refuses a pin without a path, a collection, and a change the path does not have", async () => {
  await assert.rejects(resolve(tables(), { kind: "file" }), unprocessable("focus file needs a display_path"));
  await assert.rejects(
    resolve(tables(), { kind: "file", display_path: "org/org_1/collections/leads" }),
    unprocessable("focus on a collection is not supported; pick a record"),
  );
  await assert.rejects(
    resolve(tables(), { kind: "file", display_path: "org/org_1/agents/a_1/task.md", change_id: "fc_gone" }),
    unprocessable("focus file change not found"),
  );
});

test("a file pin refuses a file of an agent outside the source guild", async () => {
  await assert.rejects(resolve(tables(), { kind: "file", display_path: "org/org_1/agents/a_far/task.md" }), StudioNotFoundError);
});

test("a file pin refuses an organisation file outside the source guild's reach", async () => {
  await assert.rejects(
    resolve(tables(), { kind: "file", display_path: "org/org_1/brief.md" }),
    unprocessable("focus file is not in the source guild's reach"),
  );
});

test("a file pin refuses a path of another organisation", async () => {
  await assert.rejects(
    resolve(tables(), { kind: "file", display_path: "org/org_2/brief.md" }),
    unprocessable("artifact is not in this organisation"),
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
  const resolved = await resolve(tables({ issues: [issue()] }), { kind: "issue", issue_id: "iss_1" });
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
  const resolved = await resolve(tables({ issues: [orphan] }), { kind: "issue", issue_id: "iss_1" });
  assert.equal(resolved.focus.agent_id, null);
  assert.equal(resolved.focus.agent_name, "retired");
  assert.equal(resolved.focus.run_id, null);
  assert.doesNotMatch(resolved.content, /Failing tool/);
  assert.match(resolved.content, /The run that reported this issue no longer exists\./);
});

test("an issue pin refuses an issue the source guild does not have", async () => {
  await assert.rejects(resolve(tables(), { kind: "issue", issue_id: "iss_gone" }), unprocessable("focus issue not found"));
});

test("a tool pin with no calls says no agent called it", async () => {
  const resolved = await resolve(tables(), { kind: "tool", tool_name: "web_fetch" });
  assert.equal(resolved.focus.kind, "tool");
  assert.equal(resolved.focus.agent_id, null);
  assert.equal(resolved.focus.agent_name, null);
  assert.equal(resolved.focus.tool_name, "web_fetch");
  assert.equal(resolved.focus.label, "Tool · web_fetch");
  assert.match(resolved.content, /- no agent called it/);
  assert.doesNotMatch(resolved.content, /Latest failed calls/);
  assert.match(resolved.content, /since="2026-11-03T12:00:00\.000Z" until="2026-11-10T12:00:00\.000Z"/);
});

test("a tool pin lists each agent's calls and the latest failures", async () => {
  const resolved = await resolve(
    tables({
      toolStats: [
        { tool_name: "web_fetch", agent_id: "a_1", calls: 4, errors: 1, median_ms: 120, last_at: null },
        { tool_name: "web_fetch", agent_id: null, calls: 1, errors: 0, median_ms: null, last_at: null },
        { tool_name: "memory_write", agent_id: "a_1", calls: 9, errors: 0, median_ms: null, last_at: null },
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
  assert.match(resolved.content, /Latest failed calls:\n- run r_1, call call_1 \(a_1\): timeout\n- run r_2, call \? \(a_1\):/);
});

test("a tool pin refuses a name that is not a tool name", async () => {
  await assert.rejects(resolve(tables(), { kind: "tool", tool_name: "web fetch" }), unprocessable("focus tool_name must be a tool name"));
  await assert.rejects(resolve(tables(), { kind: "tool" }), unprocessable("focus tool_name must be a tool name"));
});

/** Whether a refusal is the 422 with `message`. */
function unprocessable(message: string): (error: unknown) => boolean {
  return (error) => error instanceof StudioUnprocessableError && error.message === message;
}

const curator = agentRow({ id: "a_1", guild_id: "guild_1", org_id: "org_1", name: "curator" });

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
  assert.match(resolved.content, /Requested at seq 1: memory_write with arguments\n\{"content":"kept"\}/);
  assert.doesNotMatch(resolved.content, /Tool result/);
  assert.match(resolved.content, /call_id="call_1" tool_name="memory_write"/);
});

test("format_run_focus_says_when_the_focused_step_failed", () => {
  const failed = message(2, { role: "tool", tool_call_id: "call_1", content: "boom" }, { tool_name: "memory_write", error: "too long" });
  const resolved = formatRunFocus({ run: run(), agent: curator, focused: { callId: null, target: failed, request: undefined } });
  assert.match(resolved.content, /Tool result at seq 2 \(error: too long\):\nboom/);
  assert.equal(resolved.focus.call_id, null);
});

test("format_run_focus_leaves_the_start_out_when_the_run_has_no_time", () => {
  const resolved = formatRunFocus({ run: run({ created_at: null } as never), agent: curator, focused: null });
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
    entry: entry({ actor: { type: "user", id: "u", name: "operator", detail: "user operator (Files pane)" }, written_at: null, run_id: null }),
  });
  assert.match(resolved.content, /Written by: user operator \(Files pane\)\./);
  assert.doesNotMatch(resolved.content, /The run that wrote it/);
});

test("format_routine_focus_names_a_paused_window_routine_by_its_timing", () => {
  const item = scheduleItem(scheduleRow({ id: "sch_1", agent_id: "a_1", description: "", instruction: "", paused: true }));
  const windowed = { ...item, cron: null, window: { timezone: "UTC", start: "09:00", end: "17:00", max_wakes: 2 }, label: "Weekdays 9–17" } as never;
  const resolved = formatRoutineFocus({ agent: curator, routine: windowed });
  assert.equal(resolved.focus.label, "Routine · Weekdays 9–17");
  assert.match(resolved.content, /Routine sch_1 of curator: Weekdays 9–17, paused\./);
  assert.match(resolved.content, /Last fire: never\./);
  assert.match(resolved.content, /window="\{&quot;timezone&quot;:&quot;UTC&quot;/);
});

/** A recorded change as the file-change history shows it. */
function fileChange(overrides: Partial<FileChangeView> = {}): FileChangeView {
  return {
    id: "fc_1",
    artifact_id: "art_1",
    task_agent_id: null,
    display_path: "org/org_1/brief.md",
    operation: "update",
    version: 2,
    actor: { type: "run", id: "r_1", name: "curator" },
    run: null,
    tool: null,
    studio: null,
    created_at: "2026-11-10T09:30:00.000Z",
    ...overrides,
  };
}

const note: FocusFile = { agent: null, kind: "note", deleted: false, version: 2, content: "Cite the source." };

test("format_file_focus_on_no_agent_stores_no_agent", () => {
  const resolved = formatFileFocus({ displayPath: "org/org_1/brief.md", file: note, agent: null, changes: [], pinnedChange: null });
  assert.equal(resolved.focus.agent_id, null);
  assert.equal(resolved.focus.agent_name, null);
  assert.equal(resolved.focus.change_id, null);
  assert.equal(resolved.focus.run_id, null);
  assert.equal(resolved.focus.label, "File · brief.md");
  assert.match(resolved.content, /note org\/org_1\/brief\.md \(v2\)\.\nNo recorded change history for this path\.\n\nContent:/);
  assert.match(resolved.content, /Full change history: studio_list_file_changes\(display_path="org\/org_1\/brief\.md"\)\.$/);
  assert.doesNotMatch(resolved.content, /change_id=/);
});

test("format_file_focus_says_a_deleted_file_is_deleted_and_leaves_out_a_missing_version", () => {
  const resolved = formatFileFocus({
    displayPath: "org/org_1/brief.md",
    file: { ...note, deleted: true, version: null },
    agent: curator,
    changes: [],
    pinnedChange: null,
  });
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.match(resolved.content, /note \(deleted\) org\/org_1\/brief\.md\./);
  assert.match(resolved.content, /kind="note \(deleted\)"/);
});

test("format_file_focus_names_a_run_change_without_a_tool_by_its_actor", () => {
  const resolved = formatFileFocus({
    displayPath: "org/org_1/brief.md",
    file: note,
    agent: null,
    changes: [fileChange()],
    pinnedChange: null,
  });
  assert.match(resolved.content, /Latest change: update to v2 by run r_1 at 2026-11-10T09:30:00\.000Z\./);
  assert.doesNotMatch(resolved.content, /recorded changes in total/);
});

test("format_file_focus_points_at_the_writing_run_without_a_tool_call", () => {
  const run = { id: "r_2", agent_id: "a_1", guild_id: "guild_1", org_id: "org_1", kind: "group" as const, status: "completed", schedule_id: null, created_at: null };
  const resolved = formatFileFocus({
    displayPath: "org/org_1/brief.md",
    file: note,
    agent: null,
    changes: [fileChange({ run })],
    pinnedChange: null,
  });
  assert.equal(resolved.focus.run_id, "r_2");
  assert.equal(resolved.focus.call_id, null);
  assert.match(resolved.content, /by run r_2 \(group delivery\) at /);
  assert.match(resolved.content, /The writing run: studio_get_run\(run_id="r_2"\)\.$/);
  assert.match(resolved.content, /change_run_kind="group"/);
});

test("format_issue_focus_takes_the_live_agent_name_when_the_agent_is_in_the_guild", () => {
  const resolved = formatIssueFocus({ issue: issueItem(issue({ agent_name: "old name" })), agent: curator });
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.agent_name, "curator");
  assert.match(resolved.content, /reported by old name at /);
  assert.match(resolved.content, /agent_id="a_1" agent_name="old name"/);
});

test("format_issue_focus_quotes_an_issue_without_detail", () => {
  const resolved = formatIssueFocus({ issue: issueItem(issue({ detail: "", tool_name: null })), agent: null });
  assert.equal(resolved.focus.tool_name, null);
  assert.match(resolved.content, /Summary: Digest feed returned 401\n\nDetail:\n/);
});

test("format_tool_focus_quotes_the_window_it_counted_over", () => {
  const window = { since: new Date("2026-11-03T12:00:00.000Z"), until: NOW };
  const resolved = formatToolFocus({
    name: "web_fetch",
    window,
    stats: [{ tool_name: "web_fetch", agent_id: "a_1", calls: 2, errors: 0, median_ms: null, last_at: null }],
    failures: [],
  });
  assert.equal(resolved.focus.agent_id, null);
  assert.match(resolved.content, /in the last 7 days:\n- a_1: 2 calls, 0 failed\n<\/evidence>/);
  assert.match(resolved.content, /since="2026-11-03T12:00:00\.000Z" until="2026-11-10T12:00:00\.000Z"/);
});
