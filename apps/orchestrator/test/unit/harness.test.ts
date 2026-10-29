import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { CancelEvent, type ToolContext } from "../../src/toolbox/types.js";
import { HARNESS_HELPER, runCodeHelper } from "../../src/toolbox/code.js";
import {
  assertHarnessReady,
  BRIEF_PREAMBLE,
  buildBrief,
  checkHarnessOn,
  codeTaskText,
  failureDetail,
  formatDuration,
  HarnessSetupError,
  harnessTiming,
  HARNESS_LOG_MAX_BYTES,
  notePaths,
  readHarnessLog,
  shownProgressLines,
  timeoutMinutes,
  type CodeTaskOutcome,
} from "../../src/toolbox/harness.js";
import { applySecretAliases } from "../../src/access/runtime.js";
import { answerOps, HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";
import { noteRowAt } from "../helpers/artifacts.js";
import { fakeToolboxDatabase, fakeToolEvents } from "../helpers/toolbox.js";
import { agentActor } from "../../src/artifacts/actors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "../helpers/harness/stub-cli");
const RECORDED = path.join(HERE, "../helpers/harness");
const SESSION = "0f9c2a64-5b1e-4c3d-9a8e-2f1d7c6b5a40";
const TOKEN = "oauth-subscription-token";

type Recorded = { argv: string[]; cwd: string; stdin: string; env: Record<string, string | null> };

const timing = { ...harnessTiming };
before(() => {
  harnessTiming.pollMs = 50;
});
after(() => {
  Object.assign(harnessTiming, timing);
});

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

function context(sandbox: HostCodeSandbox, overrides: Partial<ToolContext> = {}) {
  const progress: string[] = [];
  const remembered: Array<Record<string, unknown>> = [];
  const ctx = createToolContext({
    run_id: "r_harness",
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox,
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    harness: "claude-code",
    code_repositories: ["app"],
    events: fakeToolEvents((_event, data) => {
      progress.push(...(Array.isArray(data.lines) ? data.lines.map(String) : []));
    }),
    db: fakeToolboxDatabase({
      mergeRunMetadata: async (_runId, extra) => {
        if (extra.harness_task) {
          remembered.push(extra.harness_task);
        }
      },
    }),
    ...overrides,
  });
  return { ctx, progress, remembered };
}

async function codeTask(ctx: ToolContext, args: Record<string, unknown>, callId = "call_task") {
  const [payload, metadata] = await invokeTool(
    ctx,
    { id: callId, type: "function", function: { name: "code_task", arguments: JSON.stringify(args) } },
    ctx.secrets,
    65536,
  );
  return { text: String(payload.content), metadata };
}

describe("code_task with the Claude Code driver", () => {
  test("a turn runs headless in the repository on the subscription and returns its result and diff", async () => {
    const { sandbox, repo, calls } = harnessSandbox("claude", (root) =>
      recorded("claude-code", [{ at: 3, path: path.join(root, "greet.py"), text: "print('hello, guild')\n" }]),
      { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    );
    const { ctx, progress, remembered } = context(sandbox);
    const { text, metadata } = await codeTask(ctx, { brief: "Make the greeting name the guild." });

    const lines = text.split("\n");
    assert.match(lines[0]!, new RegExp(`^completed · claude-code · app · session ${SESSION} · \\d+s$`));
    assert.equal(lines[1], "1 file changed, +1 −1");
    assert.equal(lines[2], "greet.py (+1 −1)");
    assert.ok(text.includes("Should the greeting also name the agent?"));
    assert.ok(text.endsWith("log: .runs/r_harness/call_task.harness.jsonl"));
    assert.ok(!text.includes(TOKEN), "the token is redacted from the result");

    assert.equal(metadata.status, "completed");
    assert.equal(metadata.harness, "claude-code");
    assert.equal(metadata.session_id, SESSION);
    assert.equal(metadata.repository, "app");
    assert.equal(metadata.exit_code, 0);
    assert.equal(metadata.files_changed, 1);
    assert.equal(metadata.insertions, 1);
    assert.equal(metadata.deletions, 1);
    assert.match(String(metadata.start_sha), /^[0-9a-f]{40}$/);
    assert.match(String(metadata.end_sha), /^[0-9a-f]{40}$/);
    assert.equal(metadata.log_path, ".runs/r_harness/call_task.harness.jsonl");
    assert.equal(metadata.error, null);

    assert.ok(progress.includes("Read: /home/a_1/repos/app/greet.py"), progress.join("\n"));
    assert.ok(progress.includes("Edit: /home/a_1/repos/app/greet.py"));
    assert.ok(progress.includes("Bash: python3 greet.py"));
    assert.equal(remembered.at(-1)?.session_id, SESSION);

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
    assert.ok(call.stdin.startsWith(BRIEF_PREAMBLE), "the prompt reaches the CLI on stdin");
    assert.ok(call.stdin.includes("Make the greeting name the guild."));
    assert.ok(!call.argv.some((arg) => arg.includes("Make the greeting")), "never on its command line");
    assert.equal(call.env.IS_SANDBOX, "1");
    assert.equal(call.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(call.env.ANTHROPIC_API_KEY, null, "a metered key never reaches the harness");
    assert.equal(call.env.CLAUDE_CODE_USE_BEDROCK, null, "nor a switch to metered Bedrock");
    assert.equal(call.env.CLAUDE_CODE_USE_VERTEX, null, "nor a switch to metered Vertex");
    assert.equal(call.env.GH_TOKEN, null);
    assert.equal(call.env.GUILD_RUN_ID, "r_harness");
    assert.equal(call.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);

    const refs = git(repo, sandbox.home, ["for-each-ref", "--format=%(refname)", "refs/guild"]).trim().split("\n");
    assert.deepEqual(refs.sort(), [
      "refs/guild/runs/r_harness/tasks/call_task/end",
      "refs/guild/runs/r_harness/tasks/call_task/start",
    ]);
    const diff = await runCodeHelper(ctx, "diff", { repository: "app", task: "call_task" });
    assert.match(diff.text, /\+print\('hello, guild'\)/);
    assert.ok(existsSync(path.join(sandbox.home, ".runs/r_harness/call_task.harness.jsonl")), "the raw log stays");
    assert.ok(!existsSync(path.join(sandbox.home, ".runs/r_harness/call_task.prompt.md")), "the prompt file goes");
  });

  test("a session resumes with the brief as its next turn", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    const { ctx } = context(sandbox);
    const { metadata } = await codeTask(ctx, { brief: "Yes, name the agent too.", session_id: SESSION });
    assert.equal(metadata.status, "completed");
    const [call] = calls();
    assert.deepEqual(call!.argv.slice(-2), ["--resume", SESSION]);
    assert.ok(call!.stdin.includes("Yes, name the agent too."));
  });

  test("the agent's harness model is passed with --model; without one the subscription picks", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    await codeTask(context(sandbox, { harness_model: "opus" }).ctx, { brief: "x", session_id: SESSION });
    await codeTask(context(sandbox).ctx, { brief: "x" }, "call_default");
    const [pinned, plain] = calls();
    assert.deepEqual(pinned!.argv.slice(-4), ["--model", "opus", "--resume", SESSION]);
    assert.ok(!plain!.argv.includes("--model"));
  });

  test("the agent's harness effort is passed with --effort, after the model", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    await codeTask(context(sandbox, { harness_model: "opus", harness_effort: "xhigh" }).ctx, { brief: "x", session_id: SESSION });
    await codeTask(context(sandbox, { harness_effort: "low" }).ctx, { brief: "x" }, "call_default");
    const [pinned, plain] = calls();
    assert.deepEqual(pinned!.argv.slice(-6), ["--model", "opus", "--effort", "xhigh", "--resume", SESSION]);
    assert.deepEqual(plain!.argv.slice(-2), ["--effort", "low"]);
  });

  test("the helper refuses an effort it does not know, and never starts the harness", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    const { text } = await codeTask(context(sandbox, { harness_effort: "--x" as never }).ctx, { brief: "x" });
    assert.match(text, /^ERROR: .*effort is invalid/);
    assert.equal(calls().length, 0);
  });

  test("the helper refuses a model that is not a model name, and never starts the harness", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    const { text } = await codeTask(context(sandbox, { harness_model: "--settings={}" }).ctx, { brief: "x" });
    assert.match(text, /^ERROR: .*model is invalid/);
    assert.equal(calls().length, 0);
  });

  test("notes are appended to the brief under their display paths", async () => {
    const notes: Record<string, string> = {
      "org/org_1/guilds/guild_1/conventions.md": "Use tabs.",
      "org/org_1/guilds/guild_1/large.md": "x".repeat(70 * 1024),
    };
    const fakeStore = {
      async artifactAt(_actor: unknown, displayPath: string) {
        if (!(displayPath in notes)) {
          throw new Error("artifact not found");
        }
        const text = notes[displayPath] ?? "";
        return { kind: "row", row: noteRowAt(displayPath, text), href: displayPath, text, deleted: false };
      },
    };
    const { ctx } = context(new HostCodeSandbox(), {
      artifacts: fakeStore as unknown as ToolContext["artifacts"],
      artifact_actor: agentActor({ orgId: "org_1", guildId: "guild_1", agentId: "a_1", agentName: "researcher" }),
    });
    const brief = await buildBrief(ctx, "Tidy greet.py.", Object.keys(notes));
    assert.ok(brief.startsWith(BRIEF_PREAMBLE));
    assert.ok(brief.includes("# Task\n\nTidy greet.py."));
    assert.ok(brief.includes("# org/org_1/guilds/guild_1/conventions.md\n\nUse tabs."));
    assert.ok(brief.includes("Not included, past the 64 KiB cap for notes: org/org_1/guilds/guild_1/large.md"));
    await assert.rejects(() => buildBrief(ctx, "x", ["org/org_1/guilds/guild_1/missing.md"]), /notes: .*missing\.md/);
  });

  test("without a credential the call fails, naming the secret to grant and the login to run", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"));
    const { ctx } = context(sandbox, { secrets: {} });
    const { text, metadata } = await codeTask(ctx, { brief: "Anything." });
    assert.match(text, /^ERROR: Claude Code has no credential: grant the secret CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(text, /claude, then \/login/);
    assert.ok(metadata.error);
    assert.equal(calls().length, 0, "the harness never starts");
  });

  test("an aliased secret is the credential, and a missing one is named with the variable it is read as", async () => {
    const aliases = { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" };
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), {
      ...applySecretAliases({ BOB_TOKEN: "bob-token" }, aliases),
      HARNESS_STUB_SHOW: "CLAUDE_CODE_OAUTH_TOKEN,BOB_TOKEN",
    });
    const { metadata } = await codeTask(context(sandbox, { secret_aliases: aliases }).ctx, { brief: "x" });
    assert.equal(metadata.status, "completed");
    assert.deepEqual(calls()[0]!.env, { CLAUDE_CODE_OAUTH_TOKEN: "bob-token", BOB_TOKEN: "bob-token" });
    const bare = harnessSandbox("claude", () => recorded("claude-code")).sandbox;
    const { text } = await codeTask(context(bare, { secrets: {}, secret_aliases: aliases }).ctx, { brief: "x" });
    assert.match(text, /grant the secret BOB_TOKEN \(read as CLAUDE_CODE_OAUTH_TOKEN\) to the agent/);
  });

  test("a check that finds no credential forgets the login; one that finds a login records it", async () => {
    const { sandbox } = harnessSandbox("claude", () => recorded("claude-code"));
    const events: string[] = [];
    const overrides = {
      secrets: {},
      db: fakeToolboxDatabase({
        markHarnessLogin: async (_agentId, harness, _now, account) =>
          void events.push(`seen ${harness} as ${account ?? "unknown"}`),
        clearHarnessLogin: async (_agentId, harness) => void events.push(`lost ${harness}`),
      }),
    };
    await assert.rejects(() => assertHarnessReady(context(sandbox, overrides).ctx), (error: unknown) => {
      assert.ok(error instanceof HarnessSetupError);
      assert.equal(error.code, "harness.credential");
      return true;
    });
    mkdirSync(path.join(sandbox.home, ".claude"), { recursive: true });
    writeFileSync(path.join(sandbox.home, ".claude", ".credentials.json"), "{}");
    await assertHarnessReady(context(sandbox, overrides).ctx);
    writeFileSync(path.join(sandbox.home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "ada@example.com" } }));
    await assertHarnessReady(context(sandbox, overrides).ctx);
    assert.deepEqual(events, ["lost claude-code", "seen claude-code as unknown", "seen claude-code as ada@example.com"]);
  });

  test("with no harness picked, the readiness check and code_task both name the agent's Settings", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"));
    await assert.rejects(() => assertHarnessReady(context(sandbox, { harness: null }).ctx), (error: unknown) => {
      assert.ok(error instanceof HarnessSetupError);
      assert.equal(error.code, "harness.missing");
      assert.match(error.message, /no harness is picked: choose Claude Code, Codex, Cursor, or Antigravity in the agent's Settings/);
      return true;
    });
    const { text } = await codeTask(context(sandbox, { harness: null }).ctx, { brief: "x" });
    assert.match(text, /no harness is picked/);
    assert.equal(calls().length, 0);
  });

  test("checkHarnessOn reports the CLI, its version, and what it would run on", async () => {
    const { sandbox } = harnessSandbox("claude", () => [], { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    assert.deepEqual(await checkHarnessOn(context(sandbox).ctx, "claude-code"), {
      installed: true,
      version: "9.9.9 (stub)",
      credential: "secret",
      account: null,
    });
    const bare = new HostCodeSandbox("a_1", { PATH: tempDir("harness-empty-bin-") + ":/usr/bin:/bin" });
    assert.deepEqual(await checkHarnessOn(context(bare).ctx, "claude-code"), {
      installed: false,
      version: null,
      credential: null,
      account: null,
    });
  });

  test("a CLI missing from the image fails with that reason", async () => {
    const sandbox = new HostCodeSandbox("a_1", { PATH: tempDir("harness-empty-bin-") + ":/usr/bin:/bin" });
    mkdirSync(path.join(sandbox.home, "repos", "app"), { recursive: true });
    const { text } = await codeTask(context(sandbox).ctx, { brief: "Anything." });
    assert.match(text, /^ERROR: Claude Code is not installed in this machine's image/);
  });

  test("an unknown repository is an error naming the guild's repositories", async () => {
    const { sandbox } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    const { ctx } = context(sandbox, { code_repositories: ["app", "site"] });
    assert.match((await codeTask(ctx, { brief: "x", repo: "api" })).text, /unknown repository api; the guild's repositories are app, site/);
    assert.match((await codeTask(ctx, { brief: "x" })).text, /repo is required: the guild's repositories are app, site/);
  });

  test("output the driver does not parse fails with that reason", async () => {
    const { sandbox } = harnessSandbox("claude", () => ["Welcome to the new output format", "done"], {
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    const { text, metadata } = await codeTask(context(sandbox).ctx, { brief: "Anything." });
    assert.equal(metadata.status, "failed");
    assert.match(text, /^failed · claude-code · app · session none/);
    assert.match(text, /error: the claude-code driver does not parse this CLI's output \(9\.9\.9 \(stub\)\)/);
  });

  test("past its timeout the harness is stopped and the call ends timed_out with its session", async () => {
    harnessTiming.minuteMs = 600;
    try {
      const lines = recorded("claude-code").slice(0, 2);
      const { sandbox } = harnessSandbox("claude", () => [...lines, JSON.stringify({ stub: "hang" })], {
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      });
      const { text, metadata } = await codeTask(context(sandbox).ctx, { brief: "Anything.", timeout_minutes: 1 });
      assert.equal(metadata.status, "timed_out");
      assert.equal(metadata.session_id, SESSION);
      assert.match(text, /Stopped after 1 minutes\. Resume the session to continue\./);
      assert.equal(stubsRunning(sandbox), false);
    } finally {
      harnessTiming.minuteMs = timing.minuteMs;
    }
  });

  test("cancelling the generation stops the harness and the call ends cancelled", async () => {
    const lines = recorded("claude-code").slice(0, 2);
    const { sandbox } = harnessSandbox("claude", () => [...lines, JSON.stringify({ stub: "hang" })], {
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    const cancel = new CancelEvent();
    const { ctx, progress } = context(sandbox, { cancel_event: cancel });
    const running = codeTask(ctx, { brief: "Anything." });
    while (!progress.length) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    cancel.set();
    const { text, metadata } = await running;
    assert.equal(metadata.status, "cancelled");
    assert.match(text, /^cancelled · claude-code · app · session /);
    assert.equal(stubsRunning(sandbox), false);
  });

  test("a machine restart loses the harness: the next poll finds no state and the call ends interrupted", async () => {
    const lines = recorded("claude-code").slice(0, 2);
    const { sandbox } = harnessSandbox("claude", () => [...lines, JSON.stringify({ stub: "hang" })], {
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    let lost = false;
    const { ctx } = context(sandbox, {
      events: fakeToolEvents(() => {
        if (!lost) {
          lost = true;
          restartMachine(sandbox);
        }
      }),
    });
    const { text, metadata } = await codeTask(ctx, { brief: "Anything." });
    assert.equal(metadata.status, "interrupted");
    assert.equal(metadata.session_id, SESSION);
    assert.match(text, /^interrupted · claude-code · app · session 0f9c/);
  });
});

describe("code_task with the Codex driver", () => {
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
    const { ctx, progress } = context(sandbox, {
      harness: "codex",
      secrets: {},
      db: fakeToolboxDatabase({
        markHarnessLogin: async (_agentId, harness) => {
          seen.push(harness);
        },
      }),
    });
    const { text, metadata } = await codeTask(ctx, { brief: "Make the greeting name the guild." });
    assert.match(text, new RegExp(`^completed · codex · app · session ${THREAD} · `));
    assert.ok(text.includes("1 file changed, +1 −1\ngreet.py (+1 −1)"));
    assert.ok(text.includes("Should the greeting also name the agent?"));
    assert.equal(metadata.session_id, THREAD);
    assert.deepEqual(seen, ["codex"]);
    assert.ok(progress.includes("shell: bash -lc 'cat greet.py'"), progress.join("\n"));
    assert.ok(progress.includes("update: /home/a_1/repos/app/greet.py"));
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

  test("a session resumes with exec resume and the brief on stdin", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    await codeTask(context(sandbox, { harness: "codex", secrets: {} }).ctx, { brief: "Yes.", session_id: THREAD });
    const argv = calls()[0]!.argv;
    assert.deepEqual(argv.slice(1, 3), ["exec", "resume"]);
    assert.deepEqual(argv.slice(-2), [THREAD, "-"]);
  });

  test("the agent's harness model is passed with --model, on a resume too", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    const ctx = context(sandbox, { harness: "codex", secrets: {}, harness_model: "gpt-5-codex" }).ctx;
    await codeTask(ctx, { brief: "Yes.", session_id: THREAD });
    assert.deepEqual(calls()[0]!.argv.slice(-4), ["--model", "gpt-5-codex", THREAD, "-"]);
  });

  test("the agent's harness effort is passed as model_reasoning_effort, before the thread id", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    const ctx = context(sandbox, { harness: "codex", secrets: {}, harness_model: "gpt-6-luna", harness_effort: "high" }).ctx;
    await codeTask(ctx, { brief: "Yes.", session_id: THREAD });
    assert.deepEqual(calls()[0]!.argv.slice(-6), ["--model", "gpt-6-luna", "-c", 'model_reasoning_effort="high"', THREAD, "-"]);
  });

  test("a check reads whose the ChatGPT login is from its id token, without checking its signature", async () => {
    const { sandbox } = harnessSandbox("codex", () => recorded("codex"));
    const claims = Buffer.from(JSON.stringify({ email: "bob@example.com" }), "utf8").toString("base64url");
    chatgptLogin(sandbox, { tokens: { id_token: `eyJhbGciOiJub25lIn0.${claims}.sig`, refresh_token: "refresh" } });
    const check = await checkHarnessOn(context(sandbox, { harness: "codex", secrets: {} }).ctx, "codex");
    assert.deepEqual(check, { installed: true, version: "9.9.9 (stub)", credential: "login", account: "bob@example.com" });
    chatgptLogin(sandbox, { tokens: { id_token: "not-a-jwt", refresh_token: "refresh" } });
    assert.equal((await checkHarnessOn(context(sandbox, { harness: "codex", secrets: {} }).ctx, "codex")).account, null);
  });

  test("an API key login is not a subscription: the call names the login to run", async () => {
    const { sandbox, calls } = harnessSandbox("codex", () => recorded("codex"));
    chatgptLogin(sandbox, { OPENAI_API_KEY: "sk-metered", tokens: null });
    const { text } = await codeTask(context(sandbox, { harness: "codex", secrets: {} }).ctx, { brief: "x" });
    assert.match(text, /^ERROR: Codex has no credential: log in from the agent's CLI tab with `codex login --device-auth`/);
    assert.equal(calls().length, 0);
  });

  test("a failed turn fails with the harness's error", async () => {
    const { sandbox } = harnessSandbox("codex", () => recorded("codex-failed"));
    chatgptLogin(sandbox, { tokens: { refresh_token: "refresh" } });
    const { text, metadata } = await codeTask(context(sandbox, { harness: "codex", secrets: {} }).ctx, { brief: "x" });
    assert.equal(metadata.status, "failed");
    assert.match(text, /^failed · codex · app · session 01a13707-cdbf/);
    assert.match(text, /\nerror: unexpected status 401 Unauthorized/);
  });
});

describe("code_task with the Cursor driver", () => {
  const CHAT = "6d1c0f3e-9b2a-4e57-8c41-2a7f5e9d0b13";

  test("a turn reads its prompt from a file named on its command line and returns the last message", async () => {
    const { sandbox, repo, calls } = harnessSandbox(
      "agent",
      (root) => recorded("cursor", [{ at: 5, path: path.join(root, "greet.py"), text: "print('hello, guild')\n" }]),
      { CURSOR_API_KEY: "cursor-key" },
    );
    const { ctx, progress } = context(sandbox, { harness: "cursor", secrets: { CURSOR_API_KEY: "cursor-key" } });
    const { text, metadata } = await codeTask(ctx, { brief: "Make the greeting name the guild." });
    assert.match(text, new RegExp(`^completed · cursor · app · session ${CHAT} · `));
    assert.ok(text.includes("\n\nChanged the greeting in greet.py"), "the last assistant message, not the joined result");
    assert.ok(!text.includes("I'll update the greeting.Changed"));
    assert.equal(metadata.files_changed, 1);
    assert.ok(progress.includes("Write: /home/a_1/repos/app/greet.py"), progress.join("\n"));
    assert.ok(progress.includes("Shell: python3 greet.py"));
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
    await codeTask(context(sandbox, { harness: "cursor", secrets: { CURSOR_API_KEY: "cursor-key" } }).ctx, {
      brief: "Yes.",
      session_id: CHAT,
    });
    assert.ok(calls()[0]!.argv.includes(`--resume=${CHAT}`));
  });

  test("the agent's harness model is passed with --model, before the prompt", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { CURSOR_API_KEY: "cursor-key" });
    const secrets = { CURSOR_API_KEY: "cursor-key" };
    await codeTask(context(sandbox, { harness: "cursor", secrets, harness_model: "sonnet-4-thinking" }).ctx, { brief: "x" });
    const argv = calls()[0]!.argv;
    assert.deepEqual(argv.slice(-3, -1), ["--model", "sonnet-4-thinking"]);
    assert.match(argv.at(-1)!, /^Read your task in /);
  });

  test("a listed model starts under Cursor's name for the agent's effort, with no effort apart", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { CURSOR_API_KEY: "cursor-key" });
    const secrets = { CURSOR_API_KEY: "cursor-key" };
    const harness = { harness: "cursor" as const, secrets, harness_model: "claude-opus-5-5" };
    await codeTask(context(sandbox, { ...harness, harness_effort: "max" }).ctx, { brief: "x" });
    await codeTask(context(sandbox, harness).ctx, { brief: "x" }, "call_default");
    const [picked, plain] = calls();
    assert.deepEqual(picked!.argv.slice(-3, -1), ["--model", "claude-opus-5-5-max"]);
    assert.deepEqual(plain!.argv.slice(-3, -1), ["--model", "claude-opus-5-5-medium"]);
    assert.ok(!picked!.argv.includes("--effort"));
  });

  test("the helper refuses an effort apart from Cursor's model name, and never starts the harness", async () => {
    const { sandbox, calls } = harnessSandbox("agent", () => recorded("cursor"), { CURSOR_API_KEY: "cursor-key" });
    const ctx = createToolContext({ run_id: "r_harness", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    ctx.tool_call_id = "call_effort";
    const start = { harness: "cursor", repository: "app", prompt: "x", model: "grok-4.7-high", effort: "high" };
    await assert.rejects(runCodeHelper(ctx, "start", start, { helper: HARNESS_HELPER }), /cursor takes its effort in the model name/);
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
    const { text, metadata } = await codeTask(context(sandbox, { harness: "cursor", secrets: { CURSOR_API_KEY: "expired" } }).ctx, {
      brief: "x",
    });
    assert.equal(metadata.status, "failed");
    assert.match(text, /\nerror: Error: Authentication required\. Please run 'agent login' first\./);
  });

  test("a login in the home is a credential", async () => {
    const { sandbox } = harnessSandbox("agent", () => recorded("cursor"));
    mkdirSync(path.join(sandbox.home, ".config", "cursor"), { recursive: true });
    writeFileSync(path.join(sandbox.home, ".config", "cursor", "auth.json"), "{}");
    const { metadata } = await codeTask(context(sandbox, { harness: "cursor", secrets: {} }).ctx, { brief: "x" });
    assert.equal(metadata.status, "completed");
  });
});

test("each call first removes the harness's local configuration and memory, never its login or sessions", async () => {
  const cases: Array<{ harness: "claude-code" | "codex" | "cursor"; binary: string; removed: string[]; kept: string[] }> = [
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
      removed: [".cursor/hooks.json", ".cursor/mcp.json", ".cursor/rules/r.mdc"],
      kept: [".config/cursor/auth.json", ".cursor/cli-config.json", ".cursor/chats/c/store.db"],
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
    const secrets: Record<string, string> = harness === "codex" ? {} : { [harness === "cursor" ? "CURSOR_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"]: "t" };
    const { metadata } = await codeTask(context(sandbox, { harness, secrets }).ctx, { brief: "x" });
    assert.equal(metadata.status, "completed", harness);
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
  const ctx = createToolContext({ run_id: "r_detached", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
  ctx.tool_call_id = "call_detached";
  const op = (name: string, args: Record<string, unknown> = {}) =>
    runCodeHelper(ctx, name, { harness: "claude-code", ...args }, { helper: HARNESS_HELPER });
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

test("the result keeps the end of a long final message within the cap", () => {
  const outcome: CodeTaskOutcome = {
    status: "completed",
    harness: "codex",
    repository: "app",
    session_id: "s_1",
    duration_ms: 252_000,
    files_changed: 33,
    insertions: 40,
    deletions: 2,
    files: Array.from({ length: 33 }, (_, index) => ({ path: `f${index}.ts`, insertions: 1, deletions: 0 })),
    detail: "",
    message: `${"start ".repeat(4000)}Which name should the flag take?`,
    log_path: ".runs/r/c.harness.jsonl",
  };
  const text = codeTaskText(outcome, 4096);
  assert.ok(Buffer.byteLength(text, "utf8") <= 4096);
  assert.match(text, /^completed · codex · app · session s_1 · 4m12s\n33 files changed, \+40 −2\nf0\.ts \(\+1 −0\)/);
  assert.ok(text.includes("f29.ts (+1 −0)\n… 3 more files"));
  assert.ok(!text.includes("f30.ts"));
  assert.match(text, /\[… \d+ bytes cut from the start of the message\]/);
  assert.ok(text.includes("Which name should the flag take?\n\nlog: .runs/r/c.harness.jsonl"));
  assert.equal(formatDuration(3_725_000), "1h02m");
  assert.equal(formatDuration(9_000), "9s");
});

/** A Claude Code sandbox whose CLI reports its session, then hangs with `hang` until it is stopped. */
function hangingSandbox(hang: Record<string, unknown> = { stub: "hang" }) {
  const lines = recorded("claude-code").slice(0, 2);
  return harnessSandbox("claude", () => [...lines, JSON.stringify(hang)], { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
}

/** The files a call left in the agent's harness state folder and its prompt file, if any. */
function leftBehind(sandbox: HostCodeSandbox): string[] {
  const state = path.join(sandbox.runDir, "a_1", "harness");
  const files = existsSync(state) ? readdirSync(state).filter((name) => !name.startsWith(".")) : [];
  const prompt = path.join(sandbox.home, ".runs", "r_harness", "call_task.prompt.md");
  return existsSync(prompt) ? [...files, "call_task.prompt.md"] : files;
}

async function untilProgress(progress: string[]): Promise<void> {
  while (!progress.length) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("code_task ends every harness it started", () => {
  test("a throw after start stops the harness and clears its state", async () => {
    const { sandbox } = hangingSandbox();
    const { ctx } = context(sandbox, {
      db: fakeToolboxDatabase({
        mergeRunMetadata: async () => {
          throw new Error("the database is down");
        },
      }),
    });
    const { text } = await codeTask(ctx, { brief: "Anything." });
    assert.match(text, /^ERROR: the database is down/);
    assert.equal(stubsRunning(sandbox), false);
    assert.deepEqual(leftBehind(sandbox), []);
  });

  test("three failed polls stop the harness and end the call interrupted without blaming a restart", async () => {
    const { sandbox } = hangingSandbox();
    let commands = 0;
    const { ctx } = context(sandbox, {
      before_command: async () => {
        commands += 1;
        if (commands > 1) {
          throw new Error("the GitHub token could not be refreshed");
        }
      },
    });
    const { text, metadata } = await codeTask(ctx, { brief: "Anything." });
    assert.equal(metadata.status, "interrupted");
    assert.equal(metadata.session_id, SESSION, "read from the result once the harness stopped");
    assert.ok(text.includes("The harness stopped answering, so it was stopped."), text);
    assert.doesNotMatch(text, /restarted/);
    assert.equal(stubsRunning(sandbox), false);
    assert.deepEqual(leftBehind(sandbox), []);
  });

  test("a stop that does not end the harness says so, names its log, and reads no result", async () => {
    const { sandbox } = hangingSandbox();
    const answered = answerOps(sandbox, { stop: { missing: false, exited: false } });
    const cancel = new CancelEvent();
    const { ctx, progress } = context(sandbox, { cancel_event: cancel });
    const running = codeTask(ctx, { brief: "Anything." });
    await untilProgress(progress);
    cancel.set();
    const { text, metadata } = await running;
    stopStubs(sandbox);
    assert.equal(metadata.status, "cancelled");
    assert.ok(
      text.includes("The harness did not stop and may still be running; its log is .runs/r_harness/call_task.harness.jsonl."),
      text,
    );
    assert.deepEqual(
      answered.map((request) => request.op),
      ["stop"],
    );
  });

  test("a run cancelled before the harness starts never starts it", async () => {
    const { sandbox, calls } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    const cancel = new CancelEvent();
    cancel.set();
    const { text, metadata } = await codeTask(context(sandbox, { cancel_event: cancel }).ctx, { brief: "Anything." });
    assert.equal(metadata.status, "cancelled");
    assert.ok(text.includes("The generation was cancelled before the harness started."));
    assert.equal(calls().length, 0);
  });

  test("a harness that exits but whose result cannot be read ends interrupted", async () => {
    const { sandbox } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    answerOps(sandbox, { result: { missing: true } });
    const { text, metadata } = await codeTask(context(sandbox).ctx, { brief: "Anything." });
    assert.equal(metadata.status, "interrupted");
    assert.ok(text.includes("The harness exited, and its result could not be read."));
  });

  test("a cancelled call whose result is gone stays cancelled, with no final message", async () => {
    const { sandbox } = hangingSandbox();
    answerOps(sandbox, { result: { missing: true } });
    const cancel = new CancelEvent();
    const { ctx, progress } = context(sandbox, { cancel_event: cancel });
    const running = codeTask(ctx, { brief: "Anything." });
    await untilProgress(progress);
    cancel.set();
    const { text, metadata } = await running;
    assert.equal(metadata.status, "cancelled");
    assert.ok(text.includes("Stopped: the generation was cancelled.\n\n(no final message)"), text);
    assert.equal(stubsRunning(sandbox), false);
  });

  test("a failed checkpoint is logged and the call goes on without checkpoint shas", async () => {
    const { sandbox, repo } = harnessSandbox("claude", () => recorded("claude-code"), { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    const { text, metadata } = await codeTask(context(sandbox).ctx, { brief: "Anything." });
    assert.equal(metadata.status, "completed");
    assert.equal(metadata.start_sha, null);
    assert.equal(metadata.end_sha, null);
    assert.ok(text.includes("\nno files changed\n"));
  });
});

describe("code_task arguments", () => {
  test("a brief that is empty or missing is an error", async () => {
    const { ctx } = context(new HostCodeSandbox());
    assert.match((await codeTask(ctx, { brief: "   " })).text, /^ERROR: brief is required/);
    assert.match((await codeTask(ctx, {})).text, /^ERROR: brief is required/);
  });

  test("a guild without repositories is an error naming where the operator adds them", async () => {
    const { ctx } = context(new HostCodeSandbox(), { code_repositories: [] });
    assert.match((await codeTask(ctx, { brief: "x" })).text, /^ERROR: this guild has no repositories; the operator adds them/);
  });

  test("notes are a list of display paths, trimmed and without repeats", async () => {
    assert.deepEqual(notePaths({}), []);
    assert.deepEqual(notePaths({ notes: null }), []);
    assert.deepEqual(notePaths({ notes: [" a.md", "a.md", "", "b.md"] }), ["a.md", "b.md"]);
    assert.throws(() => notePaths({ notes: "a.md" }), /notes must be a list of display paths/);
    assert.throws(() => notePaths({ notes: ["a.md", 1] }), /notes must be a list of display paths/);
    const { ctx } = context(new HostCodeSandbox());
    assert.match((await codeTask(ctx, { brief: "x", notes: [1] })).text, /^ERROR: notes must be a list of display paths/);
  });

  test("timeout_minutes defaults to 30 and is kept between 1 and 60 whole minutes", () => {
    assert.equal(timeoutMinutes({}), 30);
    assert.equal(timeoutMinutes({ timeout_minutes: "5" }), 30);
    assert.equal(timeoutMinutes({ timeout_minutes: Number.NaN }), 30);
    assert.equal(timeoutMinutes({ timeout_minutes: 90 }), 60);
    assert.equal(timeoutMinutes({ timeout_minutes: 0 }), 1);
    assert.equal(timeoutMinutes({ timeout_minutes: 2.7 }), 2);
  });
});

describe("a kept harness log", () => {
  function keptLog(lines: string[]) {
    const sandbox = new HostCodeSandbox("a_1");
    const folder = path.join(sandbox.home, ".runs", "r_log");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "call_log.harness.jsonl"), lines.join("\n") + "\n");
    const ctx = createToolContext({ run_id: "r_log", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    return ctx;
  }

  test("reads as its progress lines and its raw JSONL, both redacted", async () => {
    const events = [...recorded("claude-code"), JSON.stringify({ type: "note", text: `token ${TOKEN}` }), "not json"];
    const ctx = keptLog(events);
    const log = await readHarnessLog(ctx, "claude-code", "call_log", { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    assert.ok(log);
    assert.ok(log.lines.includes("Bash: python3 greet.py"), log.lines.join("\n"));
    assert.equal(log.lines_truncated, false);
    assert.equal(log.raw_truncated, false);
    assert.equal(log.events, events.length - 1);
    assert.equal(log.unparsed, 1);
    assert.ok(log.raw.includes(SESSION));
    assert.ok(!log.raw.includes(TOKEN), "the raw log is redacted");
    assert.ok(log.bytes > 0);
  });

  test("keeps whole lines from the start of a raw log past its cap", async () => {
    const line = JSON.stringify({ type: "assistant", text: "x".repeat(1000) });
    const ctx = keptLog(Array.from({ length: Math.ceil(HARNESS_LOG_MAX_BYTES / line.length) + 10 }, () => line));
    const log = await readHarnessLog(ctx, "claude-code", "call_log", {});
    assert.ok(log);
    assert.equal(log.raw_truncated, true);
    assert.ok(Buffer.byteLength(log.raw) <= HARNESS_LOG_MAX_BYTES);
    assert.ok(log.raw.endsWith(`${line}\n`), "the cut falls between lines");
  });

  test("is null once the agent's home no longer keeps it", async () => {
    const ctx = keptLog([]);
    assert.equal(await readHarnessLog(ctx, "claude-code", "call_gone", {}), null);
  });
});

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
  const ctx = createToolContext({ run_id: "r_term", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
  ctx.tool_call_id = "call_term";
  const op = (name: string, args: Record<string, unknown> = {}) =>
    runCodeHelper(ctx, name, { harness: "claude-code", ...args }, { helper: HARNESS_HELPER });
  await op("start", { repository: "app", prompt: "Anything." });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const began = Date.now();
  const stopped = await op("stop");
  assert.equal(stopped.meta.exited, true);
  assert.ok(Date.now() - began >= 9_000, "SIGTERM alone did not end it");
  assert.equal(stubsRunning(sandbox), false);
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

function stopStubs(sandbox: HostCodeSandbox): void {
  for (const pid of stubPids(sandbox)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * What a machine restart does to a call: every process ends and the harness state is gone. The
 * supervisors go first, so none writes a CLI's exit into the folder while it is removed.
 */
function restartMachine(sandbox: HostCodeSandbox): void {
  const state = path.join(sandbox.runDir, "a_1", "harness");
  for (const name of existsSync(state) ? readdirSync(state) : []) {
    if (!name.endsWith(".json") || name.startsWith(".")) {
      continue;
    }
    const supervisor = (JSON.parse(readFileSync(path.join(state, name), "utf8")) as { supervisor_pid?: unknown })
      .supervisor_pid;
    if (typeof supervisor === "number") {
      try {
        process.kill(supervisor, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  stopStubs(sandbox);
  rmSync(state, { recursive: true, force: true });
}
