import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { connect } from "../../src/seed/connect.js";
import { generationLoop, LOOP_TIMINGS } from "../../src/generation/index.js";
import { harnessTurnTiming } from "../../src/generation/harness-loop.js";
import { type GenerationSandboxes } from "../../src/generation/machines.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember, insertOrg } from "../../src/db/orgs.js";
import { getRun } from "../../src/db/runs.js";
import { sleep } from "../../src/lib/event.js";
import { answerOps } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { FakeSandboxes } from "../helpers/generation.js";
import { recordedEvents, runLine, stubCliSandbox } from "../helpers/harness-cli.js";
import { GitServer } from "../helpers/git-server.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { codeDefaultMachine } from "../helpers/machines.js";

const timing = { ...harnessTurnTiming };
const [INIT] = recordedEvents("claude-code");
const REPLY = recordedEvents("claude-code").slice(-2);
const dbName = uniqueDbName("agent_platform_git_providers");
const READER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const OWNER = { ...READER, "content-type": "application/json" };

after(async () => {
  Object.assign(harnessTurnTiming, timing);
  await dropIsolatedDatabase(dbName);
});

test("a private repository on another host clones and pushes a branch with its stored access token; each agent of the guild gets only its own repositories", { timeout: 180_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  const server = new GitServer("oauth2", "glpat-private-token");
  const host = await server.listen();
  const bare = server.createRepository("team/app.git");
  server.createRepository("team/site.git");
  const database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-git-providers-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  // The agent's machine, made once the agent has its id, which names its home.
  let stub: ReturnType<typeof stubCliSandbox> | null = null;
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: { id: string }) => {
    sandboxes.running.add(machine.id);
    return stub?.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const loop = generationLoop(
    db,
    { notes, workspaceRoot: tempDir("guilds-git-providers-ws-"), harnessMcpUrl: "http://127.0.0.1:8090", sandboxes: sandboxes as unknown as GenerationSandboxes, mcp: mcpPool(db), artifacts },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  const app = await buildApp(database, { db, notes, artifacts, scripts: agentScripts(db), schedules: agentSchedules(db), generation: loop });
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: OWNER, payload: { name: "elsewhere" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const base = `/api/guilds/${String(guild.json().id)}/repositories`;
    const createSecret = async (name: string, value: string, headers: Record<string, string> = OWNER) => {
      const created = await app.inject({ method: "POST", url: "/api/secrets", headers, payload: { name, description: "git", value } });
      assert.equal(created.statusCode, 201, created.body);
      return String(created.json().id);
    };
    const tokenSecret = await createSecret("GIT_HOST_TOKEN", "glpat-private-token");
    const url = `${host}/team/app.git`;

    // The credential is one of a GitHub login, a whole access token, or none.
    const add = (payload: Record<string, unknown>, headers: Record<string, string> = OWNER) =>
      app.inject({ method: "POST", url: base, headers, payload });
    const halfToken = await add({ name: "app", url, secret_id: tokenSecret });
    assert.equal(halfToken.statusCode, 422, halfToken.body);
    assert.match(halfToken.json().detail, /an access token takes secret_id and a username/);
    const spacedName = await add({ name: "app", url, secret_id: tokenSecret, username: "two words" });
    assert.equal(spacedName.statusCode, 422, spacedName.body);
    const both = await add({ name: "app", url, secret_id: tokenSecret, username: "oauth2", connection_id: "conn_x" });
    assert.equal(both.statusCode, 422, both.body);
    assert.match(both.json().detail, /one credential/);
    const loginElsewhere = await add({ name: "app", url, connection_id: "conn_x" });
    assert.equal(loginElsewhere.statusCode, 422, loginElsewhere.body);
    assert.match(loginElsewhere.json().detail, /with a GitHub connection, url must be https:\/\/github\.com/);
    const ssh = await add({ name: "app", url: "ssh://git@127.0.0.1/team/app.git", secret_id: tokenSecret, username: "oauth2" });
    assert.equal(ssh.statusCode, 422, ssh.body);
    const unknown = await add({ name: "app", url, secret_id: "sec_missing", username: "oauth2" });
    assert.equal(unknown.statusCode, 404, unknown.body);
    // A secret of another organisation the operator also owns is not this guild's to use.
    await insertOrg(db, { orgId: "org_other", name: "Other", slug: "other", userId: "user_operator" }, new Date());
    const otherSecret = await createSecret("OTHER_TOKEN", "other", { ...OWNER, "X-Guilds-Org": "org_other" });
    const elsewhere = await add({ name: "app", url, secret_id: otherSecret, username: "oauth2" });
    assert.equal(elsewhere.statusCode, 404, elsewhere.body);
    assert.equal(elsewhere.json().detail, "secret not found");

    // A member who does not manage the secret cannot give its value to the guild's agents.
    const member = await insertUser(db, { userId: "user_member", name: "member", image: null, email: "member@example.com" }, new Date());
    await insertMember(db, { org_id: "org_home", user_id: member.id, role: "member" }, new Date());
    const refused = await add({ name: "app", url, secret_id: tokenSecret, username: "oauth2" }, { ...OWNER, "X-Guilds-User": "user_member" });
    assert.equal(refused.statusCode, 403, refused.body);

    const added = await add({ name: "app", url, secret_id: tokenSecret, username: "oauth2" });
    assert.equal(added.statusCode, 201, added.body);
    assert.equal(added.json().provider, "access_token");
    assert.equal(added.json().username, "oauth2");
    assert.deepEqual(added.json().secret, { id: tokenSecret, name: "GIT_HOST_TOKEN" });
    assert.equal(added.json().connection, null);
    assert.equal(added.json().default_branch, "main");
    assert.equal((await add({ name: "site", url: `${host}/team/site.git`, secret_id: tokenSecret, username: "oauth2" })).statusCode, 201);

    // Deleting a secret deletes the repositories whose token it holds.
    const spareSecret = await createSecret("SPARE_TOKEN", "spare");
    assert.equal((await add({ name: "spare", url: `${host}/team/spare.git`, secret_id: spareSecret, username: "git" })).statusCode, 201);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/secrets/${spareSecret}`, headers: READER })).statusCode, 204);
    const listed = await app.inject({ method: "GET", url: base, headers: READER });
    assert.deepEqual(listed.json().repositories.map((row: { name: string }) => row.name), ["app", "site"]);

    const machineId = await codeDefaultMachine(app, OWNER);
    await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
    const createAgent = async (name: string, repositories: string[]) => {
      const created = await app.inject({
        method: "POST",
        url: `/api/guilds/${String(guild.json().id)}/agents`,
        headers: OWNER,
        payload: { name, config: { model: null, harness: "claude-code", repositories }, machine_id: machineId },
      });
      assert.equal(created.statusCode, 201, created.body);
      return String(created.json().id);
    };
    /** Runs one turn of `agentId`, its stand-in CLI replaying `lines` in its repository; the run as it ended. */
    const runTurn = async (agentId: string, lines: string[]) => {
      stub = stubCliSandbox("claude", [INIT!, ...lines, ...REPLY], { GIT_SSL_CAINFO: server.caFile }, agentId);
      answerOps(stub.sandbox, { check: { installed: true, version: "9.9.9 (stub)", credential: "secret" } });
      const runId = String((await loop.runs.createRun(agentId, null)).id);
      await loop.addMessage(runId, "add a note on a branch and push it");
      for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
        await sleep(25);
      }
      return { run: await getRun(db, runId), home: stub.sandbox.home };
    };
    const agentId = await createAgent("coder", ["app"]);
    const pushed = await runTurn(agentId, [
      runLine("git", "checkout", "-q", "-b", "agent/coder/notes"),
      runLine("sh", "-c", "printf 'note\\n' > NOTE.md && git add NOTE.md && git commit -q -m 'Add a note'"),
      runLine("git", "push", "-q", "origin", "agent/coder/notes"),
    ]);
    assert.deepEqual(pushed.run?.errors ?? [], [], "the run starts without a token or clone error");
    assert.deepEqual(server.branches(bare), ["agent/coder/notes", "main"]);
    const answered = server.requests.filter((request) => request.status === 200);
    assert.ok(answered.length >= 2, "the clone and the push each reached the repository");
    assert.ok(answered.every((request) => request.username === "oauth2"));
    assert.ok(server.requests.some((request) => request.status === 401 && request.username === null), "git asked anonymously first");
    assert.equal(existsSync(path.join(pushed.home, "repos", "site")), false, "the agent clones only the repositories it picks");

    // Another agent of the guild picks the other repository, and its run reaches that one only.
    const reviewerId = await createAgent("reviewer", ["site"]);
    const reviewed = await runTurn(reviewerId, []);
    assert.deepEqual(reviewed.run?.errors ?? [], []);
    assert.equal(existsSync(path.join(reviewed.home, "repos", "site", ".git")), true);
    assert.equal(existsSync(path.join(reviewed.home, "repos", "app")), false);
  } finally {
    await loop.close();
    await app.close();
    await server.close();
    await database.close();
  }
});
