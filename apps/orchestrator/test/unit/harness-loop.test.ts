import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { generationLive } from "../../src/generation/completion.js";
import { harnessTurnFailure } from "../../src/generation/harness-ending.js";
import { harnessTurnTiming } from "../../src/generation/harness-loop.js";
import { attachmentHomePath, harnessTurnPrompt, openingAttachments } from "../../src/generation/harness-prompt.js";
import { configSnapshot } from "../../src/generation/snapshot.js";
import { INTERRUPTED_CONTENT } from "../../src/generation/tool-calls.js";
import type { MessageRow } from "../../src/db/runs.js";
import type { AttachmentRef, ResolvedAgentConfig } from "../../src/db/schema/index.js";
import type { MachineSpec } from "../../src/sandbox/index.js";
import { answerOps, sandboxHelperRequest, type HostCodeSandbox } from "../helpers/code-sandbox.js";
import { tempDir } from "../helpers/env.js";
import { AGENT_CONFIG, FakeDB, FakeSandboxes, makeLoop } from "../helpers/generation.js";
import { toolFixture } from "../helpers/toolbox.js";
import { createToolHooks } from "../../src/toolbox/index.js";
import { HARNESS_HELPER, runCodeHelper } from "../../src/toolbox/code.js";
import { HANG, RECORDED_SESSION, recordedEvents, stubCliSandbox, stubsRunning } from "../helpers/harness-cli.js";

const live = generationLive;
const originalStream = live.streamCompletion;
const timing = { ...harnessTurnTiming };
const SUBSCRIBER: ResolvedAgentConfig = { ...AGENT_CONFIG, model: null, harness: "claude-code" };
const HARNESS_READY = { installed: true, version: "9.9.9 (stub)", credential: "secret" };

before(() => {
  harnessTurnTiming.pollMs = 50;
});
after(() => {
  Object.assign(harnessTurnTiming, timing);
});

type Row = { seq: number; payload: Record<string, unknown>; metadata: Record<string, unknown> };

/**
 * A generation loop whose run `r_1` is a direct run of a Claude Code subscription agent, on a
 * machine whose sandbox runs `guilds-harness` on this host with the stand-in CLI replaying
 * `lines`; its harness check finds Claude Code ready unless `check` says otherwise.
 */
function subscriptionLoop(lines: string[], check: Record<string, unknown> = HARNESS_READY) {
  const stub = stubCliSandbox("claude", lines);
  answerOps(stub.sandbox, { check });
  const db = new FakeDB(configSnapshot(SUBSCRIBER, { tools: [], secrets: [], mcp: [] }, "direct"));
  db.agent.config = { ...SUBSCRIBER };
  const sandboxes = new FakeSandboxes();
  const machines: MachineSpec[] = [];
  sandboxes.ensure = (async (machine: MachineSpec) => {
    machines.push(machine);
    sandboxes.running.add(machine.id);
    return stub.sandbox;
  }) as unknown as FakeSandboxes["ensure"];
  const loop = makeLoop(db, {}, tempDir("guilds-gen-"), sandboxes);
  const published: string[] = [];
  const publish = loop.events.publish.bind(loop.events);
  loop.events.publish = async (runId, ...event) => {
    published.push(event[0]);
    await publish(runId, ...event);
  };
  sandboxes.connectRunning = (async (machineId: string) =>
    sandboxes.running.has(machineId) ? stub.sandbox : null) as unknown as FakeSandboxes["connectRunning"];
  const rows = () => (db.messages as Row[]).slice(2);
  const errors = () => db.run.errors as Array<{ operation: string; message: string }>;
  return { ...stub, db, loop, machines, sandboxes, published, rows, errors };
}

/** Fails every op `op` of the sandbox's helper with `error`, as a helper envelope says it. */
function failOp(sandbox: HostCodeSandbox, op: string, error: string): void {
  const run = sandbox.commands.run;
  sandbox.commands.run = async (command, opts) => {
    if (sandboxHelperRequest(sandbox, command)?.op !== op) {
      return run(command, opts);
    }
    const envelope = Buffer.from(JSON.stringify({ ok: false, error }), "utf8").toString("base64");
    return { exit_code: 0, logs: { stdout: [{ text: envelope }], stderr: [] } };
  };
}

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !done(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("a subscription agent's generation runs a turn of its harness", () => {
  const modelCalls: unknown[] = [];
  before(() => {
    live.streamCompletion = (async function* (request: unknown) {
      modelCalls.push(request);
      yield* [];
    }) as unknown as typeof live.streamCompletion;
  });
  afterEach(() => {
    modelCalls.length = 0;
  });
  after(() => {
    live.streamCompletion = originalStream;
  });

  test("a direct message gets the CLI's messages and tool calls as rows, on the run's system prompt", async () => {
    const { loop, db, calls, rows, errors, published } = subscriptionLoop(recordedEvents("claude-code"));
    await loop.generator.generate("r_1", 1);

    assert.deepEqual(errors(), []);
    assert.equal(modelCalls.length, 0, "no model is called");
    const kept = rows();
    assert.deepEqual(
      kept.map((row) => row.payload.role),
      ["assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"],
    );
    assert.equal(kept[0]?.payload.content, "I'll look at the greeting first.");
    assert.deepEqual(kept[0]?.payload.tool_calls, [
      { id: "toolu_01", type: "function", function: { name: "Read", arguments: '{"file_path":"/home/a_1/repos/app/greet.py"}' } },
    ]);
    assert.deepEqual(kept[1]?.payload, { role: "tool", tool_call_id: "toolu_01", content: "1\tprint('hello')\n" });
    assert.equal(kept[1]?.metadata.tool_name, "Read");
    assert.equal(kept[5]?.metadata.tool_name, "Bash");
    assert.match(String(kept[6]?.payload.content), /Should the greeting also name the agent\?$/);
    for (const row of kept) {
      assert.equal(row.metadata.from_harness, "claude-code");
      assert.equal(row.metadata.generation, 1);
    }
    assert.equal(published.filter((name) => name === "message.committed").length, 7);
    assert.deepEqual(
      [kept[6]?.metadata.usage, kept[6]?.metadata.cost_usd, kept[6]?.metadata.cost_source],
      [{ input_tokens: 12, output_tokens: 140, cache_read_tokens: 0 }, 0, "subscription"],
      "the reply records the turn's usage, with no price",
    );
    assert.ok(kept.slice(0, 6).every((row) => row.metadata.usage === undefined));
    assert.equal(published[0], "generation.started");
    assert.equal(published.at(-1), "generation.finished");
    assert.equal(db.run.status, "active", "a direct run waits for its next message");
    assert.deepEqual((db.run.metadata as Record<string, unknown>).harness_turn, {
      call_id: "turn_1_r_1",
      harness: "claude-code",
      session_id: RECORDED_SESSION,
      log_path: ".runs/r_1/turn_1_r_1.harness.jsonl",
    });

    const [call] = calls();
    assert.ok(call);
    assert.equal(call.system_prompt, "sys", "the run's first row replaces Claude Code's own system prompt");
    assert.ok(call.argv.includes("--system-prompt-file"));
    assert.ok(call.argv.includes("--strict-mcp-config"));
    assert.equal(call.stdin, "use bash twice", "the message that opened the generation is the prompt");
    assert.ok(!call.argv.includes("--resume"), "a new run starts a new session");
    assert.equal(call.argv[call.argv.indexOf("--max-turns") + 1], String(SUBSCRIBER.max_steps), "its turn makes at most max_steps model calls");
  });

  test("a message's image on a box that keeps no images fails the turn at start, and the CLI never runs", async () => {
    const { loop, db, calls, errors } = subscriptionLoop(recordedEvents("claude-code"));
    const opening = (db.messages as Row[])[1];
    assert.ok(opening);
    opening.metadata = { ...opening.metadata, attachments: [{ id: "att_1", filename: "shot.png", mime: "image/png", kind: "image" }] };
    await loop.generator.generate("r_1", 1);
    assert.deepEqual(
      errors().map((entry) => [entry.operation, entry.message]),
      [["harness.start", "Claude Code did not start: attachments are not configured"]],
    );
    assert.equal(calls().length, 0);
  });

  test("a Claude Code turn that stops at its max_steps ends the generation with generation.max_steps", async () => {
    const recorded = recordedEvents("claude-code");
    const stopped = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 30, session_id: RECORDED_SESSION, usage: { input_tokens: 40, output_tokens: 9 } });
    const { loop, rows, errors, sandbox } = subscriptionLoop([...recorded.slice(0, 3), stopped]);
    sandbox.env.HARNESS_STUB_EXIT = "1";
    await loop.generator.generate("r_1", 1);
    assert.deepEqual(errors().map((error) => [error.operation, error.message]), [["generation.max_steps", "max_steps reached"]]);
    assert.equal(rows().at(-1)?.metadata.cost_source, "subscription", "its usage is kept as a finished turn's");
  });

  test("the CLI's events for a call of the orchestrator's MCP server make no row of their own", async () => {
    const session = { parent_tool_use_id: null, session_id: RECORDED_SESSION };
    const mcpCall = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_mcp", name: "mcp__guilds__note_write", input: { path: "a.md" } }] },
      ...session,
    });
    const mcpResult = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_mcp", content: "wrote a.md" }] },
      ...session,
    });
    const [init, ...rest] = recordedEvents("claude-code");
    const { loop, rows, errors } = subscriptionLoop([init!, mcpCall, mcpResult, ...rest]);
    await loop.generator.generate("r_1", 1);
    assert.deepEqual(errors(), []);
    const kept = rows();
    assert.equal(kept.length, 7, "the recorded turn's rows alone");
    assert.ok(!kept.some((row) => JSON.stringify(row.payload).includes("toolu_mcp")));
  });

  test("the run's next generation resumes the session with the messages added since its reply", async () => {
    const { loop, db, calls } = subscriptionLoop(recordedEvents("claude-code"));
    await loop.generator.generate("r_1", 1);
    const seq = Math.max(...db.messages.map((row) => Number(row.seq))) + 1;
    db.messages.push({ id: seq + 1, seq, payload: { role: "user", content: "Yes, name the agent too." }, metadata: { generation: 2, source: "ui" }, created_at: new Date() });
    await loop.generator.generate("r_1", 2);
    const [, second] = calls();
    assert.ok(second);
    assert.deepEqual(second.argv.slice(-2), ["--resume", RECORDED_SESSION]);
    assert.equal(second.stdin, "Yes, name the agent too.");
    assert.equal(second.system_prompt, "sys");
    assert.equal((db.run.metadata as { harness_turn?: { call_id: string } }).harness_turn?.call_id, "turn_2_r_1");
  });

  test("a turn whose usage follows a call, or whose reply has no usage after it, keeps both its rows", async () => {
    const recorded = recordedEvents("claude-code");
    const usage = recorded.at(-1)!;
    const { loop, rows } = subscriptionLoop([...recorded.slice(0, 3), usage]);
    await loop.generator.generate("r_1", 1);
    assert.deepEqual(rows().map((row) => [row.payload.role, row.payload.content, row.metadata.cost_source]), [
      ["assistant", "I'll look at the greeting first.", undefined],
      ["tool", "1\tprint('hello')\n", undefined],
      ["assistant", "", "subscription"],
    ], "with no reply held, an empty reply records the usage");

    const unfinished = subscriptionLoop(recorded.slice(0, -1));
    await unfinished.loop.generator.generate("r_1", 1);
    const reply = unfinished.rows().at(-1);
    assert.match(String(reply?.payload.content), /Should the greeting also name the agent\?$/, "the held reply is kept when the turn ends");
    assert.equal(reply?.metadata.usage, undefined);
  });

  test("a cancel stops the CLI mid-tool, and the call it was in gets the interrupted result", async () => {
    const { loop, rows, errors, bin } = subscriptionLoop([...recordedEvents("claude-code").slice(0, 2), HANG]);
    await loop.beginGeneration("r_1", "a_1");
    loop.generateInBackground("r_1", 1);
    await until(() => rows().length > 0);
    await loop.cancel("r_1");
    assert.equal(stubsRunning(bin), false, "the CLI was stopped");
    const kept = rows();
    assert.deepEqual(kept.map((row) => row.payload.role), ["assistant", "tool"]);
    assert.equal(kept[1]?.payload.content, INTERRUPTED_CONTENT);
    assert.equal(kept[1]?.metadata.from_harness, "claude-code");
    assert.equal(errors().at(-1)?.operation, "generation.cancelled");
  });

  test("a CLI that fails ends the generation with harness.failed, keeping what it wrote", async () => {
    const stub = subscriptionLoop(recordedEvents("claude-code"));
    stub.sandbox.env.HARNESS_STUB_EXIT = "1";
    await stub.loop.generator.generate("r_1", 1);
    assert.equal(stub.errors().at(-1)?.operation, "harness.failed");
    assert.match(String(stub.errors().at(-1)?.message), /^Claude Code's turn failed \(error: exited with code 1\)$/);
    assert.equal(stub.rows().length, 7);
  });

  test("a turn past its agent's max_turn_minutes is stopped and ends the generation with harness.timed_out", async () => {
    harnessTurnTiming.minuteMs = 20;
    try {
      const { loop, db, rows, errors, bin } = subscriptionLoop([...recordedEvents("claude-code").slice(0, 2), HANG]);
      db.run.config_snapshot = { ...(db.run.config_snapshot as Record<string, unknown>), max_turn_minutes: 50 };
      const started = Date.now();
      await loop.generator.generate("r_1", 1);
      assert.ok(Date.now() - started >= 1000, "the turn ran its fifty minutes");
      assert.equal(errors().at(-1)?.operation, "harness.timed_out");
      assert.match(String(errors().at(-1)?.message), /^Claude Code was stopped after 50 minutes\. The run's next turn resumes its session\.$/);
      assert.equal(stubsRunning(bin), false);
      assert.equal(rows().at(-1)?.payload.content, INTERRUPTED_CONTENT);
    } finally {
      harnessTurnTiming.minuteMs = timing.minuteMs;
    }
  });

  test("a sandbox that stops answering polls stops the CLI and ends the generation with harness.unresponsive", async () => {
    const { loop, sandbox, errors, bin } = subscriptionLoop([...recordedEvents("claude-code").slice(0, 2), HANG]);
    failOp(sandbox, "poll", "the sandbox is not answering");
    await loop.generator.generate("r_1", 1);
    assert.equal(errors().at(-1)?.operation, "harness.unresponsive");
    assert.match(String(errors().at(-1)?.message), /^Claude Code stopped answering, so it was stopped\./);
    assert.equal(stubsRunning(bin), false);
  });

  test("a turn whose state is gone ends the generation with harness.lost", async () => {
    const { loop, sandbox, errors } = subscriptionLoop(recordedEvents("claude-code"));
    answerOps(sandbox, { poll: { missing: true } });
    await loop.generator.generate("r_1", 1);
    assert.equal(errors().at(-1)?.operation, "harness.lost");
    assert.match(String(errors().at(-1)?.message), /^Claude Code's state is gone: the machine restarted/);
  });

  test("a CLI that does not start ends the generation with harness.start", async () => {
    const { loop, sandbox, errors, calls, rows } = subscriptionLoop(recordedEvents("claude-code"));
    failOp(sandbox, "start", "claude is not installed in this image");
    await loop.generator.generate("r_1", 1);
    assert.equal(errors().at(-1)?.operation, "harness.start");
    assert.match(String(errors().at(-1)?.message), /^Claude Code did not start: claude is not installed in this image$/);
    assert.equal(calls().length, 0);
    assert.equal(rows().length, 0);
  });

  test("a harness without a credential fails at start, as a coding agent's does", async () => {
    const { loop, errors, calls } = subscriptionLoop(recordedEvents("claude-code"), { installed: true, version: "9.9.9", credential: null });
    await loop.generator.generate("r_1", 1);
    assert.equal(errors().at(-1)?.operation, "harness.credential");
    assert.equal(calls().length, 0);
  });

  test("a subscription agent on a harness that runs no turn fails at start, before its machine wakes", async () => {
    const { loop, db, errors, machines } = subscriptionLoop(recordedEvents("claude-code"));
    db.run.config_snapshot = { ...(db.run.config_snapshot as Record<string, unknown>), harness: "cursor" };
    await loop.generator.generate("r_1", 1);
    assert.equal(errors().at(-1)?.operation, "subscription.not_runnable");
    assert.match(String(errors().at(-1)?.message), /^Cursor cannot run a subscription agent: pick Claude Code or Codex/);
    assert.equal(machines.length, 0);
  });
});

describe("a turn lost with the orchestrator", () => {
  test("is ended at boot: its harness stopped, its open call interrupted, its session kept for the next turn", async () => {
    const { loop, db, sandbox, sandboxes, rows, bin, calls } = subscriptionLoop([...recordedEvents("claude-code").slice(0, 2), HANG]);
    // What the process that died left: a started turn on the machine, its first row, and its record.
    const ctx = toolFixture({ run_id: "r_1", agent_id: "a_1", guild_id: "g_1", sandbox, secrets: {} });
    await runCodeHelper(ctx.run, createToolHooks(), { op: "start", call_id: "turn_1_r_1", harness: "claude-code", prompt: "use bash twice" }, { helper: HARNESS_HELPER });
    await until(() => calls().length > 0);
    const call = { id: "toolu_01", type: "function", function: { name: "Read", arguments: "{}" } };
    db.messages.push({ id: 3, seq: 2, payload: { role: "assistant", content: "I'll look.", tool_calls: [call] }, metadata: { generation: 1, from_harness: "claude-code" }, created_at: new Date() });
    db.run.metadata = { harness_turn: { call_id: "turn_1_r_1", harness: "claude-code", session_id: null, log_path: ".runs/r_1/turn_1_r_1.harness.jsonl" } };
    sandboxes.running.add("mach_1");
    await new Promise((resolve) => setTimeout(resolve, 300));

    await loop.reconcile();

    assert.equal(stubsRunning(bin), false, "the harness that kept running is stopped");
    const last = rows().at(-1);
    assert.deepEqual(last?.payload, { role: "tool", tool_call_id: "toolu_01", content: INTERRUPTED_CONTENT });
    assert.equal(last?.metadata.from_harness, "claude-code");
    assert.equal((db.run.metadata as { harness_turn?: { session_id: string | null } }).harness_turn?.session_id, RECORDED_SESSION);
    assert.equal(db.run.status, "active", "a direct run stays open for its next message");
  });

  test("is left alone when its machine is not running, its open call still interrupted", async () => {
    const { loop, db, rows } = subscriptionLoop(recordedEvents("claude-code"));
    const call = { id: "toolu_01", type: "function", function: { name: "Read", arguments: "{}" } };
    db.messages.push({ id: 3, seq: 2, payload: { role: "assistant", content: "", tool_calls: [call] }, metadata: { generation: 1, from_harness: "claude-code" }, created_at: new Date() });
    db.run.metadata = { harness_turn: { call_id: "turn_1_r_1", harness: "claude-code", session_id: "s_1", log_path: ".runs/r_1/turn_1_r_1.harness.jsonl" } };
    await loop.reconcile();
    assert.equal(rows().at(-1)?.metadata.from_harness, "claude-code");
    assert.equal((db.run.metadata as { harness_turn?: { session_id: string | null } }).harness_turn?.session_id, "s_1");
  });
});

describe("a harness turn's prompt and outcome", () => {
  const row = (seq: number, payload: Record<string, unknown>, metadata: Record<string, unknown> = {}): MessageRow =>
    ({ id: seq, run_id: "r", seq, payload, metadata, created_at: "", cost_usd: null }) as unknown as MessageRow;
  const image = (id: string, filename: string) => ({ id, filename, mime: "image/png", kind: "image" });

  test("the prompt is the user messages since the run's last reply, after the system prompt", () => {
    const rows = [
      row(0, { role: "system", content: "sys" }),
      row(1, { role: "user", content: "first" }),
      row(2, { role: "assistant", content: "done" }),
      row(3, { role: "user", content: "second" }),
      row(4, { role: "user", content: "third" }),
    ];
    assert.deepEqual(harnessTurnPrompt(rows, "/home/a_1"), { system: "sys", prompt: "second\n\nthird" });
    assert.deepEqual(harnessTurnPrompt(rows.slice(0, 2), "/home/a_1"), { system: "sys", prompt: "first" });
  });

  test("each image of the opening messages is named by its path in the agent's home, under the message it came with", () => {
    const rows = [
      row(0, { role: "system", content: "sys" }),
      row(1, { role: "user", content: "old" }, { attachments: [image("att_old", "old.png")] }),
      row(2, { role: "assistant", content: "done" }),
      row(3, { role: "user", content: "What is on these?" }, { attachments: [image("att_1", "shot.png"), image("att_2", "chart.png")] }),
      row(4, { role: "user", content: "" }, { attachments: [image("att_3", "only.png")] }),
    ];
    assert.deepEqual(harnessTurnPrompt(rows, "/home/a_1").prompt, [
      "What is on these?",
      "Attached image: /home/a_1/.runs/r/attachments/att_1/shot.png",
      "Attached image: /home/a_1/.runs/r/attachments/att_2/chart.png",
      "",
      "Attached image: /home/a_1/.runs/r/attachments/att_3/only.png",
    ].join("\n"));
    assert.deepEqual(openingAttachments(rows).map((ref) => ref.id), ["att_1", "att_2", "att_3"], "the images of earlier generations are not placed again");
    assert.equal(attachmentHomePath("r_1", image("att_1", "shot.png") as AttachmentRef), ".runs/r_1/attachments/att_1/shot.png");
  });

  test("each way a turn ends names its run error, and a clean exit none", () => {
    const failure = (ending: Parameters<typeof harnessTurnFailure>[1]) => harnessTurnFailure("claude-code", ending, ".runs/r/t.harness.jsonl", 30);
    assert.equal(failure({ settled: "exited", stopped: null, result: { exit_code: 0, is_error: false } }), null);
    assert.equal(failure({ settled: "exited", stopped: null, result: { exit_code: 0, is_error: true, events: 3, error: "Not logged in" } })?.code, "harness.failed");
    assert.equal(failure({ settled: "missing", stopped: null, result: null })?.code, "harness.lost");
    assert.equal(failure({ settled: "unreadable", stopped: null, result: null })?.code, "harness.lost");
    assert.equal(failure({ settled: "unresponsive", stopped: true, result: null })?.code, "harness.unresponsive");
    assert.equal(failure({ settled: "cancelled", stopped: true, result: null }), null);
    const unstopped = failure({ settled: "timed_out", stopped: false, result: null });
    assert.equal(unstopped?.code, "harness.timed_out");
    assert.match(String(unstopped?.message), /It did not stop and may still be running; its log is \.runs\/r\/t\.harness\.jsonl\.$/);
  });
});
