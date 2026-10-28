import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { validateConfig, withCodingLimits } from "../../src/agents/validation.js";
import { agentWorkspaceMaxMib } from "../../src/generation/workspace.js";
import { generationLive } from "../../src/generation/completion.js";
import { configSnapshot } from "../../src/generation/snapshot.js";
import { offeredToolNames } from "../../src/toolbox/offered.js";
import type { Completion } from "../../src/llm/index.js";
import { createToolContext, invokeTool } from "../../src/toolbox/index.js";
import {
  callSegment,
  CODING_TOOLS,
  INLINE_REQUEST_MAX,
  repeatedReadStep,
  repeatedReadText,
} from "../../src/toolbox/code.js";
import { REGISTRY } from "../../src/toolbox/index.js";
import type { MachineSpec } from "../../src/sandbox/index.js";
import { answerOps, HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";
import type { AgentConfig, RunConfigSnapshot } from "../../src/db/schema/index.js";
import { AGENT_CONFIG, FakeDB, FakeSandboxes, liveSecret, makeLoop } from "../helpers/generation.js";

const live = generationLive;
/** A coding agent's config: coding on, with a harness. */
const CODER: AgentConfig = { ...AGENT_CONFIG, coding: true, harness: "claude-code" };
const originalStream = live.streamCompletion;
/** What `guilds-harness check` answers for Claude Code installed and running on a granted token. */
const HARNESS_READY = { installed: true, version: "9.9.9 (stub)", credential: "secret" };

type RepoDB = FakeDB & { listGuildRepositories(guildId: string): Promise<Array<Record<string, unknown>>> };

/** A FakeDB whose guild has the repositories named, each at `url`. */
function withRepositories<T extends FakeDB>(db: T, names: string[], url = "file:///nowhere.git"): T & RepoDB {
  const repos = db as T & RepoDB;
  repos.listGuildRepositories = async () =>
    names.map((name, index) => ({
      id: `repo_${index + 1}`,
      guild_id: "guild_1",
      name,
      url,
      default_branch: "main",
      connection_id: null,
    }));
  return repos;
}

/**
 * A sandbox on this machine whose harness check finds Claude Code ready and, unless `clones`,
 * whose repository setup and checkpoints answer without cloning.
 */
function readySandbox(options: { clones?: boolean } = {}): HostCodeSandbox {
  const sandbox = new HostCodeSandbox();
  const skipped = options.clones ? {} : { git_setup: { failed: [] }, checkpoint: { repositories: [] } };
  answerOps(sandbox, { check: HARNESS_READY, ...skipped });
  return sandbox;
}

function ctxFor(sandbox: HostCodeSandbox, runId = "r_code") {
  return createToolContext({
    run_id: runId,
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox,
    secrets: { TOKEN: "s3cr3t-value" },
  });
}

let callCount = 0;

async function call(
  sandbox: HostCodeSandbox,
  name: string,
  args: Record<string, unknown>,
  runId = "r_code",
): Promise<[string, Record<string, unknown>]> {
  callCount += 1;
  const [payload, metadata] = await invokeTool(
    ctxFor(sandbox, runId),
    { id: `call_${callCount}`, function: { name, arguments: JSON.stringify(args) } },
    { TOKEN: "s3cr3t-value" },
    32768,
  );
  return [String(payload.content), metadata];
}

describe("code tools against the helper", () => {
  test("shell keeps the working directory and reports a failing exit code", async () => {
    const sandbox = new HostCodeSandbox();
    const [first, firstMeta] = await call(sandbox, "shell", { command: "mkdir -p app && cd app && echo ready" });
    assert.equal(first, "ready");
    assert.equal(firstMeta.exit_code, 0);
    const [second, secondMeta] = await call(sandbox, "shell", { command: "basename \"$PWD\"; exit 3" });
    assert.equal(second, "app\nexit_code: 3");
    assert.equal(secondMeta.exit_code, 3);
    assert.equal(secondMeta.tool_name, "shell");
  });

  test("shell environment changes do not persist, and a secret in output is redacted", async () => {
    const sandbox = new HostCodeSandbox();
    await call(sandbox, "shell", { command: "export FOO=bar" });
    const [text] = await call(sandbox, "shell", { command: "echo \"[${FOO:-unset}] s3cr3t-value\"" });
    assert.equal(text, "[unset] [REDACTED:TOKEN]");
  });

  test("long shell output keeps its start and end and names the full log", async () => {
    const sandbox = new HostCodeSandbox();
    const [text, meta] = await call(sandbox, "shell", {
      command: "echo FIRST; for i in $(seq 1 4000); do echo line $i; done; echo LAST",
    });
    assert.ok(Buffer.byteLength(text, "utf8") <= 8192);
    assert.ok(text.startsWith("FIRST\n"));
    assert.ok(text.endsWith("LAST"));
    assert.match(text, /bytes elided; full output: .*\.runs\/r_code\/call_\d+\.log/);
    const log = String(meta.log_path);
    assert.ok(existsSync(log));
    assert.match(readFileSync(log, "utf8"), /line 2000\n/);
  });

  test("a shell timeout stops the command and says so", async () => {
    const sandbox = new HostCodeSandbox();
    const [text, meta] = await call(sandbox, "shell", { command: "echo start; sleep 20", timeout_seconds: 1 });
    assert.match(text, /^start\n\[timed out after 1s; the command was stopped\]\nexit_code: 124$/);
    assert.equal(meta.timed_out, true);
  });

  test("a background command is listed, followed, and stopped", async () => {
    const sandbox = new HostCodeSandbox();
    const [started, meta] = await call(sandbox, "shell", {
      command: "echo serving; sleep 30",
      background: true,
    });
    assert.match(started, /^started b1 in the background/);
    assert.equal(meta.background_id, "b1");
    const [list] = await call(sandbox, "shell_status", {});
    assert.match(list, /^b1 {2}running /);
    const [stopped, stoppedMeta] = await call(sandbox, "shell_status", { id: "b1", stop: true });
    assert.match(stopped, /^b1 {2}stopped /);
    assert.match(stopped, /serving/);
    assert.equal(stoppedMeta.state, "stopped");
    const [missing] = await call(sandbox, "shell_status", { id: "b9" });
    assert.equal(missing.split("\n\n")[0], "ERROR: no background command b9");
  });

  test("file_read reads a range under a header", async () => {
    const sandbox = new HostCodeSandbox();
    mkdirSync(path.join(sandbox.home, "src"));
    writeFileSync(path.join(sandbox.home, "src/app.py"), "def f():\n    return 1\n\nprint(f())\n");
    const [read, readMeta] = await call(sandbox, "file_read", { path: "src/app.py", offset: 2, limit: 2 });
    assert.equal(read, "src/app.py · lines 2–3 of 4\n2      return 1\n3  ");
    assert.deepEqual(readMeta.range, [2, 3]);
    assert.equal(typeof readMeta.content_hash, "string");
    assert.equal(readMeta.path, path.join(realHome(sandbox), "src/app.py"));
  });

  test("file_read refuses paths outside the workspace, links included", async () => {
    const sandbox = new HostCodeSandbox();
    const outside = tempDir("guilds-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "no");
    symlinkSync(outside, path.join(sandbox.home, "escape"));
    const [read] = await call(sandbox, "file_read", { path: "escape/secret.txt" });
    assert.match(read, /^ERROR: escape\/secret\.txt is outside /);
    const [absolute] = await call(sandbox, "file_read", { path: "/etc/hosts" });
    assert.match(absolute, /^ERROR: \/etc\/hosts is outside /);
  });

  test("file_read clips long lines, stops under the byte cap, and names binary files", async () => {
    const sandbox = new HostCodeSandbox();
    writeFileSync(path.join(sandbox.home, "wide.txt"), `${"x".repeat(1000)}\nshort\n`);
    const [wide] = await call(sandbox, "file_read", { path: "wide.txt" });
    assert.match(wide, /^wide\.txt · lines 1–2 of 2\n1 {2}x{400}… \[\+600 chars\]\n2 {2}short$/);
    const many = Array.from({ length: 400 }, (_, index) => `row ${index + 1} ${"y".repeat(60)}`).join("\n");
    writeFileSync(path.join(sandbox.home, "many.txt"), many);
    const [capped, cappedMeta] = await call(sandbox, "file_read", { path: "many.txt", limit: 400 });
    const range = cappedMeta.range as [number, number];
    assert.equal(range[0], 1);
    assert.ok(range[1] < 400);
    assert.match(capped, new RegExp(`continue with offset ${range[1] + 1}\\]`));
    writeFileSync(path.join(sandbox.home, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const [binary] = await call(sandbox, "file_read", { path: "blob.bin" });
    assert.equal(binary.split("\n\n")[0], "blob.bin · binary file, 4 bytes; not shown");
  });

  test("a request too large for one argument travels through the sandbox file API", async () => {
    const sandbox = new HostCodeSandbox();
    const command = `printf ok # ${"z".repeat(120 * 1024)}`;
    const [ran] = await call(sandbox, "shell", { command });
    assert.equal(ran, "ok");
    assert.equal(sandbox.written.length, 1);
    assert.match(String(sandbox.written[0]), /^\/run\/guilds\/requests\/r_code-call_\d+\.json$/);
    assert.deepEqual(readdirSync(path.join(sandbox.runDir, "requests")), []);
    assert.ok(Buffer.from(JSON.stringify({ command })).toString("base64").length > INLINE_REQUEST_MAX);
  });

  test("a run keeps the logs of its 20 most recent runs", async () => {
    const sandbox = new HostCodeSandbox();
    for (let index = 0; index < 22; index += 1) {
      await call(sandbox, "shell", { command: "true" }, `r_${String(index).padStart(2, "0")}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const kept = readdirSync(path.join(sandbox.home, ".runs")).sort();
    assert.equal(kept.length, 20);
    assert.equal(kept.includes("r_00"), false);
    assert.equal(kept.includes("r_21"), true);
  });
});

function realHome(sandbox: HostCodeSandbox): string {
  return path.resolve(readlinkDeep(sandbox.home));
}

function readlinkDeep(dir: string): string {
  // macOS temp folders sit behind /var -> /private/var.
  return existsSync(`/private${dir}`) ? `/private${dir}` : dir;
}

test("call ids become safe file names", () => {
  assert.equal(callSegment("call_abc-1.2"), "call_abc-1.2");
  assert.equal(callSegment("functions.shell:0"), "functions.shell_0");
  assert.match(callSegment(".."), /^call_\d+$/);
});

test("a read of a range already held, unchanged, points at the earlier step", () => {
  const earlier = {
    seq: 7,
    metadata: { tool_name: "file_read", path: "/home/a_1/a.ts", range: [1, 200], content_hash: "h1", error: null },
  };
  const again = { tool_name: "file_read", path: "/home/a_1/a.ts", range: [10, 50], content_hash: "h1", error: null };
  assert.equal(repeatedReadStep([earlier], again), 7);
  assert.equal(repeatedReadStep([earlier], { ...again, content_hash: "h2" }), null);
  assert.equal(repeatedReadStep([earlier], { ...again, range: [150, 250] }), null);
  assert.equal(repeatedReadStep([earlier], { ...again, path: "/home/a_1/b.ts" }), null);
  const pointer = { seq: 9, metadata: { ...again, repeat_of: 7 } };
  assert.equal(repeatedReadStep([pointer], again), null);
  assert.equal(repeatedReadText(again, 7), "/home/a_1/a.ts lines 10–50: unchanged since step 7; read that result.");
});

test("every code tool is registered with an object schema and its required arguments", () => {
  const required: Record<string, string[]> = {
    shell: ["command"],
    shell_status: [],
    file_read: ["path"],
    code_search: ["pattern"],
    code_task: ["brief"],
  };
  for (const name of [...CODING_TOOLS, "code_task"]) {
    const tool = REGISTRY[name];
    assert.ok(tool, name);
    const parameters = (tool.schema.function as { parameters: { type: string; required: string[] } }).parameters;
    assert.equal(parameters.type, "object");
    assert.deepEqual(parameters.required, required[name], name);
  }
  for (const removed of ["file_edit", "file_write", "code_match", "code_map", "code_find", "code_outline", "code_callers"]) {
    assert.equal(REGISTRY[removed], undefined, removed);
  }
});

test("coding offers code_task and the code tools; without it they are refused names", () => {
  const coding = offeredToolNames(["note_find", "shell"], { coding: true });
  for (const name of [...CODING_TOOLS, "code_task"]) {
    assert.ok(coding.includes(name), name);
  }
  const plain = offeredToolNames(["note_find", "shell", "file_read", "code_task"], {});
  assert.deepEqual(plain, ["note_find", "report_issue"]);
  const noScripts = offeredToolNames(["note_find", "script_list", "script_run"], {
    scripting: false,
  });
  assert.deepEqual(noScripts, ["note_find", "report_issue"]);
  const snapshot = configSnapshot({ ...AGENT_CONFIG, coding: true, harness: "codex" }, { tools: [], secrets: [], mcp: [] }, "schedule");
  assert.equal(snapshot.coding, true);
  assert.equal(snapshot.harness, "codex");
  assert.equal(snapshot.harness_model, null, "the subscription's default");
  const pinned = configSnapshot(
    { ...AGENT_CONFIG, coding: true, harness: "claude-code", harness_model: "opus" },
    { tools: [], secrets: [], mcp: [] }, "schedule",
  );
  assert.equal(pinned.harness_model, "opus");
  assert.equal(snapshot.harness_effort, null, "the harness's default effort");
  const effort = configSnapshot(
    { ...AGENT_CONFIG, coding: true, harness: "claude-code", harness_model: "opus", harness_effort: "high" },
    { tools: [], secrets: [], mcp: [] }, "schedule",
  );
  assert.equal(effort.harness_effort, "high");
  assert.deepEqual(snapshot.secret_aliases, {});
  const aliased = configSnapshot(
    { ...AGENT_CONFIG, secret_aliases: { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" } },
    { tools: [], secrets: [], mcp: [] }, "schedule",
  );
  assert.deepEqual(aliased.secret_aliases, { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" });
  const names = (snapshot.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  assert.ok(names.includes("shell"));
  assert.ok(names.includes("code_task"));
});

test("agent workspace max is the agent's cap, never above the host cap", () => {
  assert.equal(agentWorkspaceMaxMib({}), 10240);
  assert.equal(agentWorkspaceMaxMib({ max_workspace_mib: 512 }), 512);
  assert.equal(agentWorkspaceMaxMib({ max_workspace_mib: 20000 }, { WORKSPACE_MAX_MIB: "4096" }), 4096);
});

test("coding defaults to off, and a new coding agent gets the coding budgets", () => {
  assert.equal(validateConfig({ ...AGENT_CONFIG }).coding, false);
  const coder = validateConfig(withCodingLimits({ model: AGENT_CONFIG.model, browser: false, coding: true }));
  assert.equal(coder.max_steps, 200);
  assert.equal(coder.max_tool_calls, 200);
  assert.equal(coder.max_input_tokens, 100000);
  const explicit = validateConfig(withCodingLimits({ ...AGENT_CONFIG, coding: true, max_steps: 12 }));
  assert.equal(explicit.max_steps, 12);
  assert.equal(explicit.max_tool_calls, AGENT_CONFIG.max_tool_calls);
  assert.throws(() => validateConfig({ ...AGENT_CONFIG, coding: "yes" }), /coding must be a boolean/);
});

describe("coding runs in the generation loop", () => {
  afterEach(() => {
    live.streamCompletion = originalStream;
  });

  function codingSnapshot(): RunConfigSnapshot {
    return configSnapshot(CODER, { tools: [], secrets: [], mcp: [] }, "schedule");
  }

  function scripted(db: FakeDB, turns: Array<Array<Record<string, unknown>>>) {
    return async function* stream(options: { messages: Array<Record<string, unknown>> }) {
      db.llm_histories.push([...options.messages]);
      const calls = turns[db.llm_histories.length - 1];
      const payload = calls ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "done" };
      const completion: Completion = {
        payload,
        metadata: {
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
          latency_ms: 1,
          finish_reason: calls ? "tool_calls" : "stop",
          model: "test",
          response_id: "c1",
          provider_request_id: null,
          cost_usd: 0,
        },
      };
      yield ["done", completion] as ["done", Completion];
    };
  }

  function codingSandboxes(sandbox: HostCodeSandbox) {
    const sandboxes = new FakeSandboxes();
    const machines: MachineSpec[] = [];
    sandboxes.ensure = (async (machine: MachineSpec) => {
      machines.push(machine);
      sandboxes.running.add(machine.id);
      return sandbox;
    }) as unknown as FakeSandboxes["ensure"];
    return { sandboxes, machines };
  }

  test("a repeated read of an unchanged range becomes a pointer; a change brings content back", async () => {
    const sandbox = readySandbox();
    mkdirSync(path.join(sandbox.home, "repo"));
    writeFileSync(path.join(sandbox.home, "repo/a.txt"), "one\ntwo\nthree\n");
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop", "admin"]);
    db.agent.config = { ...CODER };
    const read = (id: string) => ({ id, function: { name: "file_read", arguments: '{"path":"repo/a.txt"}' } });
    live.streamCompletion = scripted(db, [
      [read("c1"), read("c2")],
      [{ id: "c3", function: { name: "shell", arguments: '{"command":"printf \'one\\\\n2\\\\nthree\\\\n\' > repo/a.txt"}' } }],
      [read("c4")],
    ]) as typeof live.streamCompletion;
    const { sandboxes, machines } = codingSandboxes(sandbox);
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.generator.generate("r_1", 1);
    assert.equal(machines[0]?.id, "mach_1");
    const tools = db.messages.filter((row) => (row.payload as Record<string, unknown>).role === "tool");
    const contents = tools.map((row) => String((row.payload as Record<string, unknown>).content).split("\n\nremaining_tool_calls")[0]);
    assert.match(String(contents[0]), /^repo\/a\.txt · lines 1–3 of 3\n1 {2}one\n2 {2}two\n3 {2}three$/);
    const firstSeq = Number(tools[0]?.seq);
    assert.match(String(contents[1]), new RegExp(`a\\.txt lines 1–3: unchanged since step ${firstSeq}; read that result\\.$`));
    assert.equal((tools[1]?.metadata as Record<string, unknown>).repeat_of, firstSeq);
    assert.equal(contents[2], "(no output)");
    assert.match(String(contents[3]), /^repo\/a\.txt · lines 1–3 of 3\n1 {2}one\n2 {2}2\n3 {2}three$/);
    assert.equal((tools[3]?.metadata as Record<string, unknown>).repeat_of, undefined);
  });

  test("a coding generation records the workspace size and stops at start when it is over the limit", async () => {
    const sandbox = readySandbox();
    const sizes: number[] = [];
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop", "admin"]) as RepoDB & {
      setAgentWorkspaceMib(id: string, mib: number): Promise<void>;
    };
    db.setAgentWorkspaceMib = async (_id, mib) => {
      sizes.push(mib);
    };
    db.agent.config = { ...CODER };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes } = codingSandboxes(sandbox);
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.generator.generate("r_1", 1);
    assert.equal(sizes.length, 1);
    assert.equal(db.llm_histories.length, 1);

    writeFileSync(path.join(sandbox.home, "blob"), Buffer.alloc(3 * 1024 * 1024));
    db.agent.workspace_mib = 50;
    const previous = process.env.WORKSPACE_MAX_MIB;
    process.env.WORKSPACE_MAX_MIB = "2";
    try {
      await loop.generator.generate("r_1", 2);
    } finally {
      if (previous === undefined) {
        delete process.env.WORKSPACE_MAX_MIB;
      } else {
        process.env.WORKSPACE_MAX_MIB = previous;
      }
    }
    assert.equal(db.llm_histories.length, 1);
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "workspace.full");
    assert.match(String(errors.at(-1)?.message), /above the 2 MiB limit; free space from the CLI tab/);
  });

  test("a generation uses the agent's max_workspace_mib when it is below the host cap", async () => {
    const sandbox = readySandbox();
    writeFileSync(path.join(sandbox.home, "blob"), Buffer.alloc(3 * 1024 * 1024));
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop", "admin"]) as RepoDB & {
      setAgentWorkspaceMib(id: string, mib: number): Promise<void>;
    };
    db.setAgentWorkspaceMib = async () => {};
    db.agent.config = { ...CODER, max_workspace_mib: 2 };
    db.agent.workspace_mib = 50;
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes } = codingSandboxes(sandbox);
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "workspace.full");
    assert.match(String(errors.at(-1)?.message), /above the 2 MiB limit; free space from the CLI tab/);
  });

  test("a coding run without a harness fails at start, naming the fix; a run with coding off is unaffected", async () => {
    const sandbox = new HostCodeSandbox();
    const legacy = { ...AGENT_CONFIG, coding: true };
    const db = new FakeDB(configSnapshot(legacy, { tools: [], secrets: [], mcp: [] }, "schedule"));
    db.agent.config = { ...legacy };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes, machines } = codingSandboxes(sandbox);
    await makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes).generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    assert.equal(machines.length, 0, "the machine is not woken");
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "harness.missing");
    assert.match(String(errors.at(-1)?.message), /no harness is picked: choose Claude Code, Codex, Cursor, or Antigravity in the agent's Settings/);

    const plain = new FakeDB(configSnapshot({ ...AGENT_CONFIG }, { tools: [], secrets: [], mcp: [] }, "schedule"));
    live.streamCompletion = scripted(plain, []) as typeof live.streamCompletion;
    await makeLoop(plain, {}, tempDir("guilds-gen-"), codingSandboxes(sandbox).sandboxes).generator.generate("r_1", 1);
    assert.equal(plain.llm_histories.length, 1);
  });

  test("a secret alias reaches the run's commands with the value of the secret it names", async () => {
    const sandbox = readySandbox();
    const aliases = { CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" };
    const config = { ...CODER, secret_aliases: aliases };
    const db = withRepositories(new FakeDB(configSnapshot(config, { tools: [], secrets: [], mcp: [] }, "schedule")), ["shop", "admin"]);
    db.agent.config = { ...config };
    db.secrets = [liveSecret("BOB_TOKEN")];
    live.streamCompletion = scripted(db, [
      [
        {
          id: "c1",
          function: {
            name: "shell",
            arguments: JSON.stringify({
              command: '[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ "$CLAUDE_CODE_OAUTH_TOKEN" = "$BOB_TOKEN" ] && echo same',
            }),
          },
        },
      ],
    ]) as typeof live.streamCompletion;
    await makeLoop(db, {}, tempDir("guilds-gen-"), codingSandboxes(sandbox).sandboxes).generator.generate("r_1", 1);
    const tool = db.messages.find((row) => (row.payload as Record<string, unknown>).role === "tool");
    assert.match(String((tool?.payload as Record<string, unknown>).content), /^same\n/);
  });

  test("a coding run in a guild without repositories fails at start, naming where to add one", async () => {
    const sandbox = readySandbox();
    const db = new FakeDB(codingSnapshot());
    db.agent.config = { ...CODER };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes, machines } = codingSandboxes(sandbox);
    await makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes).generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    assert.equal(machines.length, 0, "the machine is not woken");
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "coding.repositories_missing");
    assert.match(String(errors.at(-1)?.message), /add one in the guild's Repositories/);
  });

  test("a coding run whose harness has no credential fails at start, before the model, and forgets the login", async () => {
    const sandbox = new HostCodeSandbox();
    answerOps(sandbox, { check: { installed: true, version: "9.9.9", credential: null } });
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop", "admin"]) as RepoDB & {
      clearHarnessLogin(agentId: string, harness: string): Promise<void>;
    };
    const cleared: string[] = [];
    db.clearHarnessLogin = async (_agentId, harness) => {
      cleared.push(harness);
    };
    db.agent.config = { ...CODER };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    await makeLoop(db, {}, tempDir("guilds-gen-"), codingSandboxes(sandbox).sandboxes).generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "harness.credential");
    assert.match(String(errors.at(-1)?.message), /Claude Code has no credential: grant the secret CLAUDE_CODE_OAUTH_TOKEN/);
    assert.deepEqual(cleared, ["claude-code"]);
  });

  test("a coding run whose harness is not in the machine's image fails at start, naming the image to build", async () => {
    const sandbox = new HostCodeSandbox();
    answerOps(sandbox, { check: { installed: false, version: null, credential: null } });
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop", "admin"]);
    db.agent.config = { ...CODER };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    await makeLoop(db, {}, tempDir("guilds-gen-"), codingSandboxes(sandbox).sandboxes).generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "harness.not_installed");
    assert.match(String(errors.at(-1)?.message), /build the runtime image with HARNESSES naming claude-code/);
  });

  test("a machine's row keeps the harness CLIs its container carries, written when they change", async () => {
    const written: Array<[string, string[]]> = [];
    const db = new FakeDB(configSnapshot({ ...AGENT_CONFIG }, { tools: [], secrets: [], mcp: [] }, "schedule")) as FakeDB & {
      setMachineHarnesses(id: string, harnesses: string[]): Promise<void>;
    };
    db.setMachineHarnesses = async (id, harnesses) => {
      written.push([id, harnesses]);
    };
    const sandboxes = new FakeSandboxes() as FakeSandboxes & { harnessesOf(id: string): string[] | null };
    let carried: string[] | null = null;
    sandboxes.harnessesOf = () => carried;
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    loop.machines.reportHarnesses("mach_1");
    carried = ["codex", "claude-code"];
    loop.machines.reportHarnesses("mach_1");
    loop.machines.reportHarnesses("mach_1");
    carried = ["codex"];
    loop.machines.reportHarnesses("mach_1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [
      ["mach_1", ["codex", "claude-code"]],
      ["mach_1", ["codex"]],
    ]);
  });

  test("a non-coding generation records the workspace size and stops when it is over the agent's max", async () => {
    const sandbox = new HostCodeSandbox();
    const sizes: number[] = [];
    const db = new FakeDB(configSnapshot({ ...AGENT_CONFIG }, { tools: [], secrets: [], mcp: [] }, "schedule")) as FakeDB & {
      setAgentWorkspaceMib(id: string, mib: number): Promise<void>;
    };
    db.setAgentWorkspaceMib = async (_id, mib) => {
      sizes.push(mib);
    };
    db.agent.config = { ...AGENT_CONFIG };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes } = codingSandboxes(sandbox);
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    await loop.generator.generate("r_1", 1);
    assert.equal(sizes.length, 1);
    assert.equal(db.llm_histories.length, 1);

    writeFileSync(path.join(sandbox.home, "blob"), Buffer.alloc(3 * 1024 * 1024));
    db.agent.workspace_mib = 50;
    db.agent.config = { ...AGENT_CONFIG, max_workspace_mib: 2 };
    await loop.generator.generate("r_1", 2);
    assert.equal(db.llm_histories.length, 1);
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "workspace.full");
  });
});

describe("repositories in a coding generation", () => {
  afterEach(() => {
    live.streamCompletion = originalStream;
  });

  const gitEnv = (home: string) => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" });

  function origin(): string {
    const home = tempDir("guilds-origin-home-");
    const work = path.join(tempDir("guilds-origin-"), "work");
    const bare = path.join(path.dirname(work), "shop.git");
    const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: gitEnv(home), stdio: "pipe" });
    mkdirSync(work);
    git(["init", "-q", "-b", "main"], work);
    writeFileSync(path.join(work, "README.md"), "shop\n");
    git(["add", "README.md"], work);
    git(["-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "init"], work);
    git(["clone", "-q", "--bare", work, bare], path.dirname(work));
    return bare;
  }

  function scripted(db: FakeDB, turns: Array<Array<Record<string, unknown>>>) {
    return async function* stream(options: { messages: Array<Record<string, unknown>> }) {
      db.llm_histories.push([...options.messages]);
      const calls = turns.shift();
      const payload = calls ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "done" };
      yield [
        "done",
        {
          payload,
          metadata: {
            usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
            latency_ms: 1,
            finish_reason: calls ? "tool_calls" : "stop",
            model: "test",
            response_id: "c1",
            provider_request_id: null,
            cost_usd: 0,
          },
        } as Completion,
      ] as ["done", Completion];
    };
  }

  function setup(url: string) {
    const sandbox = readySandbox({ clones: true });
    const db = withRepositories(new FakeDB(configSnapshot(CODER, { tools: [], secrets: [], mcp: [] }, "schedule")), ["shop"], url);
    db.agent.config = { ...CODER };
    const sandboxes = new FakeSandboxes();
    sandboxes.ensure = (async (machine: MachineSpec) => {
      sandboxes.running.add(machine.id);
      return sandbox;
    }) as unknown as FakeSandboxes["ensure"];
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    return { sandbox, db, loop };
  }

  test("a generation clones the repository, starts in it, and records what it changed", async () => {
    const { sandbox, db, loop } = setup(`file://${origin()}`);
    const edit = (id: string, text: string) => ({
      id,
      function: { name: "shell", arguments: JSON.stringify({ command: `echo ${text} >> README.md && pwd` }) },
    });
    live.streamCompletion = scripted(db, [[edit("c1", "one")]]) as typeof live.streamCompletion;
    await loop.generator.generate("r_1", 1);
    const clone = path.join(sandbox.home, "repos/shop");
    assert.equal(readFileSync(path.join(clone, "README.md"), "utf8"), "shop\none\n");
    const tool = db.messages.find((row) => (row.payload as Record<string, unknown>).role === "tool");
    assert.match(String((tool?.payload as Record<string, unknown>).content), /repos\/shop\n\nremaining_tool_calls/);
    const git = (args: string[]) =>
      execFileSync("git", ["-C", clone, ...args], { env: gitEnv(sandbox.home), encoding: "utf8" }).trim();
    assert.equal(git(["config", "--global", "user.name"]), "researcher");
    assert.equal(git(["config", "--global", "user.email"]), "a_1@agents.guilds.run");
    const first = ((db.run.metadata as Record<string, unknown>).repos as Array<Record<string, unknown>>)[0]!;
    assert.equal(first.name, "shop");
    assert.equal(first.branch, "main");
    assert.equal(first.files_changed, 1);
    assert.equal(first.insertions, 1);
    assert.equal(first.deletions, 0);
    assert.equal(first.start_sha, git(["rev-parse", "refs/guild/runs/r_1/start"]));
    assert.equal(first.end_sha, git(["rev-parse", "refs/guild/runs/r_1/end"]));
    assert.equal(git(["status", "--porcelain"]), "M README.md");

    live.streamCompletion = scripted(db, [[edit("c2", "two")]]) as typeof live.streamCompletion;
    await loop.generator.generate("r_1", 2);
    const second = ((db.run.metadata as Record<string, unknown>).repos as Array<Record<string, unknown>>)[0]!;
    assert.equal(second.start_sha, first.start_sha);
    assert.notEqual(second.end_sha, first.end_sha);
    assert.equal(second.insertions, 2);

    const { diff, truncated } = await loop.coding.runDiff("r_1", "shop");
    assert.equal(truncated, false);
    assert.match(diff, /^diff --git a\/README\.md b\/README\.md/);
    assert.match(diff, /\n\+one\n\+two\n/);
    loop.machines.cancelIdle("a_1");
  });

  test("a generation uses the guild's commit author email", async () => {
    const { sandbox, db, loop } = setup(`file://${origin()}`);
    db.getGuild = async () => ({
      id: "guild_1",
      name: "research",
      org_slug: "acme",
      git_author_email: "dev@example.com",
    });
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    await loop.generator.generate("r_1", 1);
    const git = (args: string[]) =>
      execFileSync("git", ["-C", path.join(sandbox.home, "repos/shop"), ...args], {
        env: gitEnv(sandbox.home),
        encoding: "utf8",
      }).trim();
    assert.equal(git(["config", "--global", "user.email"]), "dev@example.com");
    assert.equal(git(["config", "--global", "user.name"]), "researcher");
    loop.machines.cancelIdle("a_1");
  });

  test("a repository that cannot be cloned fails the generation at start", async () => {
    const { db, loop } = setup(`file://${tempDir("guilds-missing-")}/nothing.git`);
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    await loop.generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "repository.clone");
    assert.match(String(errors.at(-1)?.message), /^clone failed: shop: /);
  });
});
