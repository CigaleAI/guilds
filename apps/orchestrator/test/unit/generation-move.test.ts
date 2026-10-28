import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RunRequestError } from "../../src/generation/index.js";
import { tempDir } from "../helpers/env.js";
import { FakeDB, FakeSandboxes, makeLoop } from "../helpers/generation.js";

type MoveCall = { agentId: string; machineId: string; options: unknown };

/** A FakeDB whose agent a_1 sits on mach_1, and that records the moves it is asked for. */
function movableDb(result: "moved" | "gone" | Error = "moved"): FakeDB & { moves: MoveCall[] } {
  const db = new FakeDB({}) as FakeDB & { moves: MoveCall[]; moveAgent?: unknown };
  db.moves = [];
  db.moveAgent = async (agentId: string, machineId: string, options?: unknown) => {
    db.moves.push({ agentId, machineId, options });
    if (result instanceof Error) {
      throw result;
    }
    return result === "gone" ? null : { from: { machineId: "mach_1", slot: 0 }, to: { machineId, slot: 0 } };
  };
  return db;
}

function home(root: string, machineId: string): string {
  const dir = path.join(root, machineId, "a_1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notes.txt"), "kept");
  return dir;
}

const refusal = (status: number, pattern: RegExp) => (error: unknown) =>
  error instanceof RunRequestError && error.status === status && pattern.test(error.message);

test("a move stops the agent on the machine it leaves and carries its home to the other", async () => {
  const root = tempDir("guilds-move-");
  home(root, "mach_1");
  const db = movableDb();
  const sandboxes = new FakeSandboxes();
  sandboxes.running.add("mach_1");
  const loop = makeLoop(db, {}, root, sandboxes);
  await loop.machines.moveAgent("a_1", "mach_2", { maxAgentsPerMachine: 4, needs: { browser: false, coding: false } });
  assert.deepEqual(db.moves, [{ agentId: "a_1", machineId: "mach_2", options: { maxAgentsPerMachine: 4, needs: { browser: false, coding: false } } }]);
  assert.deepEqual(sandboxes.stopped, [{ agentId: "a_1", what: "purge" }]);
  assert.equal(existsSync(path.join(root, "mach_1", "a_1")), false);
  assert.equal(readFileSync(path.join(root, "mach_2", "a_1", "notes.txt"), "utf8"), "kept");
  assert.equal(loop.isAgentBusy("a_1"), false);
});

test("a move onto the machine the agent sits on does nothing", async () => {
  const root = tempDir("guilds-move-");
  home(root, "mach_1");
  const db = movableDb();
  const sandboxes = new FakeSandboxes();
  sandboxes.running.add("mach_1");
  await makeLoop(db, {}, root, sandboxes).machines.moveAgent("a_1", "mach_1");
  assert.deepEqual(db.moves, []);
  assert.deepEqual(sandboxes.stopped, []);
  assert.equal(existsSync(path.join(root, "mach_1", "a_1", "notes.txt")), true);
});

test("a move is refused for an unknown agent and a busy one", async () => {
  const root = tempDir("guilds-move-");
  const db = movableDb();
  const loop = makeLoop(db, {}, root, new FakeSandboxes());
  await assert.rejects(() => loop.machines.moveAgent("a_404", "mach_2"), refusal(404, /agent not found/));
  await loop.beginGeneration("r_1", "a_1");
  await assert.rejects(() => loop.machines.moveAgent("a_1", "mach_2"), refusal(409, /already generating/));
  loop.endGeneration("r_1");
  assert.deepEqual(db.moves, []);
});

test("a move is refused across workspace roots and onto a home already on the target", async () => {
  const root = tempDir("guilds-move-");
  home(root, "mach_1");
  const db = movableDb();
  const sandboxes = new FakeSandboxes() as FakeSandboxes & { machineHost?: unknown };
  sandboxes.machineHost = async (machineId: string) => ({
    hostId: machineId === "mach_far" ? "host_2" : "host_1",
    workspaceRoot: machineId === "mach_far" ? path.join(root, "elsewhere") : root,
    proxyUrl: "http://proxy.test",
  });
  const loop = makeLoop(db, {}, root, sandboxes);
  await assert.rejects(() => loop.machines.moveAgent("a_1", "mach_far"), refusal(409, /different hosts/));
  home(root, "mach_2");
  await assert.rejects(() => loop.machines.moveAgent("a_1", "mach_2"), refusal(409, /already holds a home/));
  assert.deepEqual(db.moves, []);
  assert.equal(existsSync(path.join(root, "mach_1", "a_1", "notes.txt")), true);
  assert.equal(loop.isAgentBusy("a_1"), false);
});

test("a home that moved goes back when the database refuses the move", async () => {
  for (const result of [new RunRequestError(409, "mach_2 is full"), "gone"] as const) {
    const root = tempDir("guilds-move-");
    home(root, "mach_1");
    const loop = makeLoop(movableDb(result), {}, root, new FakeSandboxes());
    await assert.rejects(
      () => loop.machines.moveAgent("a_1", "mach_2"),
      result === "gone" ? refusal(404, /agent not found/) : refusal(409, /mach_2 is full/),
    );
    assert.equal(readFileSync(path.join(root, "mach_1", "a_1", "notes.txt"), "utf8"), "kept");
    assert.equal(existsSync(path.join(root, "mach_2", "a_1")), false);
    assert.equal(loop.isAgentBusy("a_1"), false);
  }
});

test("an agent with no home yet moves without one", async () => {
  const root = tempDir("guilds-move-");
  const db = movableDb();
  await makeLoop(db, {}, root, new FakeSandboxes()).machines.moveAgent("a_1", "mach_2");
  assert.equal(db.moves.length, 1);
  assert.equal(existsSync(path.join(root, "mach_2", "a_1")), false);
});
