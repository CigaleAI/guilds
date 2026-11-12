import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { getOpenBlockingIssue } from "../../src/db/blocking-issues.js";
import { getGroupChatState, listPendingGroupAgents } from "../../src/db/group-chat.js";
import { insertIssue } from "../../src/db/issues.js";
import { listDueSchedules } from "../../src/db/schedules.js";
import { listDueRunWakes } from "../../src/db/wakes.js";
import { generationLoop } from "../../src/generation/index.js";
import { userActor } from "../../src/lib/change-actor.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { ExportSandboxes } from "../helpers/live.js";
import { TEST_MODEL, connectModelProvider } from "../helpers/models.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

const TEST_ACTOR = userActor({ id: "user_operator", name: "operator" });
const OWNER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const JSON_BODY = { "content-type": "application/json" };

const dbName = uniqueDbName("agent_platform_blocking_issues");

after(async () => {
  await dropIsolatedDatabase(dbName);
});

test("an open blocking issue disables its agent until it is resolved", { timeout: 60_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const databaseUrl = await createIsolatedDatabase(dbName);
  const database = await connect(databaseUrl);
  const notes = new NotesStore(tempDir("guilds-blocking-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const db = database.pool;
  await connectModelProvider(db, "org_home", "deepinfra");
  const workspaceRoot = tempDir("guilds-blocking-workspaces-");
  const schedules = agentSchedules(db);
  const generation = generationLoop(db, {
    mcp: mcpPool(db),
    notes,
    workspaceRoot,
    sandboxes: new ExportSandboxes(workspaceRoot),
    artifacts: artifactStore(db, notes.templates),
  });
  const app = await buildApp(database, { db, notes, scripts: agentScripts(db), schedules, generation });

  const createAgent = async (guildId: string, name: string) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name, config: { model: TEST_MODEL, browser: false } },
    });
    assert.equal(response.statusCode, 201, response.body);
    return String(response.json().id);
  };
  const startRun = (agentId: string) =>
    app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/runs`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { message: "are you there?" },
    });

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/guilds",
      headers: { ...OWNER, ...JSON_BODY },
      payload: { name: "blocked-desk", visibility: "org" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const guildId = String(created.json().id);
    const blockedId = await createAgent(guildId, "blocked-keeper");
    const freeId = await createAgent(guildId, "free-keeper");

    const routines = [
      await schedules.create(TEST_ACTOR, blockedId, { when: { cron: "0 9 * * 1" }, description: "Weekly", instruction: "Do the pass." }),
      await schedules.create(TEST_ACTOR, freeId, { when: { cron: "0 9 * * 1" }, description: "Weekly", instruction: "Do the pass." }),
    ];
    await db.query(`UPDATE schedules SET next_run_at = $2 WHERE id = ANY($1::text[])`, [
      routines.map((routine) => routine.id),
      "2020-01-01T00:00:00.000Z",
    ]);
    await db.query(`UPDATE guilds SET group_chat_seq = 1 WHERE id = $1`, [guildId]);
    const dueAgents = async () => (await listDueSchedules(db, new Date())).map((row) => row.agent_id);
    const pendingAgents = async () => (await listPendingGroupAgents(db, guildId, 1)).map((row) => row.id);

    assert.equal(await getOpenBlockingIssue(db, blockedId), null);
    assert.deepEqual((await dueAgents()).sort(), [blockedId, freeId].sort());
    assert.deepEqual((await pendingAgents()).sort(), [blockedId, freeId].sort());

    const report = { guildId, orgId: "org_home", agentName: "blocked-keeper", runId: null, kind: "api" as const, detail: "401 on every call", toolName: null };
    await insertIssue(db, { ...report, issueId: "iss_high", agentId: blockedId, severity: "high", summary: "Slow feed" }, new Date());
    assert.equal(await getOpenBlockingIssue(db, blockedId), null);

    await insertIssue(db, { ...report, issueId: "iss_blocking", agentId: blockedId, severity: "blocking", summary: "Gmail login revoked" }, new Date());
    assert.deepEqual(await getOpenBlockingIssue(db, blockedId), { id: "iss_blocking", summary: "Gmail login revoked" });
    assert.equal(await getOpenBlockingIssue(db, freeId), null);
    assert.deepEqual(await dueAgents(), [freeId]);
    assert.deepEqual(await pendingAgents(), [freeId]);
    assert.equal((await getGroupChatState(db, guildId))?.pending_agent_count, 1);

    // An agentless blocking issue disables no one. 200 newer issues fill the inbox's page of
    // issues: the disabling issue is still listed, after them, and among the disabling issues.
    await insertIssue(db, { ...report, issueId: "iss_orphan", agentId: null, severity: "blocking", summary: "Agent gone" }, new Date());
    await db.query(
      `INSERT INTO guild_issues (id, guild_id, org_id, agent_id, agent_name, kind, severity, status, summary, detail, created_at, updated_at)
       SELECT 'iss_noise_' || n, $1, 'org_home', $2, 'free-keeper', 'other', 'low', 'open', 'noise', 'noise',
              now() + n * interval '1 second', now()
       FROM generate_series(1, 200) AS n`,
      [guildId, freeId],
    );
    const inbox = await app.inject({ method: "GET", url: "/api/notifications", headers: OWNER });
    assert.equal(inbox.statusCode, 200, inbox.body);
    const listed = inbox.json() as { issues: Array<{ id: string }>; disabling: Array<{ id: string; guild_name: string }> };
    assert.equal(listed.issues.length, 201);
    assert.equal(listed.issues.at(-1)?.id, "iss_blocking");
    assert.equal(listed.issues.some((issue) => issue.id === "iss_orphan"), false);
    assert.deepEqual(listed.disabling, [{ ...listed.disabling[0], id: "iss_blocking", guild_name: "blocked-desk" }]);
    await db.query(`DELETE FROM guild_issues WHERE id LIKE 'iss_noise_%'`);

    const idle = await app.inject({
      method: "POST",
      url: `/api/agents/${blockedId}/runs`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: {},
    });
    assert.equal(idle.statusCode, 201, idle.body);
    await db.query(
      `INSERT INTO run_wakes (id, run_id, root_run_id, agent_id, due_at, state, set_tool_call_id, created_at)
       VALUES ('wake_blocked', $1, $1, $2, '2020-01-01T00:00:00.000Z', 'pending', 'call_1', now())`,
      [String(idle.json().id), blockedId],
    );
    assert.deepEqual(await listDueRunWakes(db, new Date()), []);

    const refused = await startRun(blockedId);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(String(refused.json().detail), /agent is disabled by a blocking issue: Gmail login revoked\. Resolve the issue first/);

    const message = await app.inject({
      method: "POST",
      url: `/api/runs/${String(idle.json().id)}/messages`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { content: "are you there?" },
    });
    assert.equal(message.statusCode, 409, message.body);
    assert.match(String(message.json().detail), /agent is disabled by a blocking issue: Gmail login revoked/);

    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/guilds/${guildId}/issues/iss_blocking`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { status: "resolved" },
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(await getOpenBlockingIssue(db, blockedId), null);
    const cleared = await app.inject({ method: "GET", url: "/api/notifications", headers: OWNER });
    assert.deepEqual(cleared.json().disabling, []);
    assert.deepEqual((await dueAgents()).sort(), [blockedId, freeId].sort());
    assert.deepEqual((await pendingAgents()).sort(), [blockedId, freeId].sort());
    assert.deepEqual((await listDueRunWakes(db, new Date())).map((wake) => wake.id), ["wake_blocked"]);

    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/guilds/${guildId}/issues/iss_blocking`,
      headers: { ...OWNER, ...JSON_BODY },
      payload: { status: "open" },
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal((await startRun(blockedId)).statusCode, 409);
  } finally {
    await app.close();
    await generation.close();
    await database.close();
  }
});
