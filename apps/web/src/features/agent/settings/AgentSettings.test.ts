import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHarness, HarnessCatalog, Machine } from "../../../api/types/agents";
import { handleHint } from "../../../app/names";
import {
  carriedHarnesses,
  machineHint,
  machineMove,
  missingRepositoriesNote,
  readinessProblems,
  settingsNameError,
} from "./AgentSettings";
import { configFormOf, defaultAgentConfig } from "./configForm";

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

test("the machine's hint says a move happens on save, or what a subscription agent needs", () => {
  assert.match(machineHint("m_2", "subscription") ?? "", /^Saving moves the agent/);
  assert.equal(machineHint(undefined, "subscription"), "Subscription agents need a Code machine.");
  assert.equal(machineHint(undefined, "key"), undefined);
});

test("a saved subscription agent's readiness is its harness's; an agent on a key has none", () => {
  assert.deepEqual(readinessProblems("subscription", status), [{ kind: "harness" }]);
  assert.deepEqual(readinessProblems("key", status), []);
  assert.deepEqual(readinessProblems("subscription", undefined), []);
});

test("the Repositories section says what picking none does: home turns, or a harness that cannot run", () => {
  const catalog: HarnessCatalog[] = [
    { harness: "antigravity", label: "Antigravity", enabled: true, needs_repository: true, models: [], unlisted_efforts: [] },
  ];
  const onCodex = configFormOf({ ...defaultAgentConfig, model: null, harness: "codex" }, "subscription");
  const onAntigravity = { ...onCodex, harness: "antigravity" as const };
  assert.equal(missingRepositoriesNote(onCodex, catalog), "No repository picked, so this agent's turns run in its home.");
  assert.equal(
    missingRepositoriesNote(onAntigravity, catalog),
    "No repository picked. Antigravity keeps its own system prompt, so it runs a subscription agent only with a repository.",
  );
});
