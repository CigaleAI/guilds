import assert from "node:assert/strict";
import { after, test } from "node:test";
import { agentDatabase, persistAgent } from "../../src/agents/persist.js";
import { ArtifactStore } from "../../src/artifacts/index.js";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/seed/connect.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { resolveStudioFocus } from "../../src/studio/focus.js";
import { StudioService } from "../../src/studio/index.js";
import { TOOL_CALLS_PAGE } from "../../src/studio/tool-usage.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertGuild } from "../../src/db/guilds.js";
import { createScheduleRun } from "../../src/db/runs.js";
import { userRow } from "../helpers/users.js";
import { writeBinding } from "../../src/access/bindings.js";
import { userActor } from "../../src/lib/change-actor.js";

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };

const CONFIG = {
  model: TEST_MODEL,
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  browser: false,
};

const dbName = uniqueDbName("agent_platform_studio_tools");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

type Call = { id: string; name: string; args: Record<string, unknown>; error?: string; ms: number };

/** One assistant step with its calls, then each call's result as a run records it. */
function steps(calls: Call[]): Array<[Record<string, unknown>, Record<string, unknown>]> {
  return [
    [{ role: "user", content: "Schedule wake-up: {}" }, { generation: 1, source: "schedule" }],
    [
      {
        role: "assistant",
        content: "",
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
      { generation: 1 },
    ],
    ...calls.map((call): [Record<string, unknown>, Record<string, unknown>] => [
      { role: "tool", tool_call_id: call.id, content: call.error ? `ERROR: ${call.error}` : "ok" },
      {
        generation: 1,
        tool_name: call.name,
        tool_call_id: call.id,
        duration_ms: call.ms,
        error: call.error ?? null,
      },
    ]),
  ];
}

test("studio lists the guild's tools with who is offered each and how their calls went", { timeout: 60_000 }, async () => {
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-studio-tools-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = new ArtifactStore(database.pool, templatesRoot());
  const scripts = new Scripts(scriptDatabase(db));
  const schedules = new Schedules(scheduleDatabase(db));
  const studio = new StudioService({ db, artifacts, scripts, schedules, notesSystemPath: notes.systemPath() });
  const app = await buildApp(database, { db, notes, artifacts, scripts, schedules, studio });
  try {
    const now = new Date();
    await insertGuild(db,
      { guildId: "guild_tl", name: "tools-guild", orgId: "org_home", about: "Tools" },
      now,
    );
    for (const [agentId, name] of [
      ["a_scout", "scout"],
      ["a_writer", "writer"],
    ]) {
      await persistAgent(agentDatabase(db), notes, {
        agentId: String(agentId),
        guildId: "guild_tl",
        guildName: "tools-guild",
        orgSlug: "home",
        orgId: "org_home",
        name: String(name),
        focus: "Work",
        config: CONFIG,
        now,
        artifacts,
      });
    }
    const run = (id: string, agentId: string, calls: Call[]) =>
      createScheduleRun(db,
        {
          runId: id,
          agentId,
          configSnapshot: { ...CONFIG, tools: [], mcp: [] },
          systemContent: "system",
          taskContent: "task",
          projected: steps(calls),
          systemPromptHash: "s",
          taskPromptHash: "t",
          memoryPromptHash: "m",
          scheduleId: null,
          runMetadata: {},
        },
        now,
      );
    await run("r_scout", "a_scout", [
      { id: "c1", name: "note_get", args: { path: "a.md" }, ms: 100 },
      { id: "c2", name: "note_get", args: { path: "missing.md" }, error: "note not found", ms: 300 },
    ]);
    await run("r_writer", "a_writer", [
      { id: "c3", name: "note_get", args: { path: "b.md" }, ms: 200 },
      { id: "c4", name: "retired_tool", args: {}, ms: 50 },
    ]);

    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_tl", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };

    // An organisation's binding reaches every agent of its guilds.
    await writeBinding(
      db,
      {
        bindingId: "bind_org_note_find",
        catalogKind: "native_tool",
        catalogId: "note_find",
        scope: "org",
        scopeId: "org_home",
        enabled: false,
        connectionId: null,
      },
      now,
      userActor(userRow()),
    );
    const listed = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/tools?hours=24`, headers: AUTH });
    assert.equal(listed.statusCode, 200, listed.body);
    type Row = {
      name: string;
      source: string | null;
      group: string;
      offered_to: string[];
      calls: number;
      errors: number;
      median_ms: number | null;
      agents: Array<{ agent_id: string; offered: boolean; calls: number; errors: number }>;
    };
    const rows = (listed.json() as { tools: Row[] }).tools;
    const noteGet = rows.find((row) => row.name === "note_get");
    assert.ok(noteGet, JSON.stringify(rows.map((row) => row.name)));
    assert.equal(noteGet.source, "native");
    assert.equal(noteGet.group, "note");
    assert.deepEqual(noteGet.offered_to, ["a_scout", "a_writer"]);
    assert.equal(noteGet.calls, 3);
    assert.equal(noteGet.errors, 1);
    assert.equal(noteGet.median_ms, 200);
    assert.deepEqual(
      noteGet.agents.map((usage) => [usage.agent_id, usage.calls, usage.errors]),
      [
        ["a_scout", 2, 1],
        ["a_writer", 1, 0],
      ],
    );
    const retired = rows.find((row) => row.name === "retired_tool");
    assert.deepEqual(retired?.offered_to, []);
    assert.equal(retired?.source, null);
    assert.equal(retired?.calls, 1);
    const neverCalled = rows.find((row) => row.name === "note_write");
    assert.equal(neverCalled?.calls, 0);
    assert.deepEqual(neverCalled?.offered_to, ["a_scout", "a_writer"]);
    assert.equal(rows.find((row) => row.name === "note_find"), undefined);
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/tools?hours=-1`, headers: AUTH })).statusCode,
      422,
    );

    const calls = await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/tools/note_get/calls?hours=24`, headers: AUTH });
    assert.equal(calls.statusCode, 200, calls.body);
    const page = calls.json() as {
      calls: Array<{ agent_id: string; run_id: string; call_id: string; arguments: string; status: string; error: string | null }>;
      next_cursor: string | null;
    };
    assert.equal(page.calls.length, 3);
    assert.equal(page.next_cursor, null);
    const failed = page.calls.find((call) => call.call_id === "c2");
    assert.equal(failed?.status, "error");
    assert.equal(failed?.error, "note not found");
    assert.equal(failed?.arguments, JSON.stringify({ path: "missing.md" }));
    const errorsOnly = await app.inject({
      method: "GET",
      url: `/api/studio/sessions/${session.id}/tools/note_get/calls?hours=24&errors=true`,
      headers: AUTH,
    });
    assert.deepEqual(
      (errorsOnly.json() as { calls: Array<{ call_id: string }> }).calls.map((call) => call.call_id),
      ["c2"],
    );

    // A long history pages newest first.
    await run(
      "r_many",
      "a_writer",
      Array.from({ length: TOOL_CALLS_PAGE + 2 }, (_, index) => ({ id: `m${index}`, name: "note_find", args: {}, ms: index })),
    );
    const first = (
      await app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}/tools/note_find/calls?hours=24`, headers: AUTH })
    ).json() as { calls: unknown[]; next_cursor: string | null };
    assert.equal(first.calls.length, TOOL_CALLS_PAGE);
    assert.ok(first.next_cursor);
    const second = (
      await app.inject({
        method: "GET",
        url: `/api/studio/sessions/${session.id}/tools/note_find/calls?hours=24&cursor=${encodeURIComponent(first.next_cursor)}`,
        headers: AUTH,
      })
    ).json() as { calls: unknown[]; next_cursor: string | null };
    assert.equal(second.calls.length, 2);
    assert.equal(second.next_cursor, null);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/studio/sessions/${session.id}/tools/note_find/calls?cursor=nonsense`,
          headers: AUTH,
        })
      ).statusCode,
      422,
    );

    // A tool pin quotes how the agents called it and its latest failures.
    const deps = {
      db,
      artifacts,
      pool: database.pool,
      orgId: "org_home",
      sourceGuildId: "guild_tl",
      user: userRow(),
    };
    const pinned = await resolveStudioFocus(deps, { kind: "tool", tool_name: "note_get" });
    assert.equal(pinned.focus.kind, "tool");
    assert.equal(pinned.focus.tool_name, "note_get");
    assert.equal(pinned.focus.label, "Tool · note_get");
    assert.match(pinned.content, /source="studio.focus.tool"/);
    assert.match(pinned.content, /a_scout: 2 calls, 1 failed/);
    assert.match(pinned.content, /run r_scout, call c2 \(a_scout\): note not found/);
    const quiet = await resolveStudioFocus(deps, { kind: "tool", tool_name: "schedule_list" });
    assert.match(quiet.content, /no agent called it/);
    await assert.rejects(resolveStudioFocus(deps, { kind: "tool", tool_name: "not a tool!" }), /tool_name must be a tool name/);
  } finally {
    await app.close();
    await database.close();
  }
});
