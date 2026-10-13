import assert from "node:assert/strict";
import { test } from "node:test";
import type { Machine } from "../../api/types";
import {
  agentPlannedMib,
  canManageMachines,
  capacityWeightsMib,
  chosenMachine,
  customSizeErrors,
  formatMib,
  machineAgentCount,
  machineAllowsCoding,
  machineFormErrors,
  machineFormOf,
  machineInputOf,
  newMachineForm,
  placementBudget,
} from "./machines";

function machine(patch: Partial<Machine> = {}): Machine {
  return {
    id: "mach_1",
    name: "default",
    box: "standard",
    cpu: 1,
    memory_mib: 2048,
    max_workspace_mib: 10240,
    workspace_mib: null,
    planned_mib: 0,
    agents: [],
    hidden_agents: 0,
    harnesses: null,
    ...patch,
  };
}

const agent = (id: string, browser: boolean, coding: boolean) => ({
  id,
  name: id,
  guild_id: "g",
  guild_name: "guild",
  browser,
  coding,
});

test("an agent plans the base memory, plus its browser and its coding", () => {
  assert.equal(agentPlannedMib({ browser: false, coding: false }), capacityWeightsMib.base);
  assert.equal(agentPlannedMib({ browser: true, coding: false }), 600);
  assert.equal(agentPlannedMib({ browser: true, coding: true }), 2136);
});

test("a placement starts from the server's plan, counts an agent already there once, and adds this agent", () => {
  const host = machine({
    planned_mib: 1200,
    agents: [agent("a", true, false), agent("b", true, false)],
  });
  const fresh = placementBudget(host, { browser: true, coding: false });
  assert.deepEqual(fresh, {
    othersMib: 1200,
    addsMib: 600,
    totalMib: 1800,
    memoryMib: 2048,
    over: false,
  });
  // An agent already on the machine is not counted twice, and its new flags count.
  const moved = placementBudget(host, { id: "a", browser: true, coding: true });
  assert.equal(moved.othersMib, 600);
  assert.equal(moved.addsMib, 2136);
  assert.equal(moved.over, true);
  // Agents of guilds the viewer cannot see are in the server's plan though not listed.
  const shared = placementBudget(machine({ planned_mib: 1700, hidden_agents: 1 }), {
    browser: false,
    coding: false,
  });
  assert.equal(shared.othersMib, 1700);
});

test("a machine's agent count includes those of guilds the viewer cannot see", () => {
  assert.equal(
    machineAgentCount(machine({ agents: [agent("a", false, false)], hidden_agents: 2 })),
    3,
  );
  assert.equal(machineAgentCount(machine()), 0);
});

test("the chosen machine, or the only one", () => {
  const one = [machine()];
  assert.equal(chosenMachine(one, "")?.id, "mach_1");
  const two = [machine(), machine({ id: "mach_2", name: "big", box: "code" })];
  assert.equal(chosenMachine(two, ""), undefined);
  assert.equal(chosenMachine(two, "mach_2")?.name, "big");
  assert.equal(chosenMachine(undefined, "mach_2"), undefined);
});

test("coding goes on code and custom machines; owners and admins manage machines", () => {
  assert.equal(machineAllowsCoding("standard"), false);
  assert.equal(machineAllowsCoding("code"), true);
  assert.equal(machineAllowsCoding("custom"), true);
  assert.equal(canManageMachines("owner"), true);
  assert.equal(canManageMachines("admin"), true);
  assert.equal(canManageMachines("member"), false);
});

test("memory sizes read in MiB, then GiB", () => {
  assert.equal(formatMib(600), "600 MiB");
  assert.equal(formatMib(2048), "2 GiB");
  assert.equal(formatMib(2136), "2.1 GiB");
});

test("a machine form checks the name, a custom size, and the disk cap", () => {
  const form = { ...newMachineForm, name: "browsers" };
  assert.deepEqual(machineFormErrors(form), {});
  assert.match(machineFormErrors({ ...form, name: "Browsers" }).name ?? "", /Lowercase/);
  assert.match(machineFormErrors({ ...form, name: "" }).name ?? "", /Lowercase/);
  assert.match(
    machineFormErrors({ ...form, max_workspace_mib: "0" }).max_workspace_mib ?? "",
    /1 or more/,
  );
  // The size is checked on custom only.
  assert.deepEqual(machineFormErrors({ ...form, cpu: "99" }), {});
  const custom = { ...form, box: "custom" as const };
  assert.deepEqual(machineFormErrors(custom), {});
  assert.match(machineFormErrors({ ...custom, cpu: "0.25" }).cpu ?? "", /0.5 to 4 CPUs/);
  assert.match(machineFormErrors({ ...custom, cpu: "1.1" }).cpu ?? "", /steps of 0.25/);
  assert.equal(machineFormErrors({ ...custom, cpu: "3.75" }).cpu, undefined);
  assert.match(machineFormErrors({ ...custom, memory_mib: "256" }).memory_mib ?? "", /512 to 8192/);
  assert.match(
    machineFormErrors({ ...custom, memory_mib: "1024.5" }).memory_mib ?? "",
    /whole number/,
  );
});

test("a custom size keeps CPUs in quarter steps within bounds", () => {
  const size = { cpu: "2", memory_mib: "4096" };
  assert.deepEqual(customSizeErrors(size), {});
  for (const cpu of ["0.5", "4", "0.75"])
    assert.equal(customSizeErrors({ ...size, cpu }).cpu, undefined);
  for (const cpu of ["", " ", "0.25", "4.25", "1.1", "abc", "Infinity", "NaN", "-1"]) {
    assert.match(
      customSizeErrors({ ...size, cpu }).cpu ?? "",
      /0.5 to 4 CPUs, in steps of 0.25/,
      cpu,
    );
  }
});

test("a custom size keeps memory a whole number of MiB within bounds", () => {
  const size = { cpu: "2", memory_mib: "4096" };
  for (const memory_mib of ["512", "8192", " 1024 "]) {
    assert.equal(customSizeErrors({ ...size, memory_mib }).memory_mib, undefined, memory_mib);
  }
  for (const memory_mib of ["", "511", "8193", "1e3", "-512", "2048.0"]) {
    assert.match(
      customSizeErrors({ ...size, memory_mib }).memory_mib ?? "",
      /512 to 8192/,
      memory_mib,
    );
  }
  assert.deepEqual(Object.keys(customSizeErrors({ cpu: "9", memory_mib: "9" })).sort(), [
    "cpu",
    "memory_mib",
  ]);
});

test("a machine name and disk cap follow the server's rules", () => {
  const form = { ...newMachineForm, name: "browsers" };
  assert.equal(machineFormErrors({ ...form, name: " browsers " }).name, undefined);
  assert.equal(machineFormErrors({ ...form, name: `a${"b".repeat(62)}` }).name, undefined);
  for (const name of [`a${"b".repeat(63)}`, "1box", "-box", "box_1"]) {
    assert.match(machineFormErrors({ ...form, name }).name ?? "", /Lowercase/, name);
  }
  assert.equal(machineFormErrors({ ...form, max_workspace_mib: "1" }).max_workspace_mib, undefined);
  for (const max_workspace_mib of ["", "1.5", "-3", "ten"]) {
    assert.match(
      machineFormErrors({ ...form, max_workspace_mib }).max_workspace_mib ?? "",
      /1 or more/,
    );
  }
  // A tier is never refused here: the server refuses a standard tier under a coding agent.
  assert.equal(machineFormErrors({ ...form, box: "standard" }).box, undefined);
});

test("the body sends a size only for a custom machine", () => {
  const custom = machineInputOf({
    ...newMachineForm,
    name: " big ",
    box: "custom",
    cpu: "2.5",
    memory_mib: "6144",
  });
  assert.deepEqual(custom, {
    name: "big",
    box: "custom",
    cpu: 2.5,
    memory_mib: 6144,
    max_workspace_mib: 10240,
  });
  const code = machineInputOf({ ...newMachineForm, name: "big", box: "code", cpu: "2.5" });
  assert.deepEqual(code, { name: "big", box: "code", max_workspace_mib: 10240 });
  const stored = machineFormOf(
    machine({ box: "code", cpu: 2, memory_mib: 4096, max_workspace_mib: 20480 }),
  );
  assert.deepEqual(stored, {
    name: "default",
    box: "code",
    cpu: "2",
    memory_mib: "4096",
    max_workspace_mib: "20480",
  });
});
