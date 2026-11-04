import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import type { Database } from "../../src/db/client.js";
import { getRun } from "../../src/db/runs.js";
import { generationLive } from "../../src/generation/completion.js";
import { generationLoop, type GenerationLoop } from "../../src/generation/index.js";
import type { ModelRequest } from "../../src/llm/completion.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { connect } from "../../src/seed/connect.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionCalling, completionReply, toolCall } from "../helpers/generation.js";
import { ExportSandboxes } from "../helpers/live.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { installCountingTokenEncodingLoader, restoreTokenEncodingLoader } from "../helpers/tokens.js";

const OWNER = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
  "content-type": "application/json",
};

const OPENING = "Summarise the weekly note and keep the canonical finding.";

const dbName = uniqueDbName("agent_platform_run_input_tokens");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("a run counts every model step with one encoding load, and its local count decides the input limit", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const previousStream = generationLive.streamCompletion;
  let modelCalls = 0;
  generationLive.streamCompletion = async function* stream(request: ModelRequest) {
    modelCalls += 1;
    if (request.messages.at(-1)?.role === "tool") {
      yield ["done", completionReply("The canonical finding stays.")];
      return;
    }
    yield ["done", completionCalling([toolCall("call_1", "note_lookup")])];
  };
  let database: Database | null = null;
  let loop: GenerationLoop | null = null;
  let app: FastifyInstance | null = null;
  try {
    const encoding = installCountingTokenEncodingLoader();
    database = await connect(await createIsolatedDatabase(dbName));
    const db = database.pool;
    const notes = new NotesStore(tempDir("guilds-run-tokens-notes-"), templatesRoot());
    await notes.ensureSystemPrompt();
    await connectModelProvider(db, "org_home", "deepinfra");
    const artifacts = artifactStore(db, notes.templates);
    const workspaceRoot = tempDir("guilds-run-tokens-ws-");
    loop = generationLoop(db, {
      mcp: mcpPool(db),
      notes,
      workspaceRoot,
      sandboxes: new ExportSandboxes(workspaceRoot),
      artifacts,
    });
    const generation = loop;
    app = await buildApp(database, {
      db,
      notes,
      artifacts,
      scripts: agentScripts(db),
      schedules: agentSchedules(db),
      generation,
    });
    const server = app;
    const guild = await server.inject({ method: "POST", url: "/api/guilds", headers: OWNER, payload: { name: "token-desk" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const config = { model: TEST_MODEL, browser: false, max_input_tokens: 100_000 };
    const agent = await server.inject({
      method: "POST",
      url: `/api/guilds/${String(guild.json().id)}/agents`,
      headers: OWNER,
      payload: { name: "counter", config },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);

    const startRun = async (maxInputTokens: number): Promise<string> => {
      const configured = await server.inject({
        method: "PUT",
        url: `/api/agents/${agentId}/config`,
        headers: OWNER,
        payload: { config: { ...config, max_input_tokens: maxInputTokens } },
      });
      assert.equal(configured.statusCode, 200, configured.body);
      const created = await server.inject({
        method: "POST",
        url: `/api/agents/${agentId}/runs`,
        headers: OWNER,
        payload: { message: OPENING },
      });
      assert.equal(created.statusCode, 202, created.body);
      const runId = String(created.json().id);
      await generation.generations.task(runId);
      return runId;
    };
    const fitting = await startRun(100_000);
    assert.equal(modelCalls, 2);
    assert.equal(encoding.loads, 1);
    const openingTokens = encoding.counts[0];
    const toolRoundTokens = encoding.counts.at(-1);
    assert.ok(openingTokens !== undefined && toolRoundTokens !== undefined && toolRoundTokens > openingTokens);
    assert.deepEqual((await getRun(db, fitting))?.errors, []);

    const limit = Math.floor((openingTokens + toolRoundTokens) / 2);
    const countsBeforeLimited = encoding.counts.length;
    const limited = await startRun(limit);
    const limitedCounts = encoding.counts.slice(countsBeforeLimited);
    const limitedOpening = limitedCounts[0];
    const limitedToolRound = limitedCounts.at(-1);
    assert.ok(limitedOpening !== undefined && limitedOpening <= limit);
    assert.ok(limitedToolRound !== undefined && limitedToolRound > limit);
    assert.equal(modelCalls, 3);
    const limitedRun = await getRun(db, limited);
    assert.equal(limitedRun?.status, "completed");
    assert.equal(limitedRun?.errors.at(-1)?.operation, "generation.max_input_tokens");
    assert.equal(encoding.loads, 1);
  } finally {
    restoreTokenEncodingLoader();
    generationLive.streamCompletion = previousStream;
    await loop?.close();
    await app?.close();
    await database?.close();
  }
});
