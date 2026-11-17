import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import type { Queryable } from "../../src/db/pg.js";
import { generationLoop, LOOP_TIMINGS } from "../../src/generation/index.js";
import { harnessTurnTiming } from "../../src/generation/harness-loop.js";
import { type GenerationSandboxes } from "../../src/generation/machines.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { sleep } from "../../src/lib/event.js";
import { mcpPool } from "../../src/mcp/pool.js";
import { NotesStore } from "../../src/notes/store.js";
import type { MachineSpec } from "../../src/sandbox/index.js";
import { agentSchedules } from "../../src/schedules/service.js";
import { agentScripts } from "../../src/scripts/catalog.js";
import { connect } from "../../src/seed/connect.js";
import { answerOps } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, storeKeys, tempDir } from "../helpers/env.js";
import { templatesRoot } from "../helpers/fixtures.js";
import { completionReply, FakeSandboxes } from "../helpers/generation.js";
import { connectModelProvider, TEST_MODEL } from "../helpers/models.js";
import { generationLive } from "../../src/generation/completion.js";
import { GitServer } from "../helpers/git-server.js";
import { recordedEvents, runLine, stubCliSandbox } from "../helpers/harness-cli.js";
import { codeDefaultMachine } from "../helpers/machines.js";
import { createIsolatedDatabase, dropIsolatedDatabase, uniqueDbName } from "../helpers/postgres.js";

// A Claude Code subscription agent with a repository on a private git host, driven through the
// run API: its turn runs the stand-in CLI in the repository's working tree, which commits and
// pushes a branch through the image's git credential helper.

const AUTH = { "X-Guilds-User": "user_operator", "X-Guilds-Org": "org_home" };
const HEADERS = { ...AUTH, "content-type": "application/json" };
const TOKEN = "glpat-subscription-token";
const dbName = uniqueDbName("agent_platform_subscription_repositories");
/** The databases each GitHub turn made, dropped once every test is done. */
const githubDbNames: string[] = [];
const timing = { ...harnessTurnTiming };
const [INIT] = recordedEvents("claude-code");
const REPLY = recordedEvents("claude-code").slice(-2);

after(async () => {
  Object.assign(harnessTurnTiming, timing);
  await dropIsolatedDatabase(dbName);
  for (const name of githubDbNames) {
    await dropIsolatedDatabase(name);
  }
});

type MessageView = { payload: { role: string; content: string }; metadata: Record<string, unknown> };

test("a subscription agent's turn commits and pushes a branch of its repository through the credential helper, without GH_TOKEN, and the run shows what it changed", { timeout: 180_000 }, async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  const server = new GitServer("oauth2", TOKEN);
  const host = await server.listen();
  const bare = server.createRepository("team/app.git");
  const database = await connect(await createIsolatedDatabase(dbName));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-subscription-repositories-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  // The agent's machine, made once the agent has its id, which names its home.
  let stub: ReturnType<typeof stubCliSandbox> | null = null;
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: MachineSpec) => {
    sandboxes.running.add(machine.id);
    return stub?.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const loop = generationLoop(
    db,
    { notes, workspaceRoot: tempDir("guilds-subscription-repositories-ws-"), harnessMcpUrl: "http://127.0.0.1:8090", sandboxes: sandboxes as unknown as GenerationSandboxes, mcp: mcpPool(db), artifacts },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  const app = await buildApp(database, { db, notes, artifacts, scripts: agentScripts(db), schedules: agentSchedules(db), generation: loop });
  const settled = async (runId: string) => {
    for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
      await sleep(25);
    }
    return (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HEADERS })).json();
  };
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name: "shipping" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);
    const secret = await app.inject({ method: "POST", url: "/api/secrets", headers: HEADERS, payload: { name: "GIT_HOST_TOKEN", description: "git", value: TOKEN } });
    assert.equal(secret.statusCode, 201, secret.body);
    const added = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/repositories`,
      headers: HEADERS,
      payload: { name: "app", url: `${host}/team/app.git`, secret_id: String(secret.json().id), username: "oauth2" },
    });
    assert.equal(added.statusCode, 201, added.body);
    const machineId = await codeDefaultMachine(app, HEADERS);
    await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
    const created = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: HEADERS,
      payload: { name: "shipper", config: { model: null, harness: "claude-code", repositories: ["app"] }, machine_id: machineId },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().config.repositories, ["app"], "a subscription agent picks a repository");
    const agentId = String(created.json().id);

    const branch = "agent/shipper/note";
    stub = stubCliSandbox(
      "claude",
      [
        INIT!,
        runLine("git", "checkout", "-q", "-b", branch),
        runLine("sh", "-c", "printf 'note\\n' > NOTE.md && git add NOTE.md && git commit -q -m 'Add a note'"),
        runLine("git", "push", "-q", "origin", branch),
        ...REPLY,
      ],
      // A GH_TOKEN in the machine's environment, which the harness never gets.
      { GIT_SSL_CAINFO: server.caFile, GH_TOKEN: "ghp_machine", HARNESS_STUB_SHOW: "GH_TOKEN,GITHUB_TOKEN", HARNESS_STUB_SEEK: TOKEN },
      agentId,
    );
    answerOps(stub.sandbox, { check: { installed: true, version: "9.9.9 (stub)", credential: "secret" } });

    const started = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message: "Add a note on a branch and push it." } });
    assert.equal(started.statusCode, 202, started.body);
    const runId = String(started.json().id);
    const run = await settled(runId);
    assert.deepEqual(run.errors, []);

    assert.deepEqual(server.branches(bare), [branch, "main"], "the push arrived");
    const answered = server.requests.filter((request) => request.status === 200);
    assert.ok(answered.some((request) => request.path.endsWith("/git-receive-pack")), "the push reached the repository");
    assert.ok(answered.every((request) => request.username === "oauth2"), "with the repository's own username and token");

    const call = stub.calls().at(-1);
    assert.ok(call);
    assert.equal(call.cwd, realpathSync(path.join(stub.sandbox.home, "repos", "app")), "the turn starts in its one repository");
    assert.deepEqual(call.env, { GH_TOKEN: null, GITHUB_TOKEN: null }, "no GH_TOKEN in the harness's environment");
    assert.deepEqual(call.env_holding_seek, [], "the token is in no variable: git reads it through the helper");
    assert.match(String(call.system_prompt), /You work in the git repositories State `repositories` lists/);
    assert.match(String(call.system_prompt), /Push the branch with `git push origin <branch>`/);
    assert.match(String(call.system_prompt), /You have no tool that opens a pull request: your part ends with the\n {2}pushed branch\./, "no pull request tool is bound");
    assert.match(String(call.system_prompt), /"path": "\/home\/[^"]+\/repos\/app"/, "State names where the repository is");

    const rows: MessageView[] = (await app.inject({ method: "GET", url: `/api/runs/${runId}/messages`, headers: HEADERS })).json();
    const pushed = rows.filter((row) => row.payload.content.startsWith("exit="));
    assert.deepEqual(pushed.map((row) => row.payload.content.split("\n")[0]), ["exit=0", "exit=0", "exit=0"]);
    assert.ok(!JSON.stringify(rows).includes(TOKEN), "the run's rows never show the token");

    const callId = `turn_1_${runId}`;
    assert.equal(run.turn_changes?.length, 1);
    assert.equal(run.turn_changes[0].call_id, callId);
    assert.equal(run.turn_changes[0].generation, 1);
    assert.deepEqual(
      run.turn_changes[0].repos.map((repo: Record<string, unknown>) => [repo.name, repo.branch, repo.files_changed, repo.insertions]),
      [["app", branch, 1, 1]],
    );
    const diff = await app.inject({ method: "GET", url: `/api/runs/${runId}/turns/${callId}/changes/app/diff`, headers: HEADERS });
    assert.equal(diff.statusCode, 200, diff.body);
    assert.equal(diff.json().repository, "app");
    assert.match(diff.json().diff, /\+\+\+ b\/NOTE\.md\n@@ -0,0 \+1 @@\n\+note/);
    const unchanged = await app.inject({ method: "GET", url: `/api/runs/${runId}/turns/${callId}/changes/site/diff`, headers: HEADERS });
    assert.equal(unchanged.statusCode, 404, unchanged.body);
    const tokens = JSON.parse(readFileSync(stub.sandbox.local(`/run/guilds/${agentId}/git-tokens.json`), "utf8"));
    assert.deepEqual(tokens, { repositories: {} }, "the helper answers for no repository after the turn");

    // A turn that changes nothing records nothing.
    stub.replay([INIT!, ...REPLY]);
    const next = await app.inject({ method: "POST", url: `/api/runs/${runId}/messages`, headers: HEADERS, payload: { content: "Anything else?" } });
    assert.ok(next.statusCode < 300, next.body);
    const second = await settled(runId);
    assert.deepEqual(second.errors, []);
    assert.equal(second.turn_changes.length, 1);
  } finally {
    await loop.close();
    await app.close();
    await server.close();
    await database.close();
  }
});

/** A connected GitHub login of guild `guildId` on installation 77 that picked `acme/shop` (GitHub id 101). */
async function githubLogin(db: Queryable, guildId: string): Promise<void> {
  const [ciphertext, nonce] = encryptPayload({ installation_id: 77, account: "acme" });
  await db.query(
    `INSERT INTO mcp_connections (id, mcp_server_id, owner_scope, owner_id, status, settings, account_hint, ciphertext, nonce, created_at, updated_at, rotated_at)
     VALUES ('conn_acme', 'mcp_github', 'guild', $1, 'connected', $2, 'acme', $3, $4, now(), now(), now())`,
    [guildId, JSON.stringify({ repositories: [{ name: "shop", url: "https://github.com/acme/shop", default_branch: "main", remote_id: 101 }] }), ciphertext, nonce],
  );
}

/** What a generation on the GitHub repository `shop` asked of GitHub, what it asked the code helper, and the run's system prompt. */
type GithubTurn = { asked: unknown[]; requests: Array<Record<string, unknown>>; system: string };

/**
 * One generation of an agent with `config`, on a subscription or on a key, on its guild's GitHub
 * login, through the run API: the tokens GitHub is asked for, the code helper's requests, and the
 * run's system prompt. The run ends without an error, its tokens file written for the generation
 * and emptied after it.
 */
async function githubTurn(config: Record<string, unknown>): Promise<GithubTurn> {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  harnessTurnTiming.pollMs = 50;
  setInstanceKeys(storeKeys({
    "github-app": {
      app_id: "4242",
      slug: "guilds-run-test",
      private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_id: "Iv1.client",
      client_secret: "client-secret",
    },
  }));
  const asked: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname !== "/app/installations/77/access_tokens") {
      return realFetch(url, init);
    }
    asked.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ token: "ghs_turn", expires_at: "2099-01-01T00:00:00Z", repositories: [{ id: 101, full_name: "acme/shop" }] }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const previousStream = generationLive.streamCompletion;
  generationLive.streamCompletion = async function* stream() {
    yield ["done", completionReply("I read the shop.")];
  };
  const name = uniqueDbName("agent_platform_subscription_github");
  githubDbNames.push(name);
  const database = await connect(await createIsolatedDatabase(name));
  const db = database.pool;
  const notes = new NotesStore(tempDir("guilds-subscription-github-notes-"), templatesRoot());
  await notes.ensureSystemPrompt();
  const artifacts = artifactStore(db, notes.templates);
  let stub: ReturnType<typeof stubCliSandbox> | null = null;
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: MachineSpec) => {
    sandboxes.running.add(machine.id);
    return stub?.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const loop = generationLoop(
    db,
    { notes, workspaceRoot: tempDir("guilds-subscription-github-ws-"), harnessMcpUrl: "http://127.0.0.1:8090", sandboxes: sandboxes as unknown as GenerationSandboxes, mcp: mcpPool(db), artifacts },
    { ...LOOP_TIMINGS, idleTimeoutMs: 0 },
  );
  const app = await buildApp(database, { db, notes, artifacts, scripts: agentScripts(db), schedules: agentSchedules(db), generation: loop });
  try {
    const guild = await app.inject({ method: "POST", url: "/api/guilds", headers: HEADERS, payload: { name: "github" } });
    assert.equal(guild.statusCode, 201, guild.body);
    const guildId = String(guild.json().id);
    await githubLogin(db, guildId);
    await connectModelProvider(db, "org_home", "deepinfra");
    const machineId = await codeDefaultMachine(app, HEADERS);
    await db.query("UPDATE machines SET harnesses = $2 WHERE id = $1", [machineId, ["claude-code"]]);
    const created = await app.inject({
      method: "POST",
      url: `/api/guilds/${guildId}/agents`,
      headers: HEADERS,
      payload: { name: "reviewer", config, machine_id: machineId },
    });
    assert.equal(created.statusCode, 201, created.body);
    const agentId = String(created.json().id);
    stub = stubCliSandbox("claude", [INIT!, ...REPLY], {}, agentId);
    // github.com is not reached here: the clone and the checkpoints are answered, and the working tree made.
    const requests = answerOps(stub.sandbox, {
      check: { installed: true, version: "9.9.9 (stub)", credential: "secret" },
      git_setup: { failed: [] },
      checkpoint: { repositories: [] },
    });
    mkdirSync(path.join(stub.sandbox.home, "repos", "shop"), { recursive: true });

    const started = await app.inject({ method: "POST", url: `/api/agents/${agentId}/runs`, headers: HEADERS, payload: { message: "Look at the shop." } });
    assert.equal(started.statusCode, 202, started.body);
    const runId = String(started.json().id);
    for (let attempt = 0; attempt < 400 && loop.isGenerating(runId); attempt += 1) {
      await sleep(25);
    }
    const run = (await app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: HEADERS })).json();
    assert.deepEqual(run.errors, []);
    const tokens = stub.sandbox.written.filter((written) => written.endsWith("git-tokens.json"));
    assert.equal(tokens.length, 2, "written for the turn, then emptied");
    const rows: MessageView[] = (await app.inject({ method: "GET", url: `/api/runs/${runId}/messages`, headers: HEADERS })).json();
    const system = rows.find((row) => row.payload.role === "system")?.payload.content ?? "";
    return { asked, requests, system };
  } finally {
    globalThis.fetch = realFetch;
    generationLive.streamCompletion = previousStream;
    setInstanceKeys({});
    await loop.close();
    await app.close();
    await database.close();
  }
}

/** The repositories the code helper's `git_setup` was asked to place. */
function setupRepositories(requests: GithubTurn["requests"]): unknown {
  return requests.find((request) => request.op === "git_setup")?.repositories;
}

test("a subscription agent's turn on a GitHub repository asks GitHub for a token that writes contents alone", { timeout: 120_000 }, async () => {
  const turn = await githubTurn({ model: null, harness: "claude-code", repositories: ["shop"] });
  assert.deepEqual(turn.asked, [{ repository_ids: [101], permissions: { contents: "write" } }], "no pull request, issue, workflow or administration permission");
  assert.deepEqual(setupRepositories(turn.requests), [{ name: "shop", url: "https://github.com/acme/shop", read_only: false }]);
  assert.match(turn.system, /Push the branch with `git push origin <branch>`/);
});

test("a subscription agent's turn on a GitHub repository it only reads asks GitHub for a token that reads contents alone, and is told git refuses to push it", { timeout: 120_000 }, async () => {
  const turn = await githubTurn({ model: null, harness: "claude-code", repositories: ["shop"], read_only_repositories: ["shop"] });
  assert.deepEqual(turn.asked, [{ repository_ids: [101], permissions: { contents: "read" } }]);
  assert.deepEqual(setupRepositories(turn.requests), [{ name: "shop", url: "https://github.com/acme/shop", read_only: true }]);
  assert.match(turn.system, /"read_only": true/);
  assert.match(turn.system, /is one you only read: git\n {2}refuses to push it/);
  assert.doesNotMatch(turn.system, /git push origin/);
});

test("an agent on a key gets the GitHub repositories it picks on its machine, with a token that writes contents alone, and is told a script works in them", { timeout: 120_000 }, async () => {
  const turn = await githubTurn({ model: TEST_MODEL, repositories: ["shop"] });
  assert.deepEqual(turn.asked, [{ repository_ids: [101], permissions: { contents: "write" } }]);
  assert.deepEqual(setupRepositories(turn.requests), [{ name: "shop", url: "https://github.com/acme/shop", read_only: false }]);
  assert.equal(turn.requests.some((request) => request.op === "checkpoint"), false, "an agent on a key keeps no turn checkpoints");
  assert.match(turn.system, /"path": "\/home\/[^"]+\/repos\/shop"/, "State names where the repository is");
  assert.match(turn.system, /You have no shell: a script runs git in them/);
  assert.match(turn.system, /Push the branch with `git push origin <branch>`/);
  assert.doesNotMatch(turn.system, /Your turn\nstarts in the working tree/);
});

test("an agent on a key that only reads its GitHub repository gets a token that reads contents alone, and is told git refuses to push it", { timeout: 120_000 }, async () => {
  const turn = await githubTurn({ model: TEST_MODEL, repositories: ["shop"], read_only_repositories: ["shop"] });
  assert.deepEqual(turn.asked, [{ repository_ids: [101], permissions: { contents: "read" } }]);
  assert.deepEqual(setupRepositories(turn.requests), [{ name: "shop", url: "https://github.com/acme/shop", read_only: true }]);
  assert.match(turn.system, /"read_only": true/);
  assert.match(turn.system, /is one you only read: git\n {2}refuses to push it/);
  assert.doesNotMatch(turn.system, /git push origin/);
});
