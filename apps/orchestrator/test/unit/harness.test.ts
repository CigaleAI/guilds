import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { createToolHooks } from "../../src/toolbox/index.js";
import { HARNESS_HELPER, runCodeHelper } from "../../src/toolbox/code.js";
import { launchHarness, opsRun, pollHarness, readResult, shownProgressLines } from "../../src/toolbox/harness-ops.js";
import { failureDetail } from "../../src/toolbox/harness-result.js";
import { assertHarnessReady, checkHarnessOn, HarnessSetupError } from "../../src/toolbox/harness-setup.js";
import { applySecretAliases } from "../../src/access/runtime.js";
import { HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";
import { HANG, type StubCall } from "../helpers/harness-cli.js";
import { fakeToolboxDatabase, toolFixture, type ToolFixture, type ToolFixtureFields } from "../helpers/toolbox.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "../helpers/harness/stub-cli");
const RECORDED = path.join(HERE, "../helpers/harness");
const SESSION = "0f9c2a64-5b1e-4c3d-9a8e-2f1d7c6b5a40";
const TOKEN = "oauth-subscription-token";

type Recorded = Pick<StubCall, "argv" | "cwd" | "stdin" | "system_prompt" | "env" | "mcp_config" | "mcp_config_mode" | "env_holding_seek">;

function git(repo: string, home: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });
}

/** The recorded event stream of a harness, with stub lines that write a file after the event at `at`. */
function recorded(harness: string, edits: Array<{ at: number; path: string; text: string }> = []): string[] {
  const lines = readFileSync(path.join(RECORDED, `${harness}.jsonl`), "utf8").split("\n").filter(Boolean);
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    lines.splice(edit.at + 1, 0, JSON.stringify({ stub: "edit", path: edit.path, text: edit.text }));
  }
  return lines;
}

/** A sandbox with `binary` on PATH replaying `events`, and a repository `app` in the agent's home. */
function harnessSandbox(binary: string, events: (repo: string) => string[], env: Record<string, string> = {}) {
  const bin = tempDir("harness-bin-");
  copyFileSync(STUB, path.join(bin, binary));
  chmodSync(path.join(bin, binary), 0o755);
  const scratch = tempDir("harness-stub-");
  const record = path.join(scratch, "record.jsonl");
  const eventsFile = path.join(scratch, "events.jsonl");
  const sandbox = new HostCodeSandbox("a_1", {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HARNESS_STUB_EVENTS: eventsFile,
    HARNESS_STUB_RECORD: record,
    HARNESS_STUB_SHOW:
      "IS_SANDBOX,ANTHROPIC_API_KEY,CLAUDE_CODE_USE_BEDROCK,CLAUDE_CODE_USE_VERTEX,GH_TOKEN,GUILD_RUN_ID,CLAUDE_CODE_OAUTH_TOKEN,CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    HARNESS_STUB_DELAY: "0.02",
    ANTHROPIC_API_KEY: "metered-api-key",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    GH_TOKEN: "installation-token",
    ...env,
  });
  const repo = path.join(sandbox.home, "repos", "app");
  mkdirSync(repo, { recursive: true });
  git(repo, sandbox.home, ["init", "--quiet", "--initial-branch", "main"]);
  git(repo, sandbox.home, ["config", "user.name", "Test"]);
  git(repo, sandbox.home, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(path.join(repo, "greet.py"), "print('hello')\n");
  git(repo, sandbox.home, ["add", "."]);
  git(repo, sandbox.home, ["commit", "--quiet", "-m", "start"]);
  writeFileSync(eventsFile, events(repo).join("\n") + "\n");
  const calls = (): Recorded[] =>
    existsSync(record)
      ? readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Recorded)
      : [];
  return { sandbox, repo, calls, eventsFile };
}

function context(sandbox: HostCodeSandbox, overrides: Partial<ToolFixtureFields> = {}) {
  const ctx = toolFixture({
    run_id: "r_harness",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox,
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    harness: "claude-code",
    code_repositories: ["app"],
    db: fakeToolboxDatabase({}),
    ...overrides,
  });
  return { ctx };
}

/**
 * One turn of `ctx`'s run on its harness, as a subscription agent's turn starts it: the harness
 * checked, then its CLI started in the repository `app` on `prompt`, resuming `session`, and
 * polled until it exits. The `result` op's meta.
 */
async function turn(ctx: ToolFixture, prompt: string, options: { session?: string; callId?: string } = {}) {
  await assertHarnessReady(ctx.services, ctx.run);
  const harness = ctx.run.harness ?? "claude-code";
  const ops = opsRun(ctx.run);
  const callId = options.callId ?? "call_task";
  await launchHarness(ops, callId, {
    harness,
    prompt,
    repository: "app",
    system_prompt: null,
    mcp: null,
    session_id: options.session ?? null,
    model: ctx.run.harness_model,
    effort: ctx.run.harness_effort,
    max_turns: null,
  });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { poll } = await pollHarness(ops, callId, harness, 0);
    if (poll.exited === true || poll.missing === true) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const result = await readResult(ops, callId, harness);
  assert.ok(result, "the turn's result is read");
  return result;
}

describe("a turn with the Claude Code driver", () => {
  test("a turn runs headless in the repository on the subscription, its prompt on stdin", async () => {
    const { sandbox, repo, calls } = harnessSandbox("claude", (root) =>
      recorded("claude-code", [{ at: 3, path: path.join(root, "greet.py"), text: "print('hello, guild')\n" }]),
      { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    );
    const { ctx } = context(sandbox);
    const result = await turn(ctx, "Make the greeting name the guild.");
    assert.equal(result.exit_code, 0);
    assert.equal(result.session_id, SESSION);
    assert.ok(result.message?.includes("Should the greeting also name the agent?"));

    const [call] = calls();
    assert.ok(call);
    assert.deepEqual(call.argv.slice(1, 12), [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--settings",
      '{"disableAllHooks": true, "enableAllProjectMcpServers": false, "autoMemoryEnabled": false, "enabledPlugins": {}}',
    ]);
    assert.ok(!call.argv.includes("--resume"));
    assert.equal(realpathSync(call.cwd), realpathSync(repo));
    assert.equal(call.stdin, "Make the greeting name the guild.", "the prompt reaches the CLI on stdin");
    assert.ok(!call.argv.some((arg) => arg.includes("Make the greeting")), "never on its command line");
    assert.equal(call.env.IS_SANDBOX, "1");
    assert.equal(call.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(call.env.ANTHROPIC_API_KEY, null, "a metered key never reaches the harness");
    assert.equal(call.env.CLAUDE_CODE_USE_BEDROCK, null, "nor a switch to metered Bedrock");
    assert.equal(call.env.CLAUDE_CODE_USE_VERTEX, null, "nor a switch to metered Vertex");
    assert.equal(call.env.GH_TOKEN, null);
    assert.equal(call.env.GUILD_RUN_ID, "r_harness");
    assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.ok(existsSync(path.join(sandbox.home, ".runs/r_harness/call_task.harness.jsonl")), "the raw log stays");
    assert.ok(!existsSync(path.join(sandbox.home, ".runs/r_harness/call_task.prompt.md")), "the prompt file goes");
  });

  test("a turn's git takes the platform's hooks path after the git configuration its environment holds", async () => {
    const show = { HARNESS_STUB_SHOW: "GIT_CONFIG_COUNT,GIT_CONFIG_KEY_0,GIT_CONFIG_VALUE_0,GIT_CONFIG_KEY_3,GIT_CONFIG_VALUE_3" };
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ...show });
    await turn(context(sandbox).ctx, "x");
    const [call] = calls();
    assert.equal(call!.env.GIT_CONFIG_COUNT, "4");
    assert.equal(call!.env.GIT_CONFIG_KEY_0, "credential.https://.helper", "the image's entries stay first");
    assert.equal(call!.env.GIT_CONFIG_KEY_3, "core.hooksPath");
    assert.equal(call!.env.GIT_CONFIG_VALUE_3, "/usr/local/share/guilds/git-hooks");

    const bare = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ...show, GIT_CONFIG_COUNT: "" });
    await turn(context(bare.sandbox).ctx, "x");
    const [first] = bare.calls();
    assert.equal(first!.env.GIT_CONFIG_COUNT, "1", "an empty count is git's none");
    assert.equal(first!.env.GIT_CONFIG_KEY_0, "core.hooksPath");
    assert.equal(first!.env.GIT_CONFIG_VALUE_0, "/usr/local/share/guilds/git-hooks");
  });

  test("a session resumes with the prompt as its next turn", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    const { ctx } = context(sandbox);
    const result = await turn(ctx, "Yes, name the agent too.", { session: SESSION });
    assert.equal(result.exit_code, 0);
    const [call] = calls();
    assert.deepEqual(call!.argv.slice(-2), ["--resume", SESSION]);
    assert.ok(call!.stdin.includes("Yes, name the agent too."));
  });

  test("the agent's harness model is passed with --model; without one the subscription picks", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    await turn(context(sandbox, { harness_model: "opus" }).ctx, "x", { session: SESSION });
    await turn(context(sandbox).ctx, "x", { callId: "call_default" });
    const [pinned, plain] = calls();
    assert.deepEqual(pinned!.argv.slice(-4), ["--model", "opus", "--resume", SESSION]);
    assert.ok(!plain!.argv.includes("--model"));
  });

  test("the agent's harness effort is passed with --effort, after the model", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    await turn(context(sandbox, { harness_model: "opus", harness_effort: "xhigh" }).ctx, "x", { session: SESSION });
    await turn(context(sandbox, { harness_effort: "low" }).ctx, "x", { callId: "call_default" });
    const [pinned, plain] = calls();
    assert.deepEqual(pinned!.argv.slice(-6), ["--model", "opus", "--effort", "xhigh", "--resume", SESSION]);
    assert.deepEqual(plain!.argv.slice(-2), ["--effort", "low"]);
  });

  test("the helper refuses an effort it does not know, and never starts the harness", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    await assert.rejects(turn(context(sandbox, { harness_effort: "--x" as never }).ctx, "x"), /effort is invalid/);
    assert.equal(calls().length, 0);
  });

  test("the helper refuses a model that is not a model name, and never starts the harness", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    await assert.rejects(turn(context(sandbox, { harness_model: "--settings={}" }).ctx, "x"), /model is invalid/);
    assert.equal(calls().length, 0);
  });

  test("without a credential the turn's check fails, naming the secret to grant and the login to run", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"));
    const { ctx } = context(sandbox, { secrets: {} });
    await assert.rejects(turn(ctx, "Anything."), (error: unknown) => {
      assert.ok(error instanceof HarnessSetupError);
      assert.match(error.message, /^Claude Code has no credential: grant the secret CLAUDE_CODE_OAUTH_TOKEN/);
      assert.match(error.message, /claude, then \/login/);
      return true;
    });
    assert.equal(calls().length, 0, "the harness never starts");
  });

  test("an aliased secret is the credential, and a missing one is named with the variable it is read as", async () => {
    const aliases = { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" };
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), {
      ...applySecretAliases({ BOB_TOKEN: "bob-token" }, aliases),
      HARNESS_STUB_SHOW: "CLAUDE_CODE_OAUTH_TOKEN,BOB_TOKEN",
    });
    assert.equal((await turn(context(sandbox, { secret_aliases: aliases }).ctx, "x")).exit_code, 0);
    assert.deepEqual(calls()[0]!.env, { CLAUDE_CODE_OAUTH_TOKEN: "bob-token", BOB_TOKEN: "bob-token" });
    const bare = harnessSandbox("claude", () => recorded("claude-code")).sandbox;
    await assert.rejects(
      turn(context(bare, { secrets: {}, secret_aliases: aliases }).ctx, "x"),
      /grant the secret BOB_TOKEN \(read as CLAUDE_CODE_OAUTH_TOKEN\) to the agent/,
    );
  });

  test("a check that finds no credential forgets the login; one that finds a login records it", async () => {
    const { sandbox } = harnessSandbox("claude", () => recorded("claude-code"));
    const events: string[] = [];
    const overrides = {
      secrets: {},
      db: fakeToolboxDatabase({
        markHarnessLogin: async (_agentId, login) =>
          void events.push(`seen ${login.harness} as ${login.account ?? "unknown"}`),
        clearHarnessLogin: async (_agentId, harness) => void events.push(`lost ${harness}`),
      }),
    };
    const { ctx } = context(sandbox, overrides);
    await assert.rejects(() => assertHarnessReady(ctx.services, ctx.run), (error: unknown) => {
      assert.ok(error instanceof HarnessSetupError);
      assert.equal(error.code, "harness.credential");
      return true;
    });
    mkdirSync(path.join(sandbox.home, ".claude"), { recursive: true });
    writeFileSync(path.join(sandbox.home, ".claude", ".credentials.json"), "{}");
    await assertHarnessReady(ctx.services, ctx.run);
    writeFileSync(path.join(sandbox.home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "ada@example.com" } }));
    await assertHarnessReady(ctx.services, ctx.run);
    assert.deepEqual(events, ["lost claude-code", "seen claude-code as unknown", "seen claude-code as ada@example.com"]);
  });

  test("with no harness picked, the readiness check names the agent's Settings", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"));
    const unpicked = context(sandbox, { harness: null }).ctx;
    await assert.rejects(() => assertHarnessReady(unpicked.services, unpicked.run), (error: unknown) => {
      assert.ok(error instanceof HarnessSetupError);
      assert.equal(error.code, "harness.missing");
      assert.match(error.message, /no harness is picked: choose Claude Code, Codex, Cursor, or Antigravity in the agent's Settings/);
      return true;
    });
    assert.equal(calls().length, 0);
  });

  test("checkHarnessOn reports the CLI, its version, and what it would run on", async () => {
    const { sandbox } = harnessSandbox("claude", () => [], { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    assert.deepEqual(await checkHarnessOn(context(sandbox).ctx.run, "claude-code"), {
      installed: true,
      version: "9.9.9 (stub)",
      credential: "secret",
      account: null,
    });
    const bare = new HostCodeSandbox("a_1", { PATH: tempDir("harness-empty-bin-") + ":/usr/bin:/bin" });
    assert.deepEqual(await checkHarnessOn(context(bare).ctx.run, "claude-code"), {
      installed: false,
      version: null,
      credential: null,
      account: null,
    });
  });

  test("a CLI missing from the image fails with that reason", async () => {
    const sandbox = new HostCodeSandbox("a_1", { PATH: tempDir("harness-empty-bin-") + ":/usr/bin:/bin" });
    mkdirSync(path.join(sandbox.home, "repos", "app"), { recursive: true });
    const { ctx } = context(sandbox);
    await assert.rejects(assertHarnessReady(ctx.services, ctx.run), /^HarnessSetupError: Claude Code is not installed in this machine's image|Claude Code is not installed in this machine's image/);
  });

  test("output the driver does not parse fails with that reason", async () => {
    const { sandbox } = harnessSandbox("claude", () => ["Welcome to the new output format", "done"], {
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    const result = await turn(context(sandbox).ctx, "Anything.");
    assert.equal(result.session_id, undefined);
    assert.equal(
      failureDetail("claude-code", result, "9.9.9 (stub)"),
      "error: the claude-code driver does not parse this CLI's output (9.9.9 (stub))",
    );
  });

});

describe("a turn with the Codex driver", () => {
  const THREAD = "01a13707-f086-7261-8d15-5306e7a49a3c";

  /** A ChatGPT login in the agent's home, as `codex login` writes it. */
  function chatgptLogin(sandbox: HostCodeSandbox, auth: Record<string, unknown>) {
    mkdirSync(path.join(sandbox.home, ".codex"), { recursive: true });
    writeFileSync(path.join(sandbox.home, ".codex", "auth.json"), JSON.stringify(auth));
  }

  test("a turn runs on the ChatGPT login, with hooks, plugins, and MCP off, and no API key", async () => {
    const { sandbox, repo, calls } = harnessSandbox(
      "codex",
      (root) => recorded("codex", [{ at: 4, path: path.join(root, "greet.py"), text: "print('hello, guild')\n" }]),
      { OPENAI_API_KEY: "metered-openai-key", CODEX_API_KEY: "metered-codex-key", HARNESS_STUB_SHOW: "OPENAI_API_KEY,CODEX_API_KEY,GH_TOKEN" },
    );
    chatgptLogin(sandbox, { OPENAI_API_KEY: null, tokens: { id_token: "id", access_token: "access", refresh_token: "refresh" } });
    const seen: string[] = [];
    const { ctx } = context(sandbox, {
      harness: "codex",
      secrets: {},
      db: fakeToolboxDatabase({
        markHarnessLogin: async (_agentId, login) => {
          seen.push(login.harness);
        },
      }),
    });
    const result = await turn(ctx, "Make the greeting name the guild.");
    assert.equal(result.exit_code, 0);
    assert.equal(result.session_id, THREAD);
    assert.ok(result.message?.includes("Should the greeting also name the agent?"));
    assert.deepEqual(seen, ["codex"]);
    const [call] = calls();
    assert.deepEqual(call!.argv.slice(1), [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "memories",
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "--disable",
      "apps",
      "--disable",
      "in_app_updates",
      "-c",
      "mcp_servers={}",
      "-c",
      "notify=[]",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "analytics.enabled=false",
      "-c",
      'otel.exporter="none"',
      "-",
    ]);
    assert.equal(realpathSync(call!.cwd), realpathSync(repo));
    assert.ok(call!.stdin.includes("Make the greeting name the guild."));
    assert.deepEqual(call!.env, { OPENAI_API_KEY: null, CODEX_API_KEY: null, GH_TOKEN: null });
  });

  test("a session resumes with exec resume and the prompt on stdin", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    await turn(context(sandbox, { harness: "codex", secrets: {} }).ctx, "Yes.", { session: THREAD });
    const argv = calls()[0]!.argv;
    assert.deepEqual(argv.slice(1, 3), ["exec", "resume"]);
    assert.deepEqual(argv.slice(-2), [THREAD, "-"]);
  });

  test("the agent's harness model is passed with --model, on a resume too", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    const ctx = context(sandbox, { harness: "codex", secrets: {}, harness_model: "gpt-5-codex" }).ctx;
    await turn(ctx, "Yes.", { session: THREAD });
    assert.deepEqual(calls()[0]!.argv.slice(-4), ["--model", "gpt-5-codex", THREAD, "-"]);
  });

  test("the agent's harness effort is passed as model_reasoning_effort, before the thread id", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    const ctx = context(sandbox, { harness: "codex", secrets: {}, harness_model: "gpt-6-luna", harness_effort: "high" }).ctx;
    await turn(ctx, "Yes.", { session: THREAD });
    assert.deepEqual(calls()[0]!.argv.slice(-6), ["--model", "gpt-6-luna", "-c", 'model_reasoning_effort="high"', THREAD, "-"]);
  });

  test("a check reads whose the ChatGPT login is from its id token, without checking its signature", async () => {
    const { sandbox } = harnessSandbox("codex", () => recorded("codex"));
    const claims = Buffer.from(JSON.stringify({ email: "bob@example.com" }), "utf8").toString("base64url");
    chatgptLogin(sandbox, { tokens: { id_token: `eyJhbGciOiJub25lIn0.${claims}.sig`, refresh_token: "refresh" } });
    const check = await checkHarnessOn(context(sandbox, { harness: "codex", secrets: {} }).ctx.run, "codex");
    assert.deepEqual(check, { installed: true, version: "9.9.9 (stub)", credential: "login", account: "bob@example.com" });
    chatgptLogin(sandbox, { tokens: { id_token: "not-a-jwt", refresh_token: "refresh" } });
    assert.equal((await checkHarnessOn(context(sandbox, { harness: "codex", secrets: {} }).ctx.run, "codex")).account, null);
  });

  test("an API key login is not a subscription: the turn's check names the login to run", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { OPENAI_API_KEY: "sk-metered", tokens: null });
    await assert.rejects(
      turn(context(sandbox, { harness: "codex", secrets: {} }).ctx, "x"),
      /^HarnessSetupError: Codex has no credential: log in from the agent's CLI tab with `codex login --device-auth`|Codex has no credential: log in from the agent's CLI tab with `codex login --device-auth`/,
    );
    assert.equal(calls().length, 0);
  });

  test("a failed turn fails with the harness's error", async () => {
    const { sandbox } = harnessSandbox("codex", () => recorded("codex-failed"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    const result = await turn(context(sandbox, { harness: "codex", secrets: {} }).ctx, "x");
    assert.match(String(result.session_id), /^01a13707-cdbf/);
    assert.match(failureDetail("codex", result, null), /^error: unexpected status 401 Unauthorized/);
  });
});

describe("a turn with the Cursor driver", () => {
  const CHAT = "6d1c0f3e-9b2a-4e57-8c41-2a7f5e9d0b13";

  test("a turn reads its prompt from a file named on its command line and ends on its last message", async () => {
    const { sandbox, repo, calls } = harnessSandbox(
      "agent",
      (root) => recorded("cursor", [{ at: 5, path: path.join(root, "greet.py"), text: "print('hello, guild')\n" }]),
      { CURSOR_API_KEY: "cursor-key" },
    );
    const { ctx } = context(sandbox, { harness: "cursor", secrets: { CURSOR_API_KEY: "cursor-key" } });
    const result = await turn(ctx, "Make the greeting name the guild.");
    assert.equal(result.session_id, CHAT);
    assert.ok(result.message?.startsWith("Changed the greeting in greet.py"), "the last assistant message, not the joined result");
    const [call] = calls();
    const promptFile = path.join(sandbox.home, ".runs", "r_harness", "call_task.prompt.md");
    assert.deepEqual(call!.argv.slice(1), [
      "-p",
      "--force",
      "--trust",
      "--output-format",
      "stream-json",
      `Read your task in ${promptFile} and follow it.`,
    ]);
    assert.equal(call!.stdin, "", "the CLI takes no stdin");
    assert.equal(realpathSync(call!.cwd), realpathSync(repo));
  });

  test("a chat resumes with --resume", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { CURSOR_API_KEY: "cursor-key" });
    await turn(context(sandbox, { harness: "cursor", secrets: { CURSOR_API_KEY: "cursor-key" } }).ctx, "Yes.", { session: CHAT });
    assert.ok(calls()[0]!.argv.includes(`--resume=${CHAT}`));
  });

  test("the agent's harness model is passed with --model, before the prompt", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { CURSOR_API_KEY: "cursor-key" });
    const secrets = { CURSOR_API_KEY: "cursor-key" };
    await turn(context(sandbox, { harness: "cursor", secrets, harness_model: "sonnet-4-thinking" }).ctx, "x");
    const argv = calls()[0]!.argv;
    assert.deepEqual(argv.slice(-3, -1), ["--model", "sonnet-4-thinking"]);
    assert.match(argv.at(-1)!, /^Read your task in /);
  });

  test("a listed model starts under Cursor's name for the agent's effort, with no effort apart", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { CURSOR_API_KEY: "cursor-key" });
    const secrets = { CURSOR_API_KEY: "cursor-key" };
    const harness = { harness: "cursor" as const, secrets, harness_model: "claude-opus-5-5" };
    await turn(context(sandbox, { ...harness, harness_effort: "max" }).ctx, "x");
    await turn(context(sandbox, harness).ctx, "x", { callId: "call_default" });
    const [picked, plain] = calls();
    assert.deepEqual(picked!.argv.slice(-3, -1), ["--model", "claude-opus-5-5-max"]);
    assert.deepEqual(plain!.argv.slice(-3, -1), ["--model", "claude-opus-5-5-medium"]);
    assert.ok(!picked!.argv.includes("--effort"));
  });

  test("the helper refuses an effort apart from Cursor's model name, and never starts the harness", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { CURSOR_API_KEY: "cursor-key" });
    const ctx = toolFixture({ run_id: "r_harness", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    const start = { harness: "cursor", repository: "app", prompt: "x", model: "grok-4.7-high", effort: "high" };
    await assert.rejects(
      runCodeHelper(ctx.run, createToolHooks(), { op: "start", call_id: "call_effort", ...start }, { helper: HARNESS_HELPER }),
      /cursor takes its effort in the model name/,
    );
    assert.equal(calls().length, 0);
  });

  test("a CLI that refuses to start fails with what it wrote on stderr", async () => {
    const { sandbox } = harnessSandbox("agent", () => [], {
      CURSOR_API_KEY: "expired",
      HARNESS_STUB_EXIT: "1",
    });
    const stub = sandbox.env.PATH!.split(":")[0]!;
    writeFileSync(
      path.join(stub, "agent"),
      "#!/bin/sh\necho \"Error: Authentication required. Please run 'agent login' first.\" >&2\nexit 1\n",
    );
    const result = await turn(context(sandbox, { harness: "cursor", secrets: { CURSOR_API_KEY: "expired" } }).ctx, "x");
    assert.equal(result.exit_code, 1);
    assert.equal(failureDetail("cursor", result, null), "error: Error: Authentication required. Please run 'agent login' first.");
  });

  test("a login in the home is a credential", async () => {
    const { sandbox } = harnessSandbox("agent", () => recorded("cursor"));
    mkdirSync(path.join(sandbox.home, ".config", "cursor"), { recursive: true });
    writeFileSync(path.join(sandbox.home, ".config", "cursor", "auth.json"), "{}");
    assert.equal((await turn(context(sandbox, { harness: "cursor", secrets: {} }).ctx, "x")).exit_code, 0);
  });
});

test("each turn first removes the harness's local configuration and memory, never its login or sessions", async () => {
  const cases: Array<{ harness: "claude-code" | "codex" | "cursor" | "antigravity"; binary: string; removed: string[]; kept: string[] }> = [
    {
      harness: "claude-code",
      binary: "claude",
      removed: [
        ".claude/settings.json",
        ".claude/CLAUDE.md",
        ".claude/hooks/pre.sh",
        ".claude/plugins/p/plugin.json",
        ".claude/skills/s/SKILL.md",
        ".claude/projects/-home-a_1-repos-app/memory/MEMORY.md",
      ],
      kept: [".claude/.credentials.json", ".claude/projects/-home-a_1-repos-app/0f9c.jsonl", ".claude.json"],
    },
    {
      harness: "codex",
      binary: "codex",
      removed: [".codex/AGENTS.md", ".codex/skills/s/SKILL.md", ".codex/memories/m.md", ".codex/rules/r.rules"],
      kept: [".codex/auth.json", ".codex/config.toml", ".codex/sessions/2026/10/13/rollout.jsonl", ".codex/state_5.sqlite"],
    },
    {
      harness: "cursor",
      binary: "agent",
      removed: [
        ".cursor/hooks.json",
        ".cursor/mcp.json",
        ".cursor/rules/r.mdc",
        ".cursor/projects/home-a_1-repos-app/mcp-approvals.json",
        ".cursor/projects/home-a_1/mcp-disabled.json",
        ".cursor/projects/home-a_1/mcp-auth.json",
        "AGENTS.md",
        "repos/AGENTS.md",
        "repos/.cursor/rules/r.mdc",
      ],
      kept: [".config/cursor/auth.json", ".cursor/cli-config.json", ".cursor/chats/c/store.db"],
    },
    {
      harness: "antigravity",
      binary: "agy",
      removed: [".gemini/GEMINI.md", ".gemini/config/GEMINI.md", ".gemini/config/rules/r.md", ".gemini/config/mcp_config.json"],
      kept: [".gemini/antigravity-cli/antigravity-oauth-token", ".gemini/antigravity-cli/conversations/c.db"],
    },
  ];
  for (const { harness, binary, removed, kept } of cases) {
    const { sandbox, repo } = harnessSandbox(binary, () => recorded(harness === "claude-code" ? "claude-code" : harness));
    for (const file of [...removed, ...kept]) {
      mkdirSync(path.dirname(path.join(sandbox.home, file)), { recursive: true });
      writeFileSync(path.join(sandbox.home, file), file === ".codex/auth.json" ? '{"tokens": {"refresh_token": "r"}}' : "x");
    }
    mkdirSync(path.join(repo, ".claude"), { recursive: true });
    writeFileSync(path.join(repo, ".claude", "settings.json"), "{}");
    const secret = { "claude-code": "CLAUDE_CODE_OAUTH_TOKEN", codex: null, cursor: "CURSOR_API_KEY", antigravity: null }[harness];
    const secrets: Record<string, string> = secret === null ? {} : { [secret]: "t" };
    assert.equal((await turn(context(sandbox, { harness, secrets }).ctx, "x")).exit_code, 0, harness);
    for (const file of removed) {
      assert.equal(existsSync(path.join(sandbox.home, file)), false, `${harness} removes ${file}`);
    }
    for (const file of kept) {
      assert.equal(existsSync(path.join(sandbox.home, file)), true, `${harness} keeps ${file}`);
    }
    assert.ok(existsSync(path.join(repo, ".claude", "settings.json")), "the repository is left as it is");
  }
});

/** The harness's process group outlives the exec that started it, and only `stop` ends it. */
test("a supervisor outlives the call that started it, and stop ends the harness's process group", async () => {
  const lines = recorded("claude-code").slice(0, 2);
  const { sandbox } = harnessSandbox("claude", () => [...lines, JSON.stringify({ stub: "hang" })]);
  const ctx = toolFixture({ run_id: "r_detached", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
  const op = (name: string, args: Record<string, unknown> = {}) =>
    runCodeHelper(ctx.run, createToolHooks(), { op: name, call_id: "call_detached", harness: "claude-code", ...args }, { helper: HARNESS_HELPER });
  const started = await op("start", { repository: "app", prompt: "Anything." });
  assert.equal(typeof started.meta.pid, "number");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const polled = await op("poll", { offset: 0 });
  assert.equal(polled.meta.exited, false, "still running with nobody polling it");
  assert.equal(polled.meta.session_id, SESSION);
  assert.ok((polled.meta.lines as string[]).includes("I'll look at the greeting first."));
  const stopped = await op("stop");
  assert.equal(stopped.meta.exited, true);
  assert.equal(stopped.meta.session_id, SESSION);
  assert.equal(stubsRunning(sandbox), false);
  const result = await op("result");
  assert.equal(result.meta.is_error, true);
  assert.equal((await op("poll", { offset: 0 })).meta.missing, true, "result clears the call's state");
});

describe("a harness started for a run's own turn", () => {
  /** The `guilds-harness` ops of call `callId` in run `r_turn`, on `sandbox`. */
  function turnOps(sandbox: HostCodeSandbox, callId: string) {
    const ctx = toolFixture({ run_id: "r_turn", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    return (name: string, args: Record<string, unknown> = {}) =>
      runCodeHelper(ctx.run, createToolHooks(), { op: name, call_id: callId, harness: "claude-code", ...args }, { helper: HARNESS_HELPER });
  }

  test("a system prompt replaces Claude Code's own from a private file in the run folder that goes with the call", async () => {
    const { sandbox, calls } = hangingSandbox();
    const op = turnOps(sandbox, "call_turn");
    await op("start", { prompt: "hello", system_prompt: "You are the guild's agent.", model: "opus" });
    const systemFile = path.join(sandbox.home, ".runs", "r_turn", "call_turn.system.md");
    for (let attempt = 0; attempt < 100 && !calls().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [call] = calls();
    assert.ok(call);
    const at = call.argv.indexOf("--system-prompt-file");
    assert.equal(call.argv[at + 1], systemFile);
    assert.equal(call.argv[at - 2], "--settings", "after the settings that turn hooks, plugins and project MCP servers off");
    assert.deepEqual(call.argv.slice(at + 2), ["--model", "opus"]);
    assert.ok(call.argv.includes("--strict-mcp-config"));
    assert.equal(call.stdin, "hello", "the prompt stays on stdin");
    assert.equal(realpathSync(call.cwd), realpathSync(sandbox.home), "with no repository named it runs in the home");
    assert.equal(readFileSync(systemFile, "utf8"), "You are the guild's agent.");
    assert.equal(statSync(systemFile).mode & 0o777, 0o600);
    await op("stop");
    await op("result");
    assert.equal(existsSync(systemFile), false, "the system prompt goes with the call's state");
    assert.equal(existsSync(path.join(sandbox.home, ".runs", "r_turn", "call_turn.prompt.md")), false);
  });

  test("a system prompt replaces Codex's own instructions from a private file in the run folder that goes with the call", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => [JSON.stringify({ stub: "hang" })]);
    const op = turnOps(sandbox, "call_codex_turn");
    await op("start", { harness: "codex", prompt: "hello", system_prompt: "You are the guild's agent." });
    const systemFile = path.join(sandbox.home, ".runs", "r_turn", "call_codex_turn.system.md");
    for (let attempt = 0; attempt < 100 && !calls().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [call] = calls();
    assert.ok(call);
    const at = call.argv.indexOf(`model_instructions_file=${JSON.stringify(systemFile)}`);
    assert.equal(call.argv[at - 1], "-c");
    assert.ok(at > call.argv.indexOf("--ignore-user-config"), "after the overrides that keep the home's configuration out");
    assert.equal(call.system_prompt, "You are the guild's agent.");
    assert.equal(statSync(systemFile).mode & 0o777, 0o600);
    assert.equal(call.stdin, "hello", "the prompt stays on stdin");
    await op("stop", { harness: "codex" });
    await op("result", { harness: "codex" });
    assert.equal(existsSync(systemFile), false, "the system prompt goes with the call's state");
  });

  test("a turn limit ends Claude Code's turn after that many model calls, and a turn that stops at it says so", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => [
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 5, session_id: SESSION }),
    ]);
    const op = turnOps(sandbox, "call_limited");
    await op("start", { prompt: "hello", model: "opus", effort: "high", max_turns: 5 });
    for (let attempt = 0; attempt < 100 && !calls().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [call] = calls();
    assert.ok(call);
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--model")), ["--model", "opus", "--effort", "high", "--max-turns", "5"]);
    let polled = await op("poll", { offset: 0 });
    for (let attempt = 0; attempt < 200 && polled.meta.exited !== true; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      polled = await op("poll", { offset: 0 });
    }
    const result = await op("result");
    assert.equal(result.meta.max_turns, true);
    assert.equal(result.meta.is_error, true);
  });

  test("a CLI with no turn limit refuses one, and a limit that is not a count is refused, before the call starts", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    const op = turnOps(sandbox, "call_codex_limit");
    await assert.rejects(op("start", { harness: "codex", prompt: "hello", max_turns: 5 }), /codex takes no turn limit/);
    await assert.rejects(op("start", { harness: "claude-code", prompt: "hello", max_turns: "5" }), /max_turns is invalid/);
    await assert.rejects(op("start", { harness: "claude-code", prompt: "hello", max_turns: -1 }), /max_turns is invalid/);
    assert.equal(calls().length, 0);
  });

  /** Waits until the stand-in CLI of `calls` recorded its first start. */
  async function firstCall(calls: () => Recorded[]): Promise<Recorded> {
    for (let attempt = 0; attempt < 100 && !calls().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [call] = calls();
    assert.ok(call);
    return call;
  }

  test("a system prompt reaches Cursor as a rule that always applies, in the home outside the repository, which goes with the call", async () => {
    const { sandbox, repo, calls } = harnessSandbox("agent", () => [JSON.stringify({ stub: "hang" })]);
    const op = turnOps(sandbox, "call_cursor_rules");
    await op("start", { harness: "cursor", repository: "app", prompt: "hello", system_prompt: "You are the guild's agent." });
    const rules = path.join(sandbox.home, ".cursor", "rules", "guilds.mdc");
    const call = await firstCall(calls);
    assert.equal(
      call.system_prompt,
      "---\ndescription: The guild's instructions for this turn\nalwaysApply: true\n---\n\nYou are the guild's agent.",
    );
    assert.equal(statSync(rules).mode & 0o777, 0o600);
    assert.ok(!call.argv.some((arg) => arg.includes("guilds.mdc")), "the CLI finds the rule where it reads its own");
    assert.equal(realpathSync(call.cwd), realpathSync(repo));
    assert.equal(git(repo, sandbox.home, ["status", "--porcelain"]), "", "nothing in the repository's working tree changed");
    await op("stop", { harness: "cursor" });
    await op("result", { harness: "cursor" });
    assert.equal(existsSync(rules), false, "the rule goes with the call's state");
  });

  test("a turn of Antigravity reads its prompt as one stream-json message on stdin, and its system prompt as a global rule that goes with the call", async () => {
    const { sandbox, repo, calls } = harnessSandbox("agy", () => [JSON.stringify({ stub: "hang" })]);
    const op = turnOps(sandbox, "call_agy_rules");
    await op("start", { harness: "antigravity", repository: "app", prompt: "hello", system_prompt: "You are the guild's agent." });
    const rules = path.join(sandbox.home, ".gemini", "GEMINI.md");
    const call = await firstCall(calls);
    assert.equal(call.stdin, '{"event": "user", "message": {"content": "hello"}}\n');
    assert.deepEqual(call.argv.slice(1, 7), ["--output-format", "stream-json", "--input-format", "stream-json", "--dangerously-skip-permissions", "--disable-slash-commands"]);
    assert.ok(!call.argv.includes("-p") && !call.argv.includes("--add-dir"), "the prompt is on no command line, and the workspace is the repository alone");
    assert.equal(call.system_prompt, "You are the guild's agent.");
    assert.equal(statSync(rules).mode & 0o777, 0o600);
    assert.equal(git(repo, sandbox.home, ["status", "--porcelain"]), "", "nothing in the repository's working tree changed");
    await op("stop", { harness: "antigravity" });
    await op("result", { harness: "antigravity" });
    assert.equal(existsSync(rules), false, "the rule goes with the call's state");
  });

  /** A turn's MCP server: the URL the stand-in is given, and a token of the length the orchestrator issues. */
  const MCP = { url: "http://172.17.0.1:8090/mcp/a_1", token: "t".repeat(43) };

  /** Starts `harness` for call `callId` of run `r_turn` on `sandbox` the way a turn does, given `mcp`. */
  async function startTurn(
    sandbox: HostCodeSandbox,
    callId: string,
    mcp: { url: string; token: string } | null,
    harness: "claude-code" | "codex" | "cursor" | "antigravity" = "claude-code",
  ) {
    const ctx = toolFixture({ run_id: "r_turn", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    await launchHarness(opsRun(ctx.run), callId, {
      harness,
      prompt: "hello",
      repository: null,
      system_prompt: "You are the guild's agent.",
      mcp,
      session_id: null,
      model: null,
      effort: null,
      max_turns: null,
    });
  }

  test("an MCP server reaches Claude Code through a private configuration file in the run folder that goes with the call", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => [JSON.stringify({ stub: "hang" })], {
      HARNESS_STUB_SEEK: MCP.token,
    });
    await startTurn(sandbox, "call_mcp", MCP);
    const configFile = path.join(sandbox.home, ".runs", "r_turn", "call_mcp.mcp.json");
    for (let attempt = 0; attempt < 100 && !calls().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [call] = calls();
    assert.ok(call);
    const at = call.argv.indexOf("--mcp-config");
    assert.equal(call.argv[at + 1], configFile);
    assert.ok(call.argv.includes("--strict-mcp-config"), "the file's server is the only one");
    assert.deepEqual(call.mcp_config, {
      mcpServers: { guilds: { type: "http", url: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } } },
    });
    assert.equal(call.mcp_config_mode, 0o600);
    assert.ok(!call.argv.some((arg) => arg.includes(MCP.token)), "the token is on no command line");
    assert.deepEqual(call.env_holding_seek, [], "nor in the CLI's environment");
    assert.ok(!sandbox.commandsRun.some((command) => command.includes(Buffer.from(MCP.token).toString("base64").slice(0, 40))));
    assert.ok(sandbox.written.some((written) => written.startsWith("/run/guilds/requests/")), "the start travels through a request file");
    assert.deepEqual(readdirSync(path.join(sandbox.runDir, "requests")), [], "which the helper removes once read");
    const op = turnOps(sandbox, "call_mcp");
    await op("stop");
    await op("result");
    assert.equal(existsSync(configFile), false, "the MCP configuration goes with the call's state");
  });

  test("an MCP server reaches Codex through overrides for the one call, its token in the CLI's own environment alone", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => [JSON.stringify({ stub: "hang" })], {
      HARNESS_STUB_SEEK: MCP.token,
    });
    await startTurn(sandbox, "call_codex_mcp", MCP, "codex");
    const configFile = path.join(sandbox.home, ".runs", "r_turn", "call_codex_mcp.mcp.json");
    for (let attempt = 0; attempt < 100 && !calls().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [call] = calls();
    assert.ok(call);
    const overrides = call.argv.flatMap((arg, at) => (call.argv[at - 1] === "-c" ? [arg] : []));
    const cleared = overrides.indexOf("mcp_servers={}");
    assert.deepEqual(overrides.slice(overrides.indexOf(`mcp_servers.guilds.url="${MCP.url}"`)), [
      `mcp_servers.guilds.url="${MCP.url}"`,
      'mcp_servers.guilds.bearer_token_env_var="GUILDS_MCP_TOKEN"',
      'shell_environment_policy.exclude=["GUILDS_MCP_TOKEN"]',
    ]);
    assert.ok(cleared >= 0 && cleared < overrides.indexOf(`mcp_servers.guilds.url="${MCP.url}"`), "every other server is dropped first");
    assert.deepEqual(call.mcp_config, {
      mcpServers: { guilds: { type: "http", url: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } } },
    });
    assert.ok(!call.argv.some((arg) => arg.includes(MCP.token)), "the token is on no command line");
    assert.deepEqual(call.env_holding_seek, ["GUILDS_MCP_TOKEN"], "only the variable the server names holds it");
    assert.equal(statSync(configFile).mode & 0o777, 0o600);
    const op = turnOps(sandbox, "call_codex_mcp");
    await op("stop", { harness: "codex" });
    await op("result", { harness: "codex" });
    assert.equal(existsSync(configFile), false, "the file that carried the token goes with the call's state");
  });

  test("an MCP server reaches Cursor and Antigravity through their own configuration in the home alone, which goes with the call", async () => {
    const cases = [
      { harness: "cursor" as const, binary: "agent", file: [".cursor", "mcp.json"], key: "url" },
      { harness: "antigravity" as const, binary: "agy", file: [".gemini", "config", "mcp_config.json"], key: "serverUrl" },
    ];
    for (const { harness, binary, file, key } of cases) {
      const { sandbox, calls } = harnessSandbox(binary, () => [JSON.stringify({ stub: "hang" })], { HARNESS_STUB_SEEK: MCP.token });
      const configFile = path.join(sandbox.home, ...file);
      mkdirSync(path.dirname(configFile), { recursive: true });
      writeFileSync(configFile, JSON.stringify({ mcpServers: { planted: { [key]: "http://203.0.113.9/mcp" } } }));
      await startTurn(sandbox, `call_${harness}_mcp`, MCP, harness);
      const call = await firstCall(calls);
      assert.deepEqual(
        JSON.parse(readFileSync(configFile, "utf8")),
        { mcpServers: { guilds: { [key]: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } } } },
        `${harness}: the turn's server is the only one`,
      );
      assert.equal(call.mcp_config_mode, 0o600);
      assert.ok(!call.argv.some((arg) => arg.includes(MCP.token)), `${harness}: the token is on no command line`);
      assert.deepEqual(call.env_holding_seek, [], `${harness}: nor in the CLI's environment`);
      const op = turnOps(sandbox, `call_${harness}_mcp`);
      await op("stop", { harness });
      await op("result", { harness });
      assert.equal(existsSync(configFile), false, `${harness}: the configuration that carried the token goes with the call's state`);
    }
  });

  test("a Cursor turn in the home approves its MCP server there once it is written, and a turn in a repository approves none", async () => {
    const approvals = path.join(tempDir("harness-approvals-"), "approvals.jsonl");
    const { sandbox, calls } = harnessSandbox("agent", () => [JSON.stringify({ stub: "hang" })], { HARNESS_STUB_APPROVALS: approvals });
    const approved = () => readFileSync(approvals, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Recorded);
    await startTurn(sandbox, "call_cursor_home", MCP, "cursor");
    await firstCall(calls);
    const [approval] = approved();
    assert.deepEqual(approval!.argv.slice(1), ["mcp", "enable", "guilds"]);
    assert.equal(realpathSync(approval!.cwd), realpathSync(sandbox.home));
    assert.deepEqual(approval!.mcp_config, {
      mcpServers: { guilds: { type: "http", url: MCP.url, headers: { Authorization: `Bearer ${MCP.token}` } } },
    });
    const home = turnOps(sandbox, "call_cursor_home");
    await home("stop", { harness: "cursor" });
    await home("result", { harness: "cursor" });
    const repository = turnOps(sandbox, "call_cursor_repository");
    await repository("start", { harness: "cursor", repository: "app", prompt: "hello", mcp_url: MCP.url, mcp_token: MCP.token });
    await repository("stop", { harness: "cursor" });
    await repository("result", { harness: "cursor" });
    assert.equal(approved().length, 1, "in a repository the home's configuration is the user's alone");
  });

  test("a Cursor turn in the home whose MCP server the CLI does not approve fails before the CLI starts", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { HARNESS_STUB_APPROVE_EXIT: "1" });
    await assert.rejects(
      startTurn(sandbox, "call_cursor_refused", MCP, "cursor"),
      /agent did not approve the guilds MCP server: MCP server 'guilds' not found in configuration/,
    );
    assert.equal(calls().length, 0);
  });

  test("an MCP server whose URL or token is malformed, or that comes without the other, is refused", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"));
    const op = turnOps(sandbox, "call_bad_mcp");
    await assert.rejects(op("start", { prompt: "hello", mcp_url: "file:///etc/passwd", mcp_token: MCP.token }), /mcp_url is invalid/);
    await assert.rejects(op("start", { prompt: "hello", mcp_url: `${MCP.url} --x`, mcp_token: MCP.token }), /mcp_url is invalid/);
    await assert.rejects(op("start", { prompt: "hello", mcp_url: MCP.url, mcp_token: "short" }), /mcp_token is invalid/);
    await assert.rejects(op("start", { prompt: "hello", mcp_url: MCP.url, mcp_token: `${MCP.token}"x` }), /mcp_token is invalid/);
    await assert.rejects(op("start", { prompt: "hello", mcp_url: MCP.url }), /mcp_url and mcp_token go together/);
    await assert.rejects(op("start", { prompt: "hello", mcp_token: MCP.token }), /mcp_url and mcp_token go together/);
    assert.equal(calls().length, 0);
  });

  test("a turn given no MCP server starts Claude Code with none", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => [JSON.stringify({ stub: "hang" })]);
    await startTurn(sandbox, "call_no_mcp", null);
    for (let attempt = 0; attempt < 100 && !calls().length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [call] = calls();
    assert.ok(call);
    assert.ok(!call.argv.includes("--mcp-config"));
    assert.ok(call.argv.includes("--strict-mcp-config"));
    assert.equal(sandbox.written.length, 0, "the start travels inline");
    const op = turnOps(sandbox, "call_no_mcp");
    await op("stop");
    await op("result");
  });

  test("a poll returns the raw events it read past the offset, through the last whole line", async () => {
    const { sandbox } = harnessSandbox("claude", () => recorded("claude-code"));
    const op = turnOps(sandbox, "call_raw");
    await op("start", { prompt: "hello" });
    let polled = await op("poll", { offset: 0 });
    for (let attempt = 0; attempt < 200 && polled.meta.exited !== true; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      polled = await op("poll", { offset: 0 });
    }
    assert.equal(polled.text, recorded("claude-code").join("\n") + "\n");
    assert.equal(polled.meta.offset, Buffer.byteLength(polled.text));
    const later = await op("poll", { offset: polled.meta.offset });
    assert.equal(later.text, "");
    await op("result");
  });
});

/** A Claude Code sandbox whose CLI reports its session, then hangs with `hang` until it is stopped. */
function hangingSandbox(hang: Record<string, unknown> = { stub: "hang" }) {
  const lines = recorded("claude-code").slice(0, 2);
  return harnessSandbox("claude", () => [...lines, JSON.stringify(hang)], { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
}

test("progress lines are redacted before they are clipped, so a secret at the cut is never shown in part", () => {
  const secret = "s3cr3t-value-that-crosses-the-cut";
  const [line] = shownProgressLines([`${"x".repeat(230)}${secret} and more`], { TOKEN: secret });
  assert.equal(line!.length, 240);
  assert.ok(line!.endsWith("…"));
  assert.ok(!line!.includes("s3cr3t"));
  assert.ok(line!.includes("[REDACTED"));
  assert.deepEqual(shownProgressLines(["short line"], {}), ["short line"]);
});

test("a failed turn names the most telling reason it has", () => {
  const detail = (result: Record<string, unknown>) => failureDetail("codex", result, "1.0");
  assert.equal(detail({ events: 0, unparsed: 2 }), "error: the codex driver does not parse this CLI's output (1.0)");
  assert.equal(failureDetail("codex", { events: 0, unparsed: 2 }, null), "error: the codex driver does not parse this CLI's output (unknown version)");
  assert.equal(detail({ events: 0, stderr: "a\nNot logged in\n", error: "turn failed" }), "error: a\nNot logged in");
  assert.equal(detail({ events: 4, stderr: "noise", error: "401 Unauthorized\nmore" }), "error: 401 Unauthorized");
  assert.equal(detail({ events: 4, stderr: "killed" }), "error: killed");
  assert.equal(detail({ events: 4, exit_code: 2 }), "error: exited with code 2");
  assert.equal(detail({ events: 4 }), "error: exited with code unknown");
});

test("stop kills a harness that ignores SIGTERM once the grace period is over", async () => {
  const { sandbox } = hangingSandbox({ stub: "hang", ignore_term: true });
  const ctx = toolFixture({ run_id: "r_term", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
  const op = (name: string, args: Record<string, unknown> = {}) =>
    runCodeHelper(ctx.run, createToolHooks(), { op: name, call_id: "call_term", harness: "claude-code", ...args }, { helper: HARNESS_HELPER });
  await op("start", { repository: "app", prompt: "Anything." });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const began = Date.now();
  const stopped = await op("stop");
  assert.equal(stopped.meta.exited, true);
  assert.ok(Date.now() - began >= 9_000, "SIGTERM alone did not end it");
  assert.equal(stubsRunning(sandbox), false);
});

describe("the processes a turn starts, whatever session they move to", {
  skip: process.platform === "linux" ? false : "only Linux has the child subreaper the supervisor relies on",
}, () => {
  /** The ops of call `callId` in run `runId`, on `sandbox`. */
  function callOps(sandbox: HostCodeSandbox, runId: string, callId: string) {
    const ctx = toolFixture({ run_id: runId, agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    return (name: string, args: Record<string, unknown> = {}) =>
      runCodeHelper(ctx.run, createToolHooks(), { op: name, call_id: callId, harness: "claude-code", ...args }, { helper: HARNESS_HELPER });
  }

  /**
   * A Claude Code sandbox whose CLI starts `sleep` in a session of its own whose parent exits at
   * once, after the recorded event at `at`, then goes on with `rest`; and the file the sleep's
   * pid is written to.
   */
  function detachingSandbox(at: number, rest: string[]) {
    const pidFile = path.join(tempDir("harness-detached-"), "pid");
    const detach = JSON.stringify({ stub: "detach", argv: ["sleep", "300"], pid_file: pidFile });
    const lines = recorded("claude-code").slice(0, at + 1);
    const { sandbox } = harnessSandbox("claude", () => [...lines, detach, ...rest], { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    return { sandbox, pidFile };
  }

  /** The pid in `file` once it is written. */
  async function pidIn(file: string): Promise<number> {
    for (let attempt = 0; attempt < 100 && !existsSync(file); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return Number(readFileSync(file, "utf8"));
  }

  /** Whether process `pid` runs; a zombie has ended. */
  function running(pid: number): boolean {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    } catch {
      return false;
    }
  }

  test("stop ends a process the harness started in a session of its own after its parent exited, and no process outside the turn", async () => {
    const turnA = detachingSandbox(1, [HANG]);
    const turnB = detachingSandbox(1, [HANG]);
    const outside = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    const opA = callOps(turnA.sandbox, "r_tree", "call_tree");
    const opB = callOps(turnB.sandbox, "r_tree", "call_tree");
    try {
      await opA("start", { repository: "app", prompt: "Anything." });
      await opB("start", { repository: "app", prompt: "Anything." });
      const [detachedA, detachedB] = [await pidIn(turnA.pidFile), await pidIn(turnB.pidFile)];
      assert.equal(running(detachedA), true, "the detached process outlived the process that started it");
      const stopped = await opA("stop");
      assert.equal(stopped.meta.exited, true);
      assert.equal(running(detachedA), false, "the turn's detached process ended before stop answered");
      assert.equal(stubsRunning(turnA.sandbox), false);
      assert.equal(running(detachedB), true, "another turn's process is left running");
      assert.equal(running(outside.pid!), true, "a process outside every turn is left running");
    } finally {
      await opB("stop");
      outside.kill("SIGKILL");
    }
  });

  test("a process the harness left running ends with the turn when the CLI exits by itself", async () => {
    const { sandbox, pidFile } = detachingSandbox(0, recorded("claude-code").slice(1));
    const { ctx } = context(sandbox);
    const result = await turn(ctx, "Anything.");
    assert.equal(result.is_error, false);
    assert.equal(running(await pidIn(pidFile)), false, "nothing the turn started outlives it");
  });

  test("stop leaves the processes of a pid the call's supervisor no longer holds", async () => {
    const { sandbox } = hangingSandbox();
    const op = callOps(sandbox, "r_reused", "call_reused");
    await op("start", { repository: "app", prompt: "Anything." });
    const other = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    try {
      const child = Number(await new Promise<string>((resolve) => other.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")))));
      const stateFile = path.join(sandbox.runDir, "a_1", "harness", "call_reused.json");
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
      writeFileSync(stateFile, JSON.stringify({ ...state, supervisor_pid: other.pid }));
      const stopped = await op("stop");
      assert.equal(stopped.meta.exited, true);
      assert.equal(stubsRunning(sandbox), false, "the CLI's process group still ends");
      assert.equal(running(other.pid!), true, "the process that holds the pid now is left running");
      assert.equal(running(child), true, "and so is what it started");
    } finally {
      process.kill(-other.pid!, "SIGKILL");
    }
  });
});

/** The stub CLI's processes: their command line names the stub's own folder. */
function stubPids(sandbox: HostCodeSandbox): number[] {
  const bin = sandbox.env.PATH!.split(":")[0]!;
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line.includes(`${bin}/`))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function stubsRunning(sandbox: HostCodeSandbox): boolean {
  return stubPids(sandbox).length > 0;
}
