import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { formatJsonb } from "../../src/db/codecs.js";
import { insertGuild } from "../../src/db/guilds.js";
import { createRun, getRun, insertMessage, listMessages, nextSeq } from "../../src/db/runs.js";
import { getUsage } from "../../src/db/usage.js";
import { messageItem, type MessageView } from "../../src/db/views.js";
import { generationLive } from "../../src/generation/completion.js";
import { generationLoop } from "../../src/generation/index.js";
import type { ModelRequest } from "../../src/llm/completion.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { connect } from "../../src/seed/connect.js";
import { addTestAgent } from "../helpers/agents.js";
import { tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { agentConfig, completionMetadata, runSnapshot } from "../helpers/generation.js";
import { ExportSandboxes } from "../helpers/live.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const dbName = uniqueDbName("agent_platform_jsonb_text");
const RUN = "r_jsonb_text";
let database: Database;

before(async () => {
  database = await connect(await createIsolatedDatabase(dbName));
  const now = new Date();
  await insertGuild(database.pool, { guildId: "guild_jsonb", name: "jsonb-guild", orgId: "org_home" }, now);
  const config = agentConfig({ model: "openrouter/openai/gpt-5.6-luna" });
  await addTestAgent(
    database.pool,
    "org_home",
    { agentId: "a_jsonb", guildId: "guild_jsonb", name: "jsonb-agent", config },
    now,
  );
  await createRun(
    database.pool,
    {
      runId: RUN,
      agentId: "a_jsonb",
      configSnapshot: runSnapshot(config),
      systemContent: "system",
      taskContent: "task",
      userContent: null,
      systemPromptHash: "system",
      taskPromptHash: "task",
      memoryPromptHash: "memory",
    },
    now,
  );
});

after(async () => {
  await database.close();
  await dropIsolatedDatabase(dbName);
});

test("jsonb refuses a NUL and an unpaired surrogate that JSON.stringify writes, and takes them as jsonb text", async () => {
  for (const [text, refusal] of [
    ["a\u0000b", /unsupported Unicode escape sequence/],
    ["a\ud800b", /invalid input syntax for type json/],
  ] as const) {
    await assert.rejects(database.pool.query("SELECT $1::jsonb", [JSON.stringify({ text })]), refusal);
    const stored = await database.pool.query<{ value: { text: string } }>("SELECT $1::jsonb AS value", [
      formatJsonb({ text }),
    ]);
    assert.equal(stored.rows[0]?.value.text, "a\ufffdb");
  }
});

test("a tool call whose arguments hold a NUL or an unpaired surrogate is stored and read back", async () => {
  const written = await insertMessage(
    database.pool,
    {
      runId: RUN,
      seq: await nextSeq(database.pool, RUN),
      payload: {
        role: "assistant",
        content: "😀 \\u0000",
        tool_calls: [
          {
            id: "call_\u0000",
            type: "function",
            function: { name: "write_file", arguments: '{"text":"x\u0000y\udc00"}' },
          },
        ],
      },
      metadata: { generation: 1 },
    },
    new Date(),
  );
  const read = (await listMessages(database.pool, RUN)).find((row) => row.seq === written.seq);
  assert.deepEqual(read?.payload, written.payload);
  assert.deepEqual(read?.payload, {
    role: "assistant",
    content: "😀 \\u0000",
    tool_calls: [
      {
        id: "call_\ufffd",
        type: "function",
        function: { name: "write_file", arguments: '{"text":"x\ufffdy\ufffd"}' },
      },
    ],
  });
});

test("a run whose system and opening messages hold a NUL or an unpaired surrogate is created and read back", async () => {
  const runId = "r_jsonb_opening";
  await createRun(
    database.pool,
    {
      runId,
      agentId: "a_jsonb",
      configSnapshot: runSnapshot(agentConfig({ model: "openrouter/openai/gpt-5.6-luna" })),
      systemContent: "system \u0000",
      taskContent: "task",
      userContent: "open \udc00",
      systemPromptHash: "system",
      taskPromptHash: "task",
      memoryPromptHash: "memory",
    },
    new Date(),
  );
  assert.deepEqual(
    (await listMessages(database.pool, runId)).map((row) => row.payload.content),
    ["system \ufffd", "open \ufffd"],
  );
});

test("a run whose opening and replies hold a NUL or an unpaired surrogate stores, publishes, and continues on the stored text", { timeout: 60_000 }, async () => {
  const db = database.pool;
  const previousStream = generationLive.streamCompletion;
  const requests: ModelRequest[] = [];
  generationLive.streamCompletion = async function* stream(request: ModelRequest) {
    requests.push(request);
    const usage = { input_tokens: 7, output_tokens: 3, cache_read_tokens: 0 };
    if (request.messages.at(-1)?.role === "tool") {
      yield ["done", {
        payload: { role: "assistant", content: "done \ud800" },
        metadata: completionMetadata({ usage, response_id: "resp_\ud800" }),
      }];
      return;
    }
    yield ["done", {
      payload: {
        role: "assistant",
        content: "looking \udc00",
        tool_calls: [{ id: "call_\u0000", type: "function", function: { name: "note_lookup", arguments: '{"q":"a\u0000"}' } }],
      },
      metadata: completionMetadata({ usage, finish_reason: "tool_calls", response_id: "resp_\u0000" }),
    }];
  };
  const notes = new NotesStore(tempDir("guilds-jsonb-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  await connectModelProvider(db, "org_home", "deepinfra");
  const artifacts = artifactStore(db, notes.templates);
  const workspaceRoot = tempDir("guilds-jsonb-ws-");
  const loop = generationLoop(db, {
    mcp: mcpPool(db),
    notes,
    workspaceRoot,
    harnessMcpUrl: "http://127.0.0.1:8090",
    sandboxes: new ExportSandboxes(workspaceRoot),
    artifacts,
  });
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts: agentScripts(db),
    schedules: agentSchedules(db),
    generation: loop,
  });
  try {
    const headers = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home", "content-type": "application/json" };
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers, payload: { name: "jsonb-run-guild" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${String(guild.json().id)}/agents`,
      headers,
      payload: { name: "jsonb-runner", config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);

    const runId = String((await loop.runs.createRun(agentId, null)).id);
    const queue = loop.events.subscribe(runId);
    await loop.addMessage(runId, "open \u0000 \ud800");
    await loop.generations.task(runId);
    const published: MessageView[] = [];
    while (queue.size) {
      const [event, data] = await queue.get();
      if (event === "message.committed") {
        published.push(data);
      }
    }

    const rows = await listMessages(db, runId);
    assert.deepEqual(rows.map((row) => row.seq), rows.map((_, index) => index));
    const [opening, call, result, reply] = rows.slice(-4);
    assert.ok(opening && call && result && reply);
    assert.deepEqual(opening.payload, { role: "user", content: "open \ufffd \ufffd" });
    assert.deepEqual(call.payload, {
      role: "assistant",
      content: "looking \ufffd",
      tool_calls: [{ id: "call_\ufffd", type: "function", function: { name: "note_lookup", arguments: '{"q":"a\ufffd"}' } }],
    });
    assert.equal(call.metadata.response_id, "resp_\ufffd");
    assert.ok(result.payload.role === "tool");
    assert.equal(result.payload.tool_call_id, "call_\ufffd");
    assert.deepEqual(reply.payload, { role: "assistant", content: "done \ufffd" });
    assert.equal(reply.metadata.response_id, "resp_\ufffd");
    assert.deepEqual(published, [call, result, reply].map(messageItem), "each committed message is published as the row stored");

    assert.equal(requests.length, 2, "the generation continues after the tool result");
    assert.deepEqual(requests[1]?.messages.slice(-3), [opening, call, result].map((row) => row.payload));
    assert.deepEqual((await getRun(db, runId))?.errors, []);
    const usage = await getUsage(db, "agent", agentId);
    assert.equal(usage?.calls, 2);
    assert.equal(usage?.input_tokens, 14);
    assert.equal(usage?.output_tokens, 6);

    const openedId = String((await loop.runs.createRun(agentId, "first \u0000 \udc00")).id);
    await loop.generations.task(openedId);
    const openedRows = await listMessages(db, openedId);
    const initial = openedRows.find((row) => row.payload.role === "user");
    assert.deepEqual(initial?.payload, { role: "user", content: "first \ufffd \ufffd" });
    assert.equal(requests.length, 4, "the run opened with a message generates until its reply");
    assert.deepEqual(requests[2]?.messages.at(-1), initial?.payload);
    assert.deepEqual(openedRows.at(-1)?.payload, { role: "assistant", content: "done \ufffd" });
    assert.deepEqual((await getRun(db, openedId))?.errors, []);
  } finally {
    generationLive.streamCompletion = previousStream;
    await loop.close();
    await app.close();
  }
});
