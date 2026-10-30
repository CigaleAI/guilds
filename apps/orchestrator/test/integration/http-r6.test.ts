import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { decodeMasterKey } from "../../src/config/index.js";
import { connect } from "../../src/seed/connect.js";
import { generationLive } from "../../src/generation/completion.js";
import { generationLoop } from "../../src/generation/index.js";
import { AsyncEvent, sleep } from "../../src/lib/event.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { HEX_MASTER_KEY, clearInstanceKeys, testEnv } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { loadJsonFixture, loadTextFixture, templatesRoot } from "../helpers/fixtures.js";
import {
  ExportSandboxes,
  openWs,
  readSse,
  startSandboxUpstream,
  StreamScript,
  wsRecv,
} from "../helpers/live.js";
import { PlaceholderMap } from "../helpers/placeholders.js";
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  uniqueDbName,
} from "../helpers/postgres.js";

const live = generationLive;
const originalStream = live.streamCompletion;

const AUTH = {
  "X-Guilds-User": "user_operator",
  "X-Guilds-Org": "org_home",
};

const GROUP_EVENTS = [
  "group.message.committed",
  "group.delivery.started",
  "group.delivery.finished",
  "group.idle",
  "guild.artifacts.changed",
  "agent.scripts.changed",
  "agent.routines.changed",
];

const recordings = loadJsonFixture<{
  cases: Array<{
    name: string;
    request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      json: unknown;
      params: Record<string, string> | null;
    };
    response: {
      status: number;
      headers?: Record<string, string>;
      json?: unknown;
      text?: string;
    };
  }>;
}>("http/routes.json");

const dbName = uniqueDbName("agent_platform_r6");

after(async () => {
  live.streamCompletion = originalStream;
  await dropIsolatedDatabase(dbName);
});

test("R6 HTTP SSE and WS recordings replay over real HTTP", { timeout: 180_000 }, async () => {
  clearInstanceKeys();
  const databaseUrl = await createIsolatedDatabase(dbName);
  const env = testEnv(databaseUrl);
  Object.assign(process.env, env);
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const database = await connect(databaseUrl);
  const notes = new NotesStore(env.NOTES_ROOT ?? "", templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "openrouter");
  const artifacts = artifactStore(database.pool, notes.templates);
  const scripts = agentScripts(db);
  const schedules = agentSchedules(db);
  const upstream = await startSandboxUpstream();
  const sandboxes = new ExportSandboxes(env.WORKSPACE_ROOT ?? "");
  sandboxes.novncBase = upstream.base;
  sandboxes.novncHeaders = { "OPEN-SANDBOX-API-KEY": "compat-test" };
  const stream = new StreamScript();
  live.streamCompletion = ((options: Parameters<typeof originalStream>[0]) =>
    stream.run(options)) as typeof live.streamCompletion;
  const generation = generationLoop(db, {
    notes,
    workspaceRoot: env.WORKSPACE_ROOT ?? "",
    sandboxes,
    mcp: mcpPool(db),
    artifacts,
  });
  await generation.reconcile();
  const app = await buildApp(database, {
    db,
    notes,
    artifacts,
    scripts,
    schedules,
    masterKey: decodeMasterKey(HEX_MASTER_KEY),
    mcp: mcpPool(db),
    generation,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const placeholders = new PlaceholderMap();
  const jsonByName = new Map<string, Record<string, unknown>>();
  let runSse: ReturnType<typeof readSse> | undefined;
  let cancelSse: ReturnType<typeof readSse> | undefined;
  let groupSse: ReturnType<typeof readSse> | undefined;
  const groupConnected = new AsyncEvent();
  try {
    for (const recorded of recordings.cases) {
      if (
        recorded.request.path.includes("/database/") ||
        recorded.name.startsWith("db-") ||
        recorded.name === "group-invalidation-db"
      ) {
        continue;
      }
      if (recorded.name === "run-cancel") {
        await sleep(300);
      }
      const path = placeholders.substituteText(recorded.request.path);
      const params = recorded.request.params
        ? Object.fromEntries(
            Object.entries(recorded.request.params).map(([key, value]) => [
              key,
              placeholders.remapRecordedId(placeholders.substituteText(value)),
            ]),
          )
        : null;
      const query = params ? `?${new URLSearchParams(params).toString()}` : "";
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(recorded.request.headers)) {
        headers[key] = placeholders.substituteText(value);
      }
      const method = recorded.request.method.toUpperCase();
      const init: RequestInit = { method, headers, redirect: "manual" };
      const vncPing =
        recorded.request.json === null &&
        (method === "POST" || method === "PUT" || method === "PATCH") &&
        path.includes("/browser/vnc");
      if (vncPing) {
        init.body = Buffer.from("ping");
      } else if (recorded.request.json !== null && recorded.request.json !== undefined) {
        headers["content-type"] = headers["content-type"] ?? "application/json";
        init.body = JSON.stringify(placeholders.substituteJson(recorded.request.json));
      }
      const response = await fetch(`${base}${path}${query}`, init);
      assert.equal(response.status, recorded.response.status, `${recorded.name} status`);
      const rawBody = Buffer.from(await response.arrayBuffer());
      if (Object.prototype.hasOwnProperty.call(recorded.response, "json")) {
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody.toString("utf8") || "null");
        } catch {
          payload = rawBody.toString("utf8");
        }
        try {
          placeholders.compare(recorded.response.json, payload, recorded.name);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${recorded.name}: ${message}\nactual: ${JSON.stringify(payload)}`, {
            cause: error,
          });
        }
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          jsonByName.set(recorded.name, payload as Record<string, unknown>);
        }
      } else if (Object.prototype.hasOwnProperty.call(recorded.response, "text")) {
        assert.equal(rawBody.toString("utf8"), recorded.response.text, `${recorded.name} text`);
      }
      if (recorded.name === "browser-vnc-gzip-get") {
        assert.equal(response.headers.get("content-encoding"), null, "gzip content-encoding stripped");
        assert.equal(response.headers.get("x-upstream"), "1", "gzip x-upstream");
        assert.equal(rawBody.toString("utf8"), "hello-novnc", "gzip body");
      }
      if (recorded.name === "run-message" || recorded.name === "run-create-with-message") {
        const id = String(jsonByName.get(recorded.name)?.id ?? "");
        await waitUntil(() => !generation.isGenerating(id), 10_000, recorded.name);
      }
      if (recorded.name === "sse-run-create") {
        const runId = String(jsonByName.get("sse-run-create")?.id ?? "");
        runSse = readSse(
          `${base}/api/runs/${runId}/stream`,
          AUTH,
          (text) => text.includes("event: generation.finished"),
          20_000,
        );
        await sleep(200);
      }
      if (recorded.name === "sse-run-message") {
        assert.ok(runSse, "run sse missing");
        const transcript = await runSse;
        assert.equal(placeholders.maskText(transcript.text), loadTextFixture("sse/run.txt"));
        const late = await readSse(
          `${base}/api/runs/${String(jsonByName.get("sse-run-create")?.id ?? "")}/stream`,
          AUTH,
          () => false,
          600,
        );
        assert.equal(placeholders.maskText(late.text), loadTextFixture("sse/run-reconnect.txt"));
        stream.mode = "hold";
        stream.resetHold();
      }
      if (recorded.name === "cancel-run-create") {
        const runId = String(jsonByName.get("cancel-run-create")?.id ?? "");
        cancelSse = readSse(
          `${base}/api/runs/${runId}/stream`,
          AUTH,
          (text) => text.includes("generation.cancelled") && text.includes("generation.finished"),
          20_000,
        );
        await sleep(200);
      }
      if (recorded.name === "run-cancel") {
        stream.hold.set();
        assert.ok(cancelSse, "cancel sse missing");
        const transcript = await cancelSse;
        assert.equal(placeholders.maskText(transcript.text), loadTextFixture("sse/run-cancel.txt"));
        stream.mode = "hello";
        const guildId = String(jsonByName.get("guild-create")?.id ?? "");
        groupSse = readSse(
          `${base}/api/guilds/${guildId}/group-chat/stream`,
          AUTH,
          (text) => GROUP_EVENTS.every((name) => text.includes(name)),
          30_000,
          groupConnected,
        );
        await Promise.race([
          groupConnected.wait(),
          sleep(5000).then(() => {
            throw new Error("group sse connect timeout");
          }),
        ]);
      }
      if (recorded.name === "group-post") {
        assert.ok(groupSse, "group sse missing");
        const transcript = await groupSse;
        const missing = GROUP_EVENTS.filter((name) => !transcript.text.includes(name));
        assert.deepEqual(missing, [], `group SSE missing ${missing.join(", ")}`);
        assert.equal(placeholders.maskText(transcript.text), loadTextFixture("sse/group.txt"));
        // The group run stores the operator post that woke it; every direct run stores who opened it.
        const woken = await database.pool.query(
          `SELECT r.wake_group_message_id, m.author_user_id
             FROM runs r JOIN group_messages m ON m.id = r.wake_group_message_id
            WHERE r.kind = 'group'`,
        );
        assert.deepEqual(
          woken.rows.map((row) => [Number(row.wake_group_message_id), row.author_user_id]),
          [[Number(jsonByName.get("group-post")?.id), "user_operator"]],
        );
        const direct = await database.pool.query(`SELECT DISTINCT started_by_user_id FROM runs WHERE kind = 'direct'`);
        assert.deepEqual(direct.rows, [{ started_by_user_id: "user_operator" }]);
      }
      if (recorded.name === "split-run") {
        const runId = String(jsonByName.get("split-run")?.id ?? "");
        const split = await readSse(`${base}/api/runs/${runId}/stream`, AUTH, () => false, 800);
        assert.equal(placeholders.maskText(split.text), loadTextFixture("sse/channel-split-run.txt"));
        const wsCases = loadJsonFixture<{
          cases: Array<{
            name: string;
            path: string;
            subprotocol: string | null;
            text_reply: string;
            bin_reply_prefix: string;
          }>;
        }>("ws/browser.json");
        for (const item of wsCases.cases) {
          const wsPath = placeholders.substituteText(item.path);
          const socket = await openWs(`ws://127.0.0.1:${port}${wsPath}`, AUTH);
          assert.equal(socket.protocol, item.subprotocol, item.name);
          socket.send("hello-text");
          const text = await wsRecv(socket);
          assert.equal(text.text, item.text_reply, `${item.name} text`);
          socket.send(Buffer.from("hello-bin"));
          const binary = await wsRecv(socket);
          const prefix = binary.binary ? binary.binary.subarray(0, 20).toString("latin1") : "";
          assert.equal(prefix, item.bin_reply_prefix, `${item.name} binary`);
          socket.close();
        }
      }
    }
  } finally {
    live.streamCompletion = originalStream;
    try {
      app.server.closeAllConnections();
    } catch {
      /* already closed */
    }
    await app.close();
    await generation.close();
    await database.close();
    await upstream.close();
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs: number, name: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`${name} timed out waiting for generation to finish`);
    }
    await sleep(50);
  }
}
