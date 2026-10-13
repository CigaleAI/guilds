import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyWorkspaceSweep, parseSweepArgs, planWorkspaceSweep } from "../../src/sandbox/sweep.js";
import { tempDir } from "../helpers/env.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T12:00:00Z");

/** Makes a directory whose last change is `days` before NOW. */
function dirAged(full: string, days: number): string {
  mkdirSync(full, { recursive: true });
  const at = new Date(NOW.getTime() - days * DAY_MS);
  utimesSync(full, at, at);
  return full;
}

test("a dead machine's directory goes once nothing changed for the cutoff, and stays before it", () => {
  const root = tempDir("guilds-sweep-");
  dirAged(path.join(root, "mach_old", "a_9"), 0);
  dirAged(path.join(root, "mach_old"), 10);
  dirAged(path.join(root, "mach_recent"), 3);
  const plan = planWorkspaceSweep(root, new Map(), 7, NOW);
  assert.deepEqual(plan, [{ path: path.join(root, "mach_old"), machineId: "mach_old", agentId: null, ageDays: 10 }]);
  assert.deepEqual(planWorkspaceSweep(root, new Map(), 11, NOW), []);
});

test("in a live machine, an orphan home goes and a live agent's home stays, however old", () => {
  const root = tempDir("guilds-sweep-");
  dirAged(path.join(root, "mach_1", "a_gone"), 30);
  dirAged(path.join(root, "mach_1", "a_live"), 30);
  dirAged(path.join(root, "mach_1", "a_fresh_orphan"), 1);
  dirAged(path.join(root, "mach_1"), 30);
  const machines = new Map([["mach_1", new Set(["a_live"])]]);
  assert.deepEqual(planWorkspaceSweep(root, machines, 7, NOW), [
    { path: path.join(root, "mach_1", "a_gone"), machineId: "mach_1", agentId: "a_gone", ageDays: 30 },
  ]);
});

test("files are ignored, at the root and in a live machine", () => {
  const root = tempDir("guilds-sweep-");
  const machines = new Map([["mach_1", new Set<string>()]]);
  mkdirSync(path.join(root, "mach_1"));
  writeFileSync(path.join(root, "stray.txt"), "x");
  writeFileSync(path.join(root, "mach_1", "notes.txt"), "x");
  writeFileSync(path.join(root, "mach_2"), "a file named like a live machine");
  const old = new Date(NOW.getTime() - 30 * DAY_MS);
  for (const file of ["stray.txt", path.join("mach_1", "notes.txt")]) {
    utimesSync(path.join(root, file), old, old);
  }
  assert.deepEqual(planWorkspaceSweep(root, machines, 7, NOW), []);
  assert.deepEqual(planWorkspaceSweep(root, new Map([["mach_2", new Set<string>()]]), 7, NOW), []);
});

test("a root folder named for a live agent is its home before the boot step moves it, and stays", () => {
  const root = tempDir("guilds-sweep-");
  dirAged(path.join(root, "a_live"), 90);
  dirAged(path.join(root, "a_dead"), 90);
  const machines = new Map([["mach_1", new Set(["a_live"])]]);
  assert.deepEqual(
    planWorkspaceSweep(root, machines, 7, NOW).map((entry) => entry.path),
    [path.join(root, "a_dead")],
  );
});

test("a missing workspace root plans nothing, and applying a plan removes each folder", () => {
  const root = tempDir("guilds-sweep-");
  assert.deepEqual(planWorkspaceSweep(path.join(root, "absent"), new Map(), 0, NOW), []);
  dirAged(path.join(root, "mach_b", "a_1"), 20);
  dirAged(path.join(root, "mach_b"), 20);
  dirAged(path.join(root, "mach_a"), 20);
  const plan = planWorkspaceSweep(root, new Map(), 7, NOW);
  assert.deepEqual(plan.map((entry) => entry.machineId), ["mach_a", "mach_b"], "sorted by path");
  assert.deepEqual(applyWorkspaceSweep(plan), [path.join(root, "mach_a"), path.join(root, "mach_b")]);
  assert.equal(existsSync(path.join(root, "mach_a")), false);
  assert.equal(existsSync(path.join(root, "mach_b")), false);
});

test("the sweep takes --age-days N, a non-negative integer, and --apply", () => {
  assert.deepEqual(parseSweepArgs(["--age-days", "7"]), { ageDays: 7, apply: false });
  assert.deepEqual(parseSweepArgs(["--apply", "--age-days", "0"]), { ageDays: 0, apply: true });
  for (const argv of [[], ["--apply"], ["--age-days"], ["--age-days", "-1"], ["--age-days", "1.5"], ["--age-days", "x"], ["--age-days", "3", "--force"]]) {
    assert.throws(() => parseSweepArgs(argv), /usage: sweep-workspaces\.ts --age-days N \[--apply\]/, argv.join(" "));
  }
});
