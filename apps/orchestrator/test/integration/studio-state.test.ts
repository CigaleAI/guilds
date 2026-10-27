import assert from "node:assert/strict";
import { after, test } from "node:test";
import { agentDatabase, persistAgent } from "../../src/agents/persist.js";
import { agentActor, ArtifactStore, ownerPrefix, snapshotTaskCollections } from "../../src/artifacts/index.js";
import { buildApp } from "../../src/app.js";
import { connect } from "../../src/db/client.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { StudioService } from "../../src/studio/index.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { insertGuild } from "../../src/db/guilds.js";
import { createScheduleRun } from "../../src/db/runs.js";

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

const dbName = uniqueDbName("agent_platform_studio_state");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

type Call = { id: string; name: string; args: Record<string, unknown> };

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
      { role: "tool", tool_call_id: call.id, content: "ok" },
      { generation: 1, tool_name: call.name, tool_call_id: call.id, duration_ms: 5, error: null },
    ]),
  ];
}

test("studio's State lists the guild's items with who changed and read each one", { timeout: 60_000 }, async () => {
  const database = await connect(await createIsolatedDatabase(dbName));
  const notes = new NotesStore(tempDir("guilds-studio-state-notes-"), templatesRoot());
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
      { guildId: "guild_st", name: "state-guild", orgId: "org_home", about: "State" },
      now,
    );
    await insertGuild(db,
      { guildId: "guild_far", name: "far-guild", orgId: "org_home", about: "Far" },
      now,
    );
    const agents: Array<[string, string, string]> = [
      ["a_scout", "scout", "guild_st"],
      ["a_writer", "writer", "guild_st"],
      ["a_far", "far", "guild_far"],
    ];
    for (const [agentId, name, guildId] of agents) {
      await persistAgent(agentDatabase(db), notes, {
        agentId,
        guildId,
        guildName: guildId === "guild_st" ? "state-guild" : "far-guild",
        orgSlug: "home",
        orgId: "org_home",
        name,
        focus: "Work",
        config: CONFIG,
        now,
        artifacts,
      });
    }
    const operator = artifacts.operatorContext("org_home", "user_operator", "operator", { guildId: "guild_st" });
    const asRun = (agentId: string, name: string, guildId: string, runId: string) => ({
      ...agentActor({ orgId: "org_home", guildId, agentId, agentName: name, runId }),
      toolCall: { id: `call_${runId}`, name: "note_write" },
    });
    const run = (
      id: string,
      agentId: string,
      calls: Call[],
      taskSource: Record<string, unknown> = {},
    ) =>
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
          runMetadata: { task_source: taskSource },
        },
        now,
      );

    const rules = await artifacts.writeNote(operator, { level: "guild", key: "rules.md", content: "Cite sources.\n" });
    const rulesPath = `${ownerPrefix("org_home", "guild", "guild_st")}${rules.key}`;
    await artifacts.writeNote(operator, { level: "guild", key: "idle.md", content: "Nobody reads this.\n" });
    const farNote = await artifacts.writeNote(
      artifacts.operatorContext("org_home", "user_operator", "operator", { guildId: "guild_far" }),
      { level: "guild", key: "far.md", content: "Elsewhere.\n" },
    );
    const leads = await artifacts.createCollection(operator, {
      name: "leads",
      purpose: "prospects",
      columns: [{ name: "title", type: "text", description: "name", required: true }],
      guildId: "guild_st",
    });
    await scripts.create(operator, "a_writer", "tally", "Counts", "print(1)", { type: "object", properties: {} });
    // A run records the tables its Task embeds, directly or through a note it inlines.
    const viaNote = await artifacts.writeNote(operator, { level: "guild", key: "leads-note.md", content: `![[${leads.display_path}]]\n` });
    assert.deepEqual(
      await snapshotTaskCollections(artifacts, operator, `![[${ownerPrefix("org_home", "guild", "guild_st")}${viaNote.key}]]\n`),
      [leads.display_path],
    );

    // Runs: the scout's Task embeds the rules and the leads table, and it reads both by tool;
    // the writer runs its script both ways; each change comes from a run's tool call.
    await run("r_scout", "a_scout", [
      { id: "c1", name: "note_get", args: { path: rulesPath } },
      { id: "c2", name: "record_list", args: { collection: "leads" } },
    ], { embeds: [{ display_path: rulesPath, version: 1, content_hash: "h", kind: "note" }], collections: [leads.display_path] });
    await run("r_writer", "a_writer", [
      { id: "c3", name: "script_run", args: { name: "tally" } },
      { id: "c4", name: "tally", args: {} },
    ]);
    await run("r_far", "a_far", []);
    await artifacts.writeNote(asRun("a_writer", "writer", "guild_st", "r_writer"), {
      level: "guild",
      key: "rules.md",
      content: "Cite every source.\n",
      expectedVersion: 1,
    });
    const scoutRun = asRun("a_scout", "scout", "guild_st", "r_scout");
    const added = await artifacts.addRecord(scoutRun, { collection: "leads", body: { title: "Acme" } });
    await artifacts.removeRecord(asRun("a_writer", "writer", "guild_st", "r_writer"), { collection: "leads", id: added.record.id });

    const created = await app.inject({
      method: "POST",
      url: "/api/studio/sessions",
      headers: AUTH,
      payload: { mode: "optimize", source_guild_id: "guild_st", coach_config: { model: TEST_MODEL, temperature: 0.2 } },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json() as { id: string };
    const get = (url: string) => app.inject({ method: "GET", url: `/api/studio/sessions/${session.id}${url}`, headers: AUTH });

    const listed = await get("/state?hours=24");
    assert.equal(listed.statusCode, 200, listed.body);
    type Row = {
      display_path: string;
      kind: string;
      level: string;
      changes: number;
      reads: number;
      writers: number;
      top_writer: { actor: { name: string }; share: number } | null;
      top_reader: { actor: { name: string } } | null;
      flags: string[];
    };
    const rows = (listed.json() as { items: Row[] }).items;
    const at = (path: string) => rows.find((row) => row.display_path === path);
    assert.equal(at(`org/org_home/guilds/guild_far/${farNote.key}`), undefined);
    assert.equal(rows.some((row) => row.display_path.includes("guild_far")), false);

    const rulesRow = at(rulesPath);
    assert.ok(rulesRow, JSON.stringify(rows.map((row) => row.display_path)));
    assert.equal(rulesRow.level, "guild");
    assert.equal(rulesRow.changes, 2);
    assert.equal(rulesRow.writers, 2);
    assert.equal(rulesRow.reads, 2);
    assert.equal(rulesRow.top_writer?.share, 0.5);
    assert.equal(rulesRow.top_reader?.actor.name, "scout");
    assert.deepEqual(rulesRow.flags, []);

    const leadsRow = at(leads.display_path);
    assert.equal(leadsRow?.kind, "table");
    assert.equal(leadsRow?.changes, 2);
    assert.equal(leadsRow?.reads, 2);
    assert.ok(leadsRow?.flags.includes("deletes_others_rows"));

    const tallyRow = rows.find((row) => row.kind === "script");
    assert.equal(tallyRow?.reads, 2);
    const scoutMemory = rows.find((row) => row.kind === "memory" && row.display_path.includes("a_scout"));
    assert.equal(scoutMemory?.reads, 1);
    const idle = at(`${ownerPrefix("org_home", "guild", "guild_st")}idle.md`);
    assert.deepEqual(idle?.flags, ["no_agent_read"]);

    const tables = (await get("/state?kind=table")).json() as { items: Row[] };
    assert.deepEqual(tables.items.map((row) => row.kind), ["table"]);
    const scoutOnly = (await get("/state?agent=a_scout")).json() as { items: Row[] };
    assert.ok(scoutOnly.items.some((row) => row.display_path === rulesPath));
    assert.equal(scoutOnly.items.some((row) => row.display_path.includes("idle.md")), false);
    assert.equal((await get("/state?kind=routine")).statusCode, 422);

    // One item: who changed and read it how, and its history with links.
    const item = await get(`/state/item?path=${encodeURIComponent(leads.display_path)}`);
    assert.equal(item.statusCode, 200, item.body);
    const detail = item.json() as {
      changes: Array<{ actor: { name: string }; how: string; count: number }>;
      reads: Array<{ actor: { name: string }; how: string; count: number }>;
      history: Array<{ operation: string; actor: { name: string }; link: { kind: string; run_id?: string } | null; record: string | null }>;
      next_cursor: string | null;
    };
    assert.deepEqual(
      detail.reads.map((read) => `${read.actor.name}:${read.how}`).sort(),
      ["scout:embed", "scout:record_list"],
    );
    assert.deepEqual(detail.history.map((entry) => entry.operation), ["delete", "create"]);
    assert.equal(detail.history[0]?.link?.run_id, "r_writer");
    assert.ok(detail.history[0]?.record?.startsWith(`${leads.display_path}/`));
    assert.equal(detail.next_cursor, null);
    const deletes = (await get(`/state/item?path=${encodeURIComponent(leads.display_path)}&op=delete`)).json() as {
      history: unknown[];
    };
    assert.equal(deletes.history.length, 1);
    assert.equal((await get(`/state/item?path=${encodeURIComponent(leads.display_path)}&op=rename`)).statusCode, 422);
    assert.equal((await get(`/state/item?path=${encodeURIComponent(leads.display_path)}&cursor=oops`)).statusCode, 422);
    assert.equal((await get(`/state/item?path=${encodeURIComponent(`org/org_home/guilds/guild_far/${farNote.key}`)}`)).statusCode, 404);

    // A change by another guild's agent shows without its name and is not counted.
    await artifacts.writeNote(asRun("a_far", "far", "guild_far", "r_far"), {
      level: "guild",
      key: "rules.md",
      content: "Cite no source.\n",
      expectedVersion: 2,
    }).catch(() => null);
    const rulesItem = (await get(`/state/item?path=${encodeURIComponent(rulesPath)}`)).json() as {
      item: Row;
      history: Array<{ actor: { kind: string; name: string } }>;
    };
    assert.equal(rulesItem.item.changes, 2);
    assert.equal(rulesItem.history[0]?.actor.name, "writer");
  } finally {
    await app.close();
    await database.close();
  }
});
