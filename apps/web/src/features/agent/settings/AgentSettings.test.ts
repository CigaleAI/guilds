import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHarness, Machine } from "../../../api/types/agents";
import { handleHint } from "../../names";
import {
  carriedHarnesses,
  machineHint,
  machineMove,
  readinessProblems,
  settingsNameError,
} from "./AgentSettings";
import { defaultAgentConfig } from "./configForm";

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

test("the machine's hint says a move happens on save, or what a coding agent needs", () => {
  assert.match(machineHint("m_2", true) ?? "", /^Saving moves the agent/);
  assert.equal(machineHint(undefined, true), "Coding agents need a Code machine.");
  assert.equal(machineHint(undefined, false), undefined);
});

test("only a saved coding agent has readiness problems", () => {
  const coding = { ...defaultAgentConfig, coding: true };
  assert.deepEqual(readinessProblems(coding, status), [
    { kind: "harness" },
    { kind: "repositories" },
  ]);
  assert.deepEqual(readinessProblems(defaultAgentConfig, status), []);
  assert.deepEqual(readinessProblems(coding, undefined), []);
});
