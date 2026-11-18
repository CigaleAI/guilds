import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { harnessTurnTiming } from "../../src/generation/harness-loop.js";
import { configSnapshot } from "../../src/generation/snapshot.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import type { ResolvedAgentConfig } from "../../src/db/schema/index.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import type { MachineSpec } from "../../src/sandbox/index.js";
import { answerOps } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, storeKeys, tempDir } from "../helpers/env.js";
import { AGENT_CONFIG, FakeDB, FakeSandboxes, makeLoop } from "../helpers/generation.js";
import type { FastifyInstance } from "fastify";
import { freePort, recordedEvents, runLine, serveHarnessMcp, stubCliSandbox } from "../helpers/harness-cli.js";
import { connectionRow } from "../helpers/servers.js";

// A subscription agent's turn in the repositories it picks, driven through the generation loop
// against the stand-in CLI and `guilds-code` on this host.

const timing = { ...harnessTurnTiming };
const SUBSCRIBER: ResolvedAgentConfig = { ...AGENT_CONFIG, model: null, harness: "claude-code" };
const HARNESS_READY = { installed: true, version: "9.9.9 (stub)", credential: "secret" };
const [INIT] = recordedEvents("claude-code");
const REPLY = recordedEvents("claude-code").slice(-2);
const listeners: FastifyInstance[] = [];

before(() => {
  harnessTurnTiming.pollMs = 50;
});
after(async () => {
  Object.assign(harnessTurnTiming, timing);
  await Promise.all(listeners.map((listener) => listener.close()));
});

/** A bare repository on this host whose `main` holds one commit of a README; its file URL. */
function bareRepository(): string {
  const root = tempDir("harness-repo-");
  const bare = path.join(root, "app.git");
  const seed = path.join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch", "main", bare]);
  execFileSync("git", ["init", "--quiet", "--initial-branch", "main", seed]);
  writeFileSync(path.join(seed, "README.md"), "# app\n");
  execFileSync("git", ["-C", seed, "add", "README.md"]);
  execFileSync("git", ["-C", seed, "-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "--quiet", "-m", "Start"]);
  execFileSync("git", ["-C", seed, "push", "--quiet", bare, "main"]);
  return `file://${bare}`;
}

/** A guild repository row named `name` at `url`, cloned without credentials unless `overrides` says. */
function guildRepository(name: string, url: string, overrides: Record<string, unknown> = {}) {
  return { id: `repo_${name}`, guild_id: "guild_1", name, url, default_branch: "main", provider: null, connection_id: null, secret_id: null, username: null, ...overrides };
}

/**
 * A generation loop whose run `r_1` is a direct run of a Claude Code subscription agent that picks
 * `repositories`, of which its guild has `rows`, with the stand-in CLI replaying `lines`, and whose
 * MCP server listens on this host.
 */
async function repositoryLoop(lines: string[], repositories: string[], rows: Array<Record<string, unknown>>) {
  const stub = stubCliSandbox("claude", lines);
  const answered = answerOps(stub.sandbox, { check: HARNESS_READY });
  const db = new FakeDB(configSnapshot(SUBSCRIBER, { tools: [], secrets: [], mcp: [] }, "direct"));
  db.agent.config = { ...SUBSCRIBER, repositories };
  Object.assign(db, { listGuildRepositories: async () => rows });
  const sandboxes = new FakeSandboxes();
  sandboxes.ensure = (async (machine: MachineSpec) => {
    sandboxes.running.add(machine.id);
    return stub.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const port = await freePort();
  const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes, { harnessMcpUrl: `http://127.0.0.1:${port}` });
  listeners.push(await serveHarnessMcp(loop, port));
  const errors = () => db.run.errors as Array<{ operation: string; message: string }>;
  const metadata = () => db.run.metadata as Record<string, unknown>;
  return { ...stub, db, loop, errors, metadata, answered };
}

/** Adds the operator's next message to run `r_1` of `db`. */
function nextMessage(db: FakeDB, content: string): void {
  const seq = Math.max(...db.messages.map((row) => Number(row.seq))) + 1;
  db.messages.push({ id: seq + 1, seq, payload: { role: "user", content }, metadata: { source: "ui" }, created_at: new Date() });
}

test("a turn of an agent with one repository clones it and starts in its working tree; one with several starts in the home", async () => {
  const url = bareRepository();
  const one = await repositoryLoop([INIT!, ...REPLY], ["app"], [guildRepository("app", url)]);
  await one.loop.generator.generate("r_1", 1);
  assert.deepEqual(one.errors(), []);
  assert.equal(one.calls()[0]?.cwd, realpathSync(path.join(one.sandbox.home, "repos", "app")));
  assert.equal(readFileSync(path.join(one.sandbox.home, "repos", "app", "README.md"), "utf8"), "# app\n");

  const several = await repositoryLoop([INIT!, ...REPLY], ["app", "site"], [guildRepository("app", url), guildRepository("site", url)]);
  await several.loop.generator.generate("r_1", 1);
  assert.deepEqual(several.errors(), []);
  assert.equal(several.calls()[0]?.cwd, realpathSync(several.sandbox.home));
});

test("a turn that changes a repository records the turn's checkpoints and diffstat; a turn that changes nothing records nothing", async () => {
  const url = bareRepository();
  const run = await repositoryLoop([], ["app"], [guildRepository("app", url)]);
  const note = path.join(run.sandbox.home, "repos", "app", "NOTE.md");
  run.replay([INIT!, JSON.stringify({ stub: "edit", path: note, text: "note\n" }), ...REPLY]);
  await run.loop.generator.generate("r_1", 1);
  assert.deepEqual(run.errors(), []);
  const [turn, ...others] = (run.metadata().turn_changes ?? []) as Array<{ call_id: string; generation: number; repos: Array<Record<string, unknown>> }>;
  assert.deepEqual(others, []);
  assert.equal(turn?.call_id, "turn_1_r_1");
  assert.equal(turn?.generation, 1);
  assert.deepEqual(turn?.repos.map((repo) => [repo.name, repo.branch, repo.files_changed, repo.insertions]), [["app", "main", 1, 1]]);
  assert.equal("files" in (turn?.repos[0] ?? {}), false, "the run keeps the diffstat, not the file list");
  const refs = execFileSync("git", ["-C", path.join(run.sandbox.home, "repos", "app"), "for-each-ref", "--format=%(refname)", "refs/guild"], { encoding: "utf8" });
  assert.deepEqual(refs.split("\n").filter(Boolean).sort(), ["refs/guild/runs/r_1/tasks/turn_1_r_1/end", "refs/guild/runs/r_1/tasks/turn_1_r_1/start"]);
  const tokens = JSON.parse(readFileSync(run.sandbox.local(`/run/guilds/a_1/git-tokens.json`), "utf8"));
  assert.deepEqual(tokens, { repositories: {} }, "the credential helper answers for no repository once the turn ends");

  run.replay([INIT!, ...REPLY]);
  nextMessage(run.db, "anything else?");
  await run.loop.generator.generate("r_1", 2);
  assert.deepEqual(run.errors(), []);
  assert.equal((run.metadata().turn_changes as unknown[]).length, 1, "the second turn changed nothing");
});

test("a turn that rewrites a repository's history to the same files, or switches its branch, is recorded as a change with its heads at start and end", async () => {
  const url = bareRepository();
  const run = await repositoryLoop([], ["app"], [guildRepository("app", url)]);
  const repo = path.join(run.sandbox.home, "repos", "app");
  const head = () => execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const identity = ["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid"];
  run.replay([INIT!, runLine("git", ...identity, "commit", "--amend", "--quiet", "-m", "Start, reworded"), ...REPLY]);
  await run.loop.generator.generate("r_1", 1);
  assert.deepEqual(run.errors(), []);
  const rewritten = (run.metadata().turn_changes as Array<{ repos: Array<Record<string, unknown>> }>)[0]?.repos[0];
  assert.deepEqual(
    [rewritten?.files_changed, rewritten?.start_branch, rewritten?.branch, rewritten?.head_sha],
    [0, "main", "main", head()],
    "an amend to the same files changes no file",
  );
  assert.equal(typeof rewritten?.start_head_sha, "string");
  assert.notEqual(rewritten?.start_head_sha, rewritten?.head_sha, "the head the turn started on is not the one it ended on");

  run.replay([INIT!, runLine("git", "checkout", "--quiet", "-b", "topic"), ...REPLY]);
  nextMessage(run.db, "work on a branch");
  await run.loop.generator.generate("r_1", 2);
  const switched = (run.metadata().turn_changes as Array<{ generation: number; repos: Array<Record<string, unknown>> }>).at(-1);
  assert.equal(switched?.generation, 2);
  assert.deepEqual(
    [switched?.repos[0]?.files_changed, switched?.repos[0]?.start_branch, switched?.repos[0]?.branch, switched?.repos[0]?.start_head_sha === switched?.repos[0]?.head_sha],
    [0, "main", "topic", true],
  );
});

test("an agent that picks a repository it can no longer use fails its turn at start, and the CLI never runs", async () => {
  const run = await repositoryLoop([INIT!, ...REPLY], ["gone"], []);
  await run.loop.generator.generate("r_1", 1);
  assert.equal(run.errors().at(-1)?.operation, "coding.repositories_gone");
  assert.equal(run.calls().length, 0);
});

test("an agent that picks no repository runs its turn in its home without cloning anything", async () => {
  const run = await repositoryLoop([INIT!, ...REPLY], [], []);
  await run.loop.generator.generate("r_1", 1);
  assert.deepEqual(run.errors(), []);
  assert.equal(run.calls()[0]?.cwd, realpathSync(run.sandbox.home));
  assert.equal(run.metadata().turn_changes, undefined);
});

test("a GitHub repository's token is minted to push alone, and replaced before a poll once it nears its expiry", async () => {
  process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
  setInstanceKeys(storeKeys({
    "github-app": {
      app_id: "4242",
      slug: "guilds-run-test",
      private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_id: "Iv1.client",
      client_secret: "client-secret",
    },
  }));
  const asked: Array<{ repository_ids: number[]; permissions: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)) as { repository_ids: number[]; permissions: unknown });
    // A token five minutes from its expiry, inside the window in which it is replaced.
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    return new Response(JSON.stringify({ token: `ghs_turn_${asked.length}`, expires_at: expires, repositories: [{ id: 101, full_name: "acme/shop" }] }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const run = await repositoryLoop(
    [INIT!, JSON.stringify({ stub: "hang" })],
    ["shop"],
    [guildRepository("shop", "https://github.com/acme/shop", { provider: "github", connection_id: "conn_gh", remote_id: 101 })],
  );
  const [ciphertext, nonce] = encryptPayload({ installation_id: 77, account: "acme" });
  run.db.mcp_connection = connectionRow({ id: "conn_gh", mcp_server_id: "mcp_github", account_hint: "acme", ciphertext, nonce });
  answerOps(run.sandbox, { check: HARNESS_READY, git_setup: { failed: [] }, checkpoint: { repositories: [] } });
  // The clone is answered, so its working tree is made here for the CLI to start in.
  mkdirSync(path.join(run.sandbox.home, "repos", "shop"), { recursive: true });
  // The turn hangs until its 30 minutes, each 20 ms here, are up.
  harnessTurnTiming.minuteMs = 20;
  try {
    await run.loop.generator.generate("r_1", 1);
  } finally {
    globalThis.fetch = realFetch;
    setInstanceKeys({});
    harnessTurnTiming.minuteMs = timing.minuteMs;
  }
  assert.ok(asked.length >= 3, `minted at start and again before each poll: ${asked.length}`);
  for (const request of asked) {
    assert.deepEqual(request, { repository_ids: [101], permissions: { contents: "write" } });
  }
});
