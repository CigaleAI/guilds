import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { generationLive } from "../../src/generation/completion.js";
import { logOperationFailure } from "../../src/generation/errors.js";
import { DeliveryBusyError, DeliveryCreateError } from "../../src/groupchat/delivery.js";
import { sleep } from "../../src/lib/event.js";
import { McpPool } from "../../src/mcp/pool.js";
import { logWriter } from "../../src/observability/log.js";
import { SandboxError, type SandboxHandle } from "../../src/sandbox/sdk.js";
import { withRemainingToolCalls } from "../../src/toolbox/index.js";
import { tempDir } from "../helpers/env.js";
import {
  AGENT_CONFIG,
  AGENT_MACHINE,
  completionReply,
  deferred,
  FakeCommands,
  FakeDB,
  FakeSandboxes,
  fakeStream,
  hangForever,
  makeLoop,
  scheduleRow,
  seededLoop,
} from "../helpers/generation.js";
import { MemoryMcpDatabase } from "../helpers/mcp-database.js";
import { connectionRow, serverRow } from "../helpers/servers.js";
import type { ModelEndpoint, ModelRequest } from "../../src/llm/completion.js";

const live = generationLive;
const originalStream = live.streamCompletion;
const originalGrace = live.cancelGraceMs;

function restoreLive(): void {
  live.streamCompletion = originalStream;
  live.cancelGraceMs = originalGrace;
}

after(restoreLive);

type LogLine = Record<string, unknown>;

/** The JSON log lines written while `work` runs. */
async function loggedLines(work: () => Promise<unknown>): Promise<LogLine[]> {
  const chunks: string[] = [];
  const originalWrite = logWriter.write;
  logWriter.write = (chunk: string) => {
    chunks.push(chunk);
  };
  try {
    await work();
  } finally {
    logWriter.write = originalWrite;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as LogLine);
}

/** The line logged for `operation`; fails when there is none. */
function lineFor(lines: LogLine[], operation: string): LogLine {
  const line = lines.find((item) => item.operation === operation);
  assert.ok(line, `a line for ${operation}`);
  return line;
}

/** A sandbox whose command interrupt fails, as when its daemon is gone. */
function sandboxFailingInterrupt(): SandboxHandle {
  return {
    id: "sbx_fake",
    commands: {
      ...new FakeCommands(),
      async interrupt() {
        throw new SandboxError("sandbox daemon is gone");
      },
    },
  } as unknown as SandboxHandle;
}

describe("generation failures carried on past", { concurrency: 1 }, () => {
  test("logs_an_operation_failure_with_its_error_type_and_nothing_for_none", async () => {
    const lines = await loggedLines(async () => {
      logOperationFailure(null);
      logOperationFailure(
        { message: "sandbox destroy failed", fields: { machine_id: "mach_1", operation: "sandbox.refresh" }, error: new SandboxError("gone") },
        "warn",
      );
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, "warn");
    assert.equal(lines[0]?.message, "sandbox destroy failed");
    assert.equal(lines[0]?.machine_id, "mach_1");
    assert.equal(lines[0]?.operation, "sandbox.refresh");
    assert.equal(lines[0]?.error_type, "SandboxError");
  });

  test("a_cancel_whose_command_interrupt_fails_logs_it_and_still_cancels", async () => {
    const loop = makeLoop(new FakeDB({}), {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await loop.beginGeneration("r_1", "a_1");
    loop.generations.trackCommand("r_1", sandboxFailingInterrupt(), "exec_1");
    let view: Record<string, unknown> | null = null;
    const lines = await loggedLines(async () => {
      view = await loop.cancel("r_1");
    });
    assert.ok(view);
    assert.ok(loop.generations.isCancelled("r_1"));
    const line = lineFor(lines, "command.interrupt");
    assert.equal(line.run_id, "r_1");
    assert.equal(line.agent_id, "a_1");
    assert.equal(line.error_type, "SandboxError");
    loop.endGeneration("r_1");
  });

  test("closing_the_loop_logs_a_command_interrupt_that_fails_and_still_closes", async () => {
    const loop = makeLoop(new FakeDB({}), {}, tempDir("guilds-gen-"), new FakeSandboxes());
    await loop.beginGeneration("r_1", "a_1");
    loop.generations.trackCommand("r_1", sandboxFailingInterrupt(), "exec_1");
    const lines = await loggedLines(() => loop.close());
    assert.ok(loop.generations.isCancelled("r_1"));
    assert.equal(lineFor(lines, "command.interrupt").run_id, "r_1");
    loop.endGeneration("r_1");
  });

  test("a_cancel_whose_settlement_fails_logs_it_and_the_generation_still_finishes", async () => {
    restoreLive();
    const { loop } = await seededLoop();
    const started = deferred();
    live.streamCompletion = async function* hang(_request: ModelRequest, _endpoint: ModelEndpoint, signal?: AbortSignal) {
      started.resolve();
      await hangForever(signal);
      yield ["done", completionReply("nope")];
    };
    loop.generator.recordCancel = async () => {
      throw new Error("run store unavailable");
    };
    const created = await loop.runs.createRun("a_1", "hello");
    const runId = String(created.id);
    const queue = loop.events.subscribe(runId);
    await started.promise;
    const lines = await loggedLines(() => loop.cancel(runId));
    const line = lineFor(lines, "generation.cancelled");
    assert.equal(line.message, "cancel settlement failed");
    assert.equal(line.run_id, runId);
    assert.ok(!loop.generations.isGenerating(runId));
    const names: string[] = [];
    while (!queue.empty()) {
      names.push((await queue.get())[0]);
    }
    assert.ok(names.includes("generation.finished"));
    restoreLive();
  });

  test("a_workspace_measure_that_fails_is_logged_as_a_warning_and_the_run_keeps_no_error", async () => {
    restoreLive();
    const { loop, db } = await seededLoop();
    db.setAgentWorkspaceMib = async () => {
      throw new Error("workspace size store unavailable");
    };
    live.streamCompletion = async function* reply() {
      yield ["done", completionReply()];
    };
    const lines = await loggedLines(async () => {
      const created = await loop.runs.createRun("a_1", "hello");
      await loop.generations.task(String(created.id));
    });
    const line = lineFor(lines, "workspace.measure");
    assert.equal(line.level, "warn");
    assert.equal(line.agent_id, "a_1");
    assert.deepEqual(db.run?.errors, []);
    restoreLive();
  });

  test("a_connection_tool_call_that_fails_is_its_result_and_is_logged", async () => {
    restoreLive();
    const db = new FakeDB({
      tools: [{ type: "function" as const, function: { name: "notion_search", arguments: "{}" } }],
      mcp: [
        {
          connection_id: "conn_u",
          server_id: "mcp_notion",
          slug: "notion",
          tools: [{ name: "notion_search", remote_name: "search" }],
        },
      ],
    });
    db.mcp_connection = { id: "conn_u", mcp_server_id: "mcp_notion", status: "connected" };
    db.mcp_server = { id: "mcp_notion", slug: "notion" };
    const database = new MemoryMcpDatabase();
    database.connections = [connectionRow({ id: "conn_u", mcp_server_id: "mcp_notion" })];
    database.servers = [serverRow("notion", { id: "mcp_notion" })];
    const pool = new McpPool(database);
    pool.call = async () => {
      throw new Error("notion is down");
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes(), { mcp: pool });
    live.streamCompletion = fakeStream(db, [
      { id: "call_1", type: "function" as const, function: { name: "notion_search", arguments: '{"query":"notes"}' } },
    ]);
    const lines = await loggedLines(() => loop.generator.generate("r_1", 1));
    const tool = db.messages.find((row) => (row.payload as Record<string, unknown>).role === "tool");
    assert.ok(tool);
    assert.equal((tool.payload as Record<string, unknown>).content, withRemainingToolCalls("ERROR: notion is down", 49));
    assert.equal((tool.metadata as Record<string, unknown>).error, "notion is down");
    const line = lineFor(lines, "tool.notion_search");
    assert.equal(line.level, "warn");
    assert.equal(line.message, "notion is down");
    restoreLive();
  });

  test("a_schedule_wake_up_that_fails_is_logged_and_the_schedule_moves_on", async () => {
    const { loop, db } = await seededLoop();
    db.due_schedules = [scheduleRow()];
    loop.runs.deliverScheduleRun = async () => {
      throw new Error("prompt store unavailable");
    };
    const lines = await loggedLines(() => loop.runs.fireDueSchedules(new Date()));
    assert.equal(db.fired[0]?.id, "sch_1");
    const line = lineFor(lines, "schedule.fire");
    assert.equal(line.message, "schedule wake-up failed");
    assert.equal(line.agent_id, "a_1");
  });

  test("a_schedule_whose_run_cannot_be_created_logs_the_refusal_and_moves_on", async () => {
    const { loop, db } = await seededLoop();
    db.due_schedules = [scheduleRow()];
    loop.runs.deliverScheduleRun = async () => {
      throw new DeliveryCreateError("agent config is invalid");
    };
    const lines = await loggedLines(() => loop.runs.fireDueSchedules(new Date()));
    assert.equal(db.fired[0]?.id, "sch_1");
    assert.equal(lineFor(lines, "schedule.fire").message, "agent config is invalid");
  });

  test("a_schedule_whose_agent_becomes_busy_stays_due_without_a_log", async () => {
    const { loop, db } = await seededLoop();
    db.due_schedules = [scheduleRow()];
    loop.runs.deliverScheduleRun = async () => {
      throw new DeliveryBusyError();
    };
    const lines = await loggedLines(() => loop.runs.fireDueSchedules(new Date()));
    assert.deepEqual(db.fired, []);
    assert.equal(lines.filter((line) => line.operation === "schedule.fire").length, 0);
  });

  test("a_schedule_tick_that_fails_is_logged_and_the_next_tick_still_runs", async () => {
    const db = new FakeDB({});
    let ticks = 0;
    db.listDueSchedules = async () => {
      ticks += 1;
      if (ticks === 1) {
        throw new Error("schedule store unavailable");
      }
      return [];
    };
    const loop = makeLoop(db, {}, tempDir("guilds-gen-"), new FakeSandboxes(), { schedulerTickMs: 5 });
    const lines = await loggedLines(async () => {
      loop.runs.startScheduler();
      for (let wait = 0; wait < 100 && ticks < 2; wait += 1) {
        await sleep(5);
      }
      await loop.runs.stopScheduler();
    });
    assert.ok(ticks >= 2, "a tick after the failed one");
    assert.equal(lineFor(lines, "schedule.tick").message, "schedule tick failed");
  });

  test("an_idle_stop_that_fails_is_logged", async () => {
    const sandboxes = new FakeSandboxes();
    sandboxes.destroy = async () => {
      throw new SandboxError("provider unavailable");
    };
    const loop = makeLoop(new FakeDB({}), {}, tempDir("guilds-gen-"), sandboxes, { idleTimeoutMs: 20 });
    await loop.beginGeneration("r_1", "a_1");
    loop.endGeneration("r_1");
    const lines = await loggedLines(async () => {
      await loop.machines.idle.get("mach_1")?.promise;
    });
    const line = lineFor(lines, "sandbox.idle.stop");
    assert.equal(line.machine_id, "mach_1");
    assert.equal(line.error_type, "SandboxError");
    assert.ok(!loop.machines.idle.has("mach_1"));
  });

  test("a_machine_change_that_cannot_destroy_its_container_is_logged_and_the_machine_stays_stale", async () => {
    const sandboxes = new FakeSandboxes();
    sandboxes.destroy = async () => {
      throw new SandboxError("provider unavailable");
    };
    const loop = makeLoop(new FakeDB({}), {}, tempDir("guilds-gen-"), sandboxes);
    const lines = await loggedLines(() => loop.machines.machineChanged("mach_2"));
    assert.ok(loop.machines.stale.has("mach_2"), "the next ensure replaces it");
    assert.equal(lineFor(lines, "sandbox.refresh").machine_id, "mach_2");
  });

  test("a_deleted_machine_whose_container_does_not_go_is_logged_and_left_to_its_idle_stop", async () => {
    const root = tempDir("guilds-gen-");
    mkdirSync(path.join(root, "mach_2"), { recursive: true });
    const sandboxes = new FakeSandboxes();
    sandboxes.destroy = async () => {
      throw new SandboxError("provider unavailable");
    };
    const loop = makeLoop(new FakeDB({}), {}, root, sandboxes, { idleTimeoutMs: 60_000 });
    const lines = await loggedLines(() => loop.machines.deleteMachine("mach_2"));
    assert.ok(loop.machines.idle.has("mach_2"));
    assert.ok(!existsSync(path.join(root, "mach_2")), "its directory goes");
    assert.equal(lineFor(lines, "machine.delete").machine_id, "mach_2");
    loop.machines.cancelTimers();
  });

  test("a_browser_stop_that_fails_is_logged", async () => {
    const sandboxes = new FakeSandboxes();
    sandboxes.running.add("mach_1");
    sandboxes.stopBrowser = async () => {
      throw new SandboxError("agent-stop failed");
    };
    const loop = makeLoop(new FakeDB({}), {}, tempDir("guilds-gen-"), sandboxes);
    const lines = await loggedLines(() => loop.machines.agentBrowserChanged("a_1"));
    assert.equal(lineFor(lines, "browser.stop").agent_id, "a_1");
  });

  test("deleting_an_agent_whose_processes_do_not_stop_logs_it_and_still_removes_its_home_and_rows", async () => {
    const root = tempDir("guilds-gen-");
    const workspace = path.join(root, "mach_1", "a_1");
    mkdirSync(workspace, { recursive: true });
    const purged: string[] = [];
    const db = {
      async getAgent(agentId: string) {
        return agentId === "a_1"
          ? { id: "a_1", name: "researcher", guild_name: "research", org_slug: "acme", config: AGENT_CONFIG, ...AGENT_MACHINE }
          : null;
      },
      async deleteAgent(agentId: string) {
        purged.push(agentId);
      },
    };
    const notes = { async deleteAgent() {} };
    const sandboxes = new FakeSandboxes();
    sandboxes.running.add("mach_1");
    sandboxes.purgeAgent = async () => {
      throw new SandboxError("agent-stop failed");
    };
    const loop = makeLoop(db, notes, root, sandboxes);
    const lines = await loggedLines(() => loop.deleteAgent("a_1"));
    assert.deepEqual(purged, ["a_1"]);
    assert.ok(!existsSync(workspace));
    const line = lineFor(lines, "agent.stop");
    assert.equal(line.agent_id, "a_1");
    assert.equal(line.machine_id, "mach_1");
  });
});
