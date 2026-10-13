import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import { CancelEvent, type ToolContext } from "../../src/toolbox/types.js";
import { HARNESS_HELPER, runCodeHelper } from "../../src/toolbox/code.js";
import {
  BRIEF_PREAMBLE,
  buildBrief,
  codeTaskText,
  formatDuration,
  harnessTiming,
  type CodeTaskOutcome,
} from "../../src/toolbox/harness.js";
import { HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";

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
    HARNESS_STUB_SHOW: "IS_SANDBOX,ANTHROPIC_API_KEY,GH_TOKEN,GUILD_RUN_ID,CLAUDE_CODE_OAUTH_TOKEN",
    HARNESS_STUB_DELAY: "0.02",
    ANTHROPIC_API_KEY: "metered-api-key",
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
    publish_progress: async (_id, update) => {
      progress.push(...update.lines);
    },
    remember_harness_task: async (task) => {
      remembered.push(task);
    },
    ...overrides,
  });
  return { ctx, progress, remembered };
}

async function codeTask(ctx: ToolContext, args: Record<string, unknown>, callId = "call_task") {
  const [payload, metadata] = await invokeTool(
    ctx,
    { id: callId, function: { name: "code_task", arguments: JSON.stringify(args) } },
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
    assert.deepEqual(call.argv.slice(1, 11), [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks": true, "enableAllProjectMcpServers": false}',
    ]);
    assert.ok(!call.argv.includes("--resume"));
    assert.equal(realpathSync(call.cwd), realpathSync(repo));
    assert.ok(call.stdin.startsWith(BRIEF_PREAMBLE), "the prompt reaches the CLI on stdin");
    assert.ok(call.stdin.includes("Make the greeting name the guild."));
    assert.ok(!call.argv.some((arg) => arg.includes("Make the greeting")), "never on its command line");
    assert.equal(call.env.IS_SANDBOX, "1");
    assert.equal(call.env.ANTHROPIC_API_KEY, null, "a metered key never reaches the harness");
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

  test("notes are appended to the brief under their display paths", async () => {
    const notes: Record<string, string> = {
      "org/org_1/guilds/guild_1/conventions.md": "Use tabs.",
      "org/org_1/guilds/guild_1/large.md": "x".repeat(70 * 1024),
    };
    const fakeStore = {
      async getByDisplayPath(_actor: unknown, displayPath: string) {
        if (!(displayPath in notes)) {
          throw new Error("artifact not found");
        }
        return { row: { kind: "note", path: displayPath } };
      },
      view(row: { path: string }) {
        return { display_path: row.path, content: notes[row.path] };
      },
    };
    const { ctx } = context(new HostCodeSandbox(), {
      artifacts: fakeStore as unknown as ToolContext["artifacts"],
      artifact_actor: {} as ToolContext["artifact_actor"],
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
    const { text: noCli } = await codeTask(context(sandbox, { secrets: {}, cli: false }).ctx, { brief: "Anything." });
    assert.ok(!noCli.includes("/login"), "no login is offered without a CLI tab");
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
      publish_progress: async () => {
        if (!lost) {
          lost = true;
          stopStubs(sandbox);
          rmSync(path.join(sandbox.runDir, "a_1", "harness"), { recursive: true, force: true });
        }
      },
    });
    const { text, metadata } = await codeTask(ctx, { brief: "Anything." });
    assert.equal(metadata.status, "interrupted");
    assert.equal(metadata.session_id, SESSION);
    assert.match(text, /^interrupted · claude-code · app · session 0f9c/);
  });
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
  assert.equal(result.meta.stopped, true);
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
