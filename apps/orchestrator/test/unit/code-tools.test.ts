import assert from "node:assert/strict";
import type { ToolCall } from "../../src/db/schema/index.js";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { validateAgentConfig, validateNewAgentConfig } from "../../src/agents/validation.js";
import { agentWorkspaceMaxMib } from "../../src/generation/workspace.js";
import { generationLive } from "../../src/generation/completion.js";
import { configSnapshot } from "../../src/generation/snapshot.js";
import { offeredToolNames } from "../../src/toolbox/offered.js";
import type { Completion } from "../../src/llm/completion.js";
import { createToolHooks } from "../../src/toolbox/index.js";
import { callSegment, decodeEnvelope, INLINE_REQUEST_MAX, runCodeHelper } from "../../src/toolbox/code.js";
import { REGISTRY } from "../../src/toolbox/index.js";
import type { MachineSpec } from "../../src/sandbox/index.js";
import { answerOps, HostCodeSandbox } from "../helpers/code-sandbox.js";
import { HEX_MASTER_KEY, storeKeys, tempDir } from "../helpers/env.js";
import type { ResolvedAgentConfig, RunConfigSnapshot } from "../../src/db/schema/index.js";
import { AGENT_CONFIG, FakeDB, FakeSandboxes, makeLoop } from "../helpers/generation.js";
import { connectionRow } from "../helpers/servers.js";
import { encryptPayload } from "../../src/credentials/crypto.js";
import type { McpConnectionRow } from "../../src/db/mcp.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { toolFixture } from "../helpers/toolbox.js";

const live = generationLive;
/** The box's GitHub App, as the instance admin stored it. */
const GITHUB_APP_KEYS = {
  app_id: "4242",
  slug: "guilds-run-test",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_id: "Iv1.client",
  client_secret: "client-secret",
};
/** A coding agent's config: coding on, with a harness. */
const CODER: ResolvedAgentConfig = { ...AGENT_CONFIG, coding: true, harness: "claude-code" };
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
      provider: null,
      connection_id: null,
      secret_id: null,
      username: null,
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
  return toolFixture({
    run_id: runId,
    agent_id: "a_1",
    guild_id: "g_1",
    sandbox,
    secrets: { TOKEN: "s3cr3t-value" },
  });
}

test("a request too large for one argument travels through the sandbox file API", async () => {
  const sandbox = new HostCodeSandbox();
  const pad = "z".repeat(120 * 1024);
  const result = await runCodeHelper(ctxFor(sandbox).run, createToolHooks(), { op: "workspace_size", pad });
  assert.equal(typeof result.meta.mib, "number");
  assert.equal(sandbox.written.length, 1);
  assert.match(String(sandbox.written[0]), /^\/run\/guilds\/requests\/r_code-workspace_size_\d+\.json$/);
  assert.deepEqual(readdirSync(path.join(sandbox.runDir, "requests")), []);
  assert.ok(Buffer.from(JSON.stringify({ pad })).toString("base64").length > INLINE_REQUEST_MAX);
});

test("call ids become safe file names", () => {
  assert.equal(callSegment("call_abc-1.2"), "call_abc-1.2");
  assert.equal(callSegment("functions.shell:0"), "functions.shell_0");
  assert.match(callSegment(".."), /^call_\d+$/);
});

test("a helper envelope reads its fields by type, and is refused when it is not an object", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  assert.deepEqual(decodeEnvelope(encode({ ok: true, text: "hi", meta: { lines: 2 } })), {
    ok: true,
    text: "hi",
    meta: { lines: 2 },
    error: null,
  });
  assert.deepEqual(decodeEnvelope(encode({ ok: false, error: "no such file", meta: [1] })), {
    ok: false,
    text: "",
    meta: {},
    error: "no such file",
  });
  assert.throws(() => decodeEnvelope(encode([1])), /non-object/);
});

test("no code tool is registered or offered", () => {
  for (const removed of ["shell", "shell_status", "file_read", "code_search", "code_task", "file_edit", "file_write", "code_match"]) {
    assert.equal(REGISTRY[removed], undefined, removed);
  }
  assert.deepEqual(offeredToolNames(["note_find"], {}), ["note_find", "report_issue"]);
});

test("a coding agent's snapshot keeps its harness, model, effort and aliases", () => {
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
});

test("agent workspace max is the agent's cap, never above the host cap", () => {
  assert.equal(agentWorkspaceMaxMib({ max_workspace_mib: 512 }), 512);
  assert.equal(agentWorkspaceMaxMib({ max_workspace_mib: 20000 }, { WORKSPACE_MAX_MIB: "4096" }), 4096);
});

test("coding defaults to off, and a new coding agent gets the coding budgets", () => {
  assert.equal(validateAgentConfig({ ...AGENT_CONFIG }).coding, false);
  const coder = validateNewAgentConfig({ model: AGENT_CONFIG.model, browser: false, coding: true });
  assert.equal(coder.max_steps, 200);
  assert.equal(coder.max_tool_calls, 200);
  assert.equal(coder.max_input_tokens, 100000);
  const explicit = validateNewAgentConfig({ ...AGENT_CONFIG, coding: true, max_steps: 12 });
  assert.equal(explicit.max_steps, 12);
  assert.equal(explicit.max_tool_calls, AGENT_CONFIG.max_tool_calls);
  assert.throws(() => validateAgentConfig({ ...AGENT_CONFIG, coding: "yes" }), /coding must be a boolean/);
});

describe("coding runs in the generation loop", () => {
  afterEach(() => {
    live.streamCompletion = originalStream;
  });

  function codingSnapshot(): RunConfigSnapshot {
    return configSnapshot(CODER, { tools: [], secrets: [], mcp: [] }, "schedule");
  }

  function scripted(db: FakeDB, turns: ToolCall[][]) {
    return async function* stream(options: { messages: Array<Record<string, unknown>> }) {
      db.llm_histories.push([...options.messages]);
      const calls = turns[db.llm_histories.length - 1];
      const payload = calls ? { role: "assistant" as const, content: "", tool_calls: calls } : { role: "assistant" as const, content: "done" };
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
          cost_source: "catalog" as const,
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

  test("a coding generation records the workspace size and stops at start when it is over the limit", async () => {
    const sandbox = readySandbox();
    const sizes: number[] = [];
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop", "admin"]) as RepoDB & {
      setAgentWorkspaceMib(id: string, mib: number): Promise<void>;
    };
    db.setAgentWorkspaceMib = async (_id, mib) => {
      sizes.push(mib);
    };
    db.agent.config = { ...CODER, repositories: ["shop", "admin"] };
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
    db.agent.config = { ...CODER, max_workspace_mib: 2, repositories: ["shop", "admin"] };
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

  test("a subscription agent's run on a harness that needs a repository fails at start without one, before its machine wakes or a model is called", async () => {
    const config: ResolvedAgentConfig = { ...AGENT_CONFIG, model: null, harness: "antigravity" };
    const db = new FakeDB(configSnapshot(config, { tools: [], secrets: [], mcp: [] }, "schedule"));
    db.agent.config = { ...config };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes, machines } = codingSandboxes(new HostCodeSandbox());
    await makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes).generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    assert.equal(machines.length, 0, "the machine is not woken");
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "coding.repositories_missing");
    assert.match(String(errors.at(-1)?.message), /this agent has no repository: pick one in its Settings under Repositories/);
  });

  test("a coding run of an agent that picks no repository fails at start, naming where to pick one", async () => {
    const sandbox = readySandbox();
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop"]);
    db.agent.config = { ...CODER };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes, machines } = codingSandboxes(sandbox);
    await makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes).generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    assert.equal(machines.length, 0, "the machine is not woken");
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "coding.repositories_missing");
    assert.match(String(errors.at(-1)?.message), /pick one in its Settings under Repositories/);
  });

  test("a coding run of an agent that picks a repository it can no longer use fails at start, naming it", async () => {
    const sandbox = readySandbox();
    const db = withRepositories(new FakeDB(codingSnapshot()), ["shop"]);
    db.agent.config = { ...CODER, repositories: ["shop", "billing"] };
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    const { sandboxes, machines } = codingSandboxes(sandbox);
    await makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes).generator.generate("r_1", 1);
    assert.equal(db.llm_histories.length, 0);
    assert.equal(machines.length, 0, "the machine is not woken");
    const errors = db.run.errors as Array<Record<string, unknown>>;
    assert.equal(errors.at(-1)?.operation, "coding.repositories_gone");
    assert.match(String(errors.at(-1)?.message), /this agent picks billing, which it can no longer use/);
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
    db.agent.config = { ...CODER, repositories: ["shop", "admin"] };
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
    db.agent.config = { ...CODER, repositories: ["shop", "admin"] };
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

  function scripted(db: FakeDB, turns: ToolCall[][]) {
    return async function* stream(options: { messages: Array<Record<string, unknown>> }) {
      db.llm_histories.push([...options.messages]);
      const calls = turns.shift();
      const payload = calls ? { role: "assistant" as const, content: "", tool_calls: calls } : { role: "assistant" as const, content: "done" };
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
            cost_source: "catalog" as const,
          },
        } as Completion,
      ] as ["done", Completion];
    };
  }

  function setup(url: string) {
    const sandbox = readySandbox({ clones: true });
    const db = withRepositories(new FakeDB(configSnapshot(CODER, { tools: [], secrets: [], mcp: [] }, "schedule")), ["shop"], url);
    db.agent.config = { ...CODER, repositories: ["shop"] };
    const sandboxes = new FakeSandboxes();
    sandboxes.ensure = (async (machine: MachineSpec) => {
      sandboxes.running.add(machine.id);
      return sandbox;
    }) as unknown as FakeSandboxes["ensure"];
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
    return { sandbox, db, loop };
  }

  test("a generation clones the repository", async () => {
    const { sandbox, db, loop } = setup(`file://${origin()}`);
    live.streamCompletion = scripted(db, []) as typeof live.streamCompletion;
    await loop.generator.generate("r_1", 1);
    const clone = path.join(sandbox.home, "repos/shop");
    assert.equal(readFileSync(path.join(clone, "README.md"), "utf8"), "shop\n");
    const git = (args: string[]) =>
      execFileSync("git", ["-C", clone, ...args], { env: gitEnv(sandbox.home), encoding: "utf8" }).trim();
    assert.equal(git(["config", "--global", "user.name"]), "researcher");
    assert.equal(git(["config", "--global", "user.email"]), "a_1@agents.guilds.run");
    assert.equal(git(["status", "--porcelain"]), "");
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

  test("a repository whose GitHub installation is gone fails the generation at start and retires its login", async () => {
    process.env.SECRETS_MASTER_KEY = HEX_MASTER_KEY;
    setInstanceKeys(storeKeys({ "github-app": GITHUB_APP_KEYS }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "suspended" }), { status: 403, headers: { "Content-Type": "application/json" } });
    const { db, loop } = setup("https://github.com/acme/shop");
    const [ciphertext, nonce] = encryptPayload({ installation_id: 77, account: "acme" });
    db.mcp_connection = connectionRow({ id: "conn_gh", mcp_server_id: "mcp_github", account_hint: "acme", ciphertext, nonce });
    db.listGuildRepositories = async () => [
      { id: "repo_1", guild_id: "guild_1", name: "shop", url: "https://github.com/acme/shop", default_branch: "main", provider: "github", connection_id: "conn_gh", remote_id: 101 },
    ];
    const retired: string[] = [];
    Object.assign(db, {
      retireLogin: async (login: McpConnectionRow, failure: string) => {
        retired.push(`${login.id}:${failure}`);
      },
    });
    try {
      await loop.generator.generate("r_1", 1);
    } finally {
      globalThis.fetch = realFetch;
      setInstanceKeys({});
    }
    assert.equal(db.llm_histories.length, 0);
    assert.deepEqual(retired, ["conn_gh:installation_gone"]);
    const errors = Array.isArray(db.run.errors) ? db.run.errors : [];
    assert.equal(errors.at(-1)?.operation, "repository.token");
    assert.equal(errors.at(-1)?.error_type, "RepositoryAccessError");
    assert.equal(errors.at(-1)?.message, "GitHub refused the installation for acme; the connection is now disconnected");
  });
});
