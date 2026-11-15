import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { connect } from "../../src/seed/connect.js";
import { generationLoop, LOOP_TIMINGS } from "../../src/generation/index.js";
import { generationLive } from "../../src/generation/completion.js";
import { type GenerationSandboxes } from "../../src/generation/machines.js";
import type { Completion } from "../../src/llm/completion.js";
import type { AssistantMessage } from "../../src/db/schema/index.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { insertUser } from "../../src/db/users.js";
import { insertMember, insertOrg } from "../../src/db/orgs.js";
import { getRun, listMessages } from "../../src/db/runs.js";
import { answerOps, HostCodeSandbox } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, tempDir } from "../helpers/env.js";
import { connectModelProvider } from "../helpers/models.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionMetadata, FakeSandboxes } from "../helpers/generation.js";
import { GitServer } from "../helpers/git-server.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";
import { codeDefaultMachine } from "../helpers/machines.js";

const live = generationLive;
const originalStream = live.streamCompletion;
const dbName = uniqueDbName("agent_platform_git_providers");
const READER = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const OWNER = { ...READER, "content-type": "application/json" };

after(async () => {
  live.streamCompletion = originalStream;
  await dropIsolatedDatabase(dbName);
});

/** A model that pushes a branch with `shell` once, then answers. */
const pushOnce = (async function* stream(options: { messages: Array<Record<string, unknown>> }) {
  const pushed = options.messages.at(-1)?.role === "tool";
  const command =
    "git checkout -q -b agent/coder/notes && printf 'note\\n' > NOTE.md && git add NOTE.md && " +
    "git commit -q -m 'Add a note' && git push -q origin agent/coder/notes 2>&1; " +
    'printf "pushed=%s gh=%s" "$?" "${GH_TOKEN:-none}"';
  const payload: AssistantMessage = pushed
    ? { role: "assistant", content: "pushed" }
    : {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c_push", type: "function", function: { name: "shell", arguments: JSON.stringify({ command }) } }],
      };
  const completion: Completion = {
    payload,
    metadata: completionMetadata({ finish_reason: pushed ? "stop" : "tool_calls", response_id: "c" }),
  };
  yield ["done", completion] as ["done", Completion];
}) as unknown as typeof live.streamCompletion;

test("a private repository on another host clones, checkpoints and pushes a branch with its stored access token", { timeout: 180_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  const server = new GitServer("oauth2", "glpat-private-token");
  const host = await server.listen();
  const bare = server.createRepository("team/app.git");
  const database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-git-providers-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  await connectModelProvider(db, "org_home", "openrouter");
  const artifacts = artifactStore(db, notes.templates);
  // The agent's machine, made once the agent has its id, which names its home.
  let sandbox: HostCodeSandbox | null = null;
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: { id: string }) => {
    sandboxes.running.add(machine.id);
    return sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const loop = generationLoop(
    db,
    { notes, workspaceRoot: tempDir("guilds-git-providers-ws-"), sandboxes: sandboxes as unknown as GenerationSandboxes, mcp: mcpPool(db), artifacts },
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

    // Deleting a secret deletes the repositories whose token it holds.
    const spareSecret = await createSecret("SPARE_TOKEN", "spare");
    assert.equal((await add({ name: "spare", url: `${host}/team/spare.git`, secret_id: spareSecret, username: "git" })).statusCode, 201);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/secrets/${spareSecret}`, headers: READER })).statusCode, 204);
    const listed = await app.inject({ method: "GET", url: base, headers: READER });
    assert.deepEqual(listed.json().repositories.map((row: { name: string }) => row.name), ["app"]);

    await codeDefaultMachine(app, OWNER);
    const agent = await app.inject({
      method: "POST",
      url: `/api/guilds/${String(guild.json().id)}/agents`,
      headers: OWNER,
      payload: {
        name: "coder",
        config: { model: "openrouter/openai/gpt-5.6-luna", browser: false, coding: true, harness: "claude-code", thinking_level: "none" },
      },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const agentId = String(agent.json().id);
    const used = new HostCodeSandbox(agentId, { GIT_SSL_CAINFO: server.caFile });
    // The harness is ready; the repository's clone and checkpoints run for real.
    answerOps(used, { check: { installed: true, version: "9.9.9 (stub)", credential: "secret" } });
    sandbox = used;

    live.streamCompletion = pushOnce;
    const runId = String((await loop.runs.createRun(agentId, null)).id);
    await loop.addMessage(runId, "add a note on a branch and push it");
    await loop.generations.task(runId);

    const run = await getRun(db, runId);
    assert.deepEqual((run?.metadata as { errors?: unknown[] }).errors ?? [], [], "the run starts without a token or clone error");
    const tokens = JSON.parse(readFileSync(used.local(`/run/guilds/${agentId}/git-tokens.json`), "utf8"));
    assert.deepEqual(tokens.repositories.app, {
      token: "glpat-private-token",
      expires_at: null,
      host: new URL(host).host,
      path: "team/app.git",
      username: "oauth2",
      provider: "access_token",
    });
    const rows = await listMessages(db, runId);
    const result = rows.find((row) => (row.payload as { role?: string }).role === "tool");
    assert.match(String((result?.payload as { content?: string }).content), /pushed=0 gh=none/, "the push succeeded, and gh gets no token outside GitHub");
    assert.deepEqual(server.branches(bare), ["agent/coder/notes", "main"]);
    const answered = server.requests.filter((request) => request.status === 200);
    assert.ok(answered.length >= 2, "the clone and the push each reached the repository");
    assert.ok(answered.every((request) => request.username === "oauth2"));
    assert.ok(server.requests.some((request) => request.status === 401 && request.username === null), "git asked anonymously first");
    const repos = (run?.metadata as { repos?: Array<Record<string, unknown>> }).repos ?? [];
    assert.equal(repos[0]?.name, "app");
    assert.equal(repos[0]?.branch, "agent/coder/notes");
    assert.equal(repos[0]?.files_changed, 1, "the end checkpoint records what the run changed");
  } finally {
    await loop.close();
    await app.close();
    await server.close();
    await database.close();
  }
});
