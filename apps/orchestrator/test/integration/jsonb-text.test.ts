import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Database } from "../../src/db/client.js";
import { formatJsonb } from "../../src/db/codecs.js";
import { insertGuild } from "../../src/db/guilds.js";
import { createRun, insertMessage, listMessages, nextSeq } from "../../src/db/runs.js";
import { connect } from "../../src/seed/connect.js";
import { addTestAgent } from "../helpers/agents.js";
import { agentConfig, runSnapshot } from "../helpers/generation.js";
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
