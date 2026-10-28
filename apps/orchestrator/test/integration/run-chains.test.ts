import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { connect } from "../../src/seed/connect.js";
import { HANDOFF_REQUEST, HANDOFF_TOOL_REFUSED } from "../../src/generation/chain.js";
import { generationDatabase, GenerationLoop, LOOP_TIMINGS, RunRequestError } from "../../src/generation/index.js";
import { generationLive } from "../../src/generation/completion.js";
import { type GenerationSandboxes } from "../../src/generation/machines.js";
import type { Completion } from "../../src/llm/index.js";
import type { AssistantMessage } from "../../src/db/schema/index.js";
import { mcpDatabase } from "../../src/mcp/database.js";
import { McpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { scriptDatabase, Scripts } from "../../src/scripts/catalog.js";
import { scheduleDatabase, Schedules } from "../../src/schedules/service.js";
import { answerOps, HostCodeSandbox } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionMetadata, FakeSandboxes } from "../helpers/generation.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { getRun, listMessages, listRuns, mergeRunMetadata } from "../../src/db/runs.js";
import { updateAgentConfig } from "../../src/db/agents.js";
import { agentConfig } from "../helpers/generation.js";
import { generationArtifacts } from "../../src/generation/prepare.js";

const live = generationLive;
const originalStream = live.streamCompletion;
const originalCount = live.countInputTokens;
const dbName = uniqueDbName("agent_platform_run_chains");

after(async () => {
  live.streamCompletion = originalStream;
  live.countInputTokens = originalCount;
  await dropIsolatedDatabase(dbName);
});

function completion(payload: AssistantMessage): Completion {
  return {
    payload,
    metadata: completionMetadata({ finish_reason: payload.tool_calls ? "tool_calls" : "stop", response_id: "c" }),
  };
}

type Reply = (messages: Array<Record<string, unknown>>) => AssistantMessage;

function script(reply: Reply) {
  return (async function* stream(options: { messages: Array<Record<string, unknown>> }) {
    yield ["done", completion(reply(options.messages))] as ["done", Completion];
  }) as unknown as typeof live.streamCompletion;
}

const lastContent = (messages: Array<Record<string, unknown>>) => String(messages.at(-1)?.content ?? "");
const shellCall = (id: string): AssistantMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name: "shell", arguments: '{"command":"echo step"}' } }],
});

test("a coding run near its input limit hands off and continues in a new run", { timeout: 120_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-chain-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "openrouter");
  const artifacts = artifactStore(database.pool, notes.templates);
  const sandbox = new HostCodeSandbox();
  // The harness is ready, and the guild's repository is already in the home: nothing is cloned.
  mkdirSync(path.join(sandbox.home, "repos", "shop"), { recursive: true });
  answerOps(sandbox, {
    check: { installed: true, version: "9.9.9 (stub)", credential: "secret" },
    git_setup: { failed: [] },
    checkpoint: { repositories: [] },
  });
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (agentId: string) => {
    sandboxes.running.add(agentId);
    return sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const loop = new GenerationLoop(
    {
      db: generationDatabase(db),
      notes,
      workspaceRoot: tempDir("guilds-chain-ws-"),
      sandboxes: sandboxes as unknown as GenerationSandboxes,
      mcp: new McpPool(mcpDatabase(db)),
      artifacts: generationArtifacts(artifacts),
    },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  // One hundred tokens per message: with a 1000-token input limit, the hand-off comes at 7 messages.
  live.countInputTokens = ((_model: string, payloads: unknown[]) => payloads.length * 100) as typeof live.countInputTokens;

  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts: new Scripts(scriptDatabase(db)),
    schedules: new Schedules(scheduleDatabase(db)),
    generation: loop,
  });
  const headers = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home", "content-type": "application/json" };
  const guild = await app.inject({ method: "POST", url: "/api/guilds", headers, payload: { name: "chains" } });
  assert.equal(guild.statusCode, 201, guild.body);
  const config = {
    model: "openrouter/openai/gpt-5.6-luna",
    temperature: 1,
    max_tokens: 64,
    max_steps: 30,
    max_tool_calls: 50,
    max_input_tokens: 1000,
    browser: false,
    coding: true,
    harness: "claude-code",
    thinking_level: "none",
  };
  await codeDefaultMachine(app, headers);
  const added = await app.inject({
    method: "POST",
    url: `/api/guilds/${String(guild.json().id)}/repositories`,
    headers,
    payload: { name: "shop", url: "https://git.example.com/team/shop.git" },
  });
  assert.equal(added.statusCode, 201, added.body);
  const agent = await app.inject({
    method: "POST",
    url: `/api/guilds/${String(guild.json().id)}/agents`,
    headers,
    payload: { name: "chainer", config },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  const agentId = String(agent.json().id);
  try {
    live.streamCompletion = script((messages) => {
      const last = lastContent(messages);
      if (last === HANDOFF_REQUEST) {
        return { role: "assistant", content: "Goal: ship refunds. Done: tests. Remains: docs. See src/refund.ts:12." };
      }
      if (String(messages[1]?.content ?? "").startsWith("Continuation:")) {
        return { role: "assistant", content: "picked up" };
      }
      return shellCall(`c${messages.length}`);
    });
    const created = await loop.runs.createRun(agentId, "start the task");
    const first = String(created.id);
    const continued: string[] = [];
    const queue = loop.events.subscribe(first);
    await loop.generations.task(first);
    while (queue.size) {
      const [event, data] = await queue.get();
      if (event === "run.continued") {
        continued.push(String(data.run_id));
      }
    }

    const runA = (await getRun(db, first))!;
    const metaA = runA.metadata as Record<string, unknown>;
    assert.equal(runA.status, "completed");
    const second = String(metaA.continued_by_run_id);
    assert.deepEqual(continued, [second]);
    const rowsA = await listMessages(db, first);
    const request = rowsA.find((row) => (row.metadata as Record<string, unknown>).source === "handoff");
    assert.equal((request?.payload as Record<string, unknown>).content, HANDOFF_REQUEST);
    assert.match(String((rowsA.at(-1)?.payload as Record<string, unknown>).content), /^Goal: ship refunds/);

    const runB = (await getRun(db, second))!;
    assert.equal(runB.kind, "direct");
    assert.equal(runB.status, "active");
    assert.deepEqual((runB.metadata as Record<string, unknown>).chain, { root_run_id: first, index: 2, previous_run_id: first });
    const rowsB = await listMessages(db, second);
    const opening = rowsB[1]!;
    assert.equal((opening.metadata as Record<string, unknown>).source, "continuation");
    const body = JSON.parse(String((opening.payload as Record<string, unknown>).content).slice("Continuation: ".length));
    assert.deepEqual(body, {
      previous_run_id: first,
      handoff: "Goal: ship refunds. Done: tests. Remains: docs. See src/refund.ts:12.",
    });
    assert.equal((rowsB.at(-1)?.payload as Record<string, unknown>).content, "picked up");
    assert.equal(loop.isAgentBusy(agentId), false);

    const view = loop.runView(runB);
    assert.deepEqual(view.chain, { root_run_id: first, index: 2, previous_run_id: first });
    assert.equal(loop.runView(runA).continued_by_run_id, second);

    await assert.rejects(loop.addMessage(first, "more"), (error: unknown) =>
      error instanceof RunRequestError && error.status === 409 && error.detail.includes(`continued in run ${second}`),
    );
    await assert.rejects(loop.resumeRun(first), (error: unknown) => error instanceof RunRequestError && error.status === 409);

    // A hand-off answered with tool calls: the calls are refused, and no text means no hand-off.
    live.streamCompletion = script((messages) => {
      const last = lastContent(messages);
      if (last === HANDOFF_REQUEST) {
        return shellCall("c_handoff");
      }
      if (String(messages[1]?.content ?? "").startsWith("Continuation:")) {
        return { role: "assistant", content: "resumed" };
      }
      return shellCall(`c${messages.length}`);
    });
    const third = String((await loop.runs.createRun(agentId, "again")).id);
    await loop.generations.task(third);
    const rowsC = await listMessages(db, third);
    const refused = rowsC.find((row) => (row.payload as Record<string, unknown>).tool_call_id === "c_handoff");
    assert.match(String((refused?.payload as Record<string, unknown>).content), new RegExp(`^${HANDOFF_TOOL_REFUSED}`));
    const fourth = String(((await getRun(db, third))!.metadata as Record<string, unknown>).continued_by_run_id);
    const openingD = (await listMessages(db, fourth))[1]!;
    const bodyD = JSON.parse(String((openingD.payload as Record<string, unknown>).content).slice("Continuation: ".length));
    assert.equal(bodyD.handoff, null);
    assert.match(String(bodyD.note), /no hand-off/);

    // The fifth run of a chain completes at the hand-off point instead of starting a sixth.
    live.streamCompletion = script((messages) => shellCall(`c${messages.length}`));
    const fifth = String((await loop.runs.createRun(agentId, null)).id);
    await mergeRunMetadata(db, fifth, { chain: { root_run_id: first, index: 5, previous_run_id: second } }, new Date());
    await loop.addMessage(fifth, "go on");
    await loop.generations.task(fifth);
    const runE = (await getRun(db, fifth))!;
    assert.equal(runE.status, "completed");
    assert.equal((runE.metadata as Record<string, unknown>).continued_by_run_id, undefined);
    assert.equal((runE.errors as Array<Record<string, unknown>>).at(-1)?.operation, "generation.max_chain");

    // A group delivery completes, and its cursor advances, when the chain ends.
    live.streamCompletion = script((messages) => {
      const last = lastContent(messages);
      if (last === HANDOFF_REQUEST) {
        return { role: "assistant", content: "Hand-off for the group task." };
      }
      if (String(messages[1]?.content ?? "").startsWith("Continuation:")) {
        return { role: "assistant", content: "group done" };
      }
      return shellCall(`c${messages.length}`);
    });
    const guildId = String(guild.json().id);
    const posted = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/group-chat/messages`,
      headers,
      payload: { content: "@chainer take the refunds task" },
    });
    assert.equal(posted.statusCode, 202, posted.body);
    const groupRuns = async () => (await listRuns(db, agentId)).filter((row) => row.kind === "group");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const runs = await groupRuns();
      if (runs.length === 2 && runs.every((row) => row.status === "completed") && !loop.groupChat.is_dispatching(guildId)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [later, earlier] = await groupRuns();
    const root = (earlier!.metadata as Record<string, unknown>).chain ? later! : earlier!;
    const next = root === earlier ? later! : earlier!;
    assert.equal((root.metadata as Record<string, unknown>).continued_by_run_id, next.id);
    assert.equal(root.status, "completed");
    assert.equal(next.status, "completed");
    assert.equal(next.group_chat_through_seq, root.group_chat_through_seq);
    const cursor = await database.pool.query("SELECT group_chat_delivered_through FROM agents WHERE id = $1", [agentId]);
    assert.equal(Number(cursor.rows[0]?.group_chat_delivered_through), Number(root.group_chat_through_seq));

    // A run without coding keeps the terminal cap.
    await updateAgentConfig(db, agentId, agentConfig({ ...config, coding: false, harness: null }), new Date(), {});
    live.streamCompletion = script((messages) => shellCall(`c${messages.length}`));
    const plain = String((await loop.runs.createRun(agentId, "plain")).id);
    await loop.generations.task(plain);
    const runF = (await getRun(db, plain))!;
    assert.equal((runF.metadata as Record<string, unknown>).continued_by_run_id, undefined);
    assert.equal((runF.errors as Array<Record<string, unknown>>).at(-1)?.operation, "generation.max_input_tokens");
  } finally {
    await loop.close();
    await app.close();
    await database.close();
  }
});
