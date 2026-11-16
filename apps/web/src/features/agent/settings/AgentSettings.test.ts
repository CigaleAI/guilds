import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHarness, Machine } from "../../../api/types/agents";
import { handleHint } from "../../../app/names";
import {
  carriedHarnesses,
  machineHint,
  machineMove,
  readinessProblems,
  readinessTitle,
  settingsNameError,
} from "./AgentSettings";

const machine: Machine = {
  id: "m_2",
  name: "code-1",
  box: "code",
  cpu: 4,
  memory_mib: 8192,
  max_workspace_mib: 40960,
  workspace_mib: null,
  allocated_workspace_mib: 0,
  planned_cpu: 0,
  planned_mib: 0,
  agents: [],
  hidden_agents: 0,
  harnesses: ["codex"],
};

const status: AgentHarness = {
  harness: null,
  harness_model: null,
  harness_effort: null,
  harnesses: [],
  machine_harnesses: ["claude-code"],
  repositories: [],
  usable_repositories: [],
};

test("an empty name reads as the rule a name follows", () => {
  assert.equal(settingsNameError("  "), handleHint);
  assert.equal(settingsNameError("researcher"), undefined);
});

test("saving moves the agent only to a machine other than its own", () => {
  assert.equal(machineMove(machine, "m_1"), "m_2");
  assert.equal(machineMove(machine, "m_2"), undefined);
  assert.equal(machineMove(undefined, "m_1"), undefined);
});

test("the harnesses carried are the new machine's on a move, else the harness check's", () => {
  assert.deepEqual(carriedHarnesses(machine, "m_2", status), ["codex"]);
  assert.deepEqual(carriedHarnesses(machine, undefined, status), ["claude-code"]);
  assert.deepEqual(carriedHarnesses(machine, undefined, undefined), ["codex"]);
});

test("the machine's hint says a move happens on save, or what a coding or subscription agent needs", () => {
  assert.match(machineHint("m_2", "coding") ?? "", /^Saving moves the agent/);
  assert.equal(machineHint(undefined, "coding"), "Coding agents need a Code machine.");
  assert.equal(machineHint(undefined, "subscription"), "Subscription agents need a Code machine.");
  assert.equal(machineHint(undefined, "key"), undefined);
});

test("a saved coding agent's readiness needs repositories; a subscription agent's only its harness", () => {
  assert.deepEqual(readinessProblems("coding", status), [
    { kind: "harness" },
    { kind: "repositories" },
  ]);
  assert.deepEqual(readinessProblems("subscription", status), [{ kind: "harness" }]);
  assert.deepEqual(readinessProblems("key", status), []);
  assert.deepEqual(readinessProblems("coding", undefined), []);
  assert.equal(readinessTitle("coding"), "Coding isn't ready");
  assert.equal(readinessTitle("subscription"), "The subscription isn't ready");
});
