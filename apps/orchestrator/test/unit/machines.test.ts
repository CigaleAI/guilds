import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { layOutAgentHomes } from "../../src/machines/layout.js";
import { tempDir } from "../helpers/env.js";
import {
  AGENT_MINIMUMS,
  MAX_AGENTS_PER_MACHINE,
  MachineError,
  OVERCOMMIT,
  agentDirectory,
  agentMinimum,
  agentsMinimum,
  belowMinimumMessage,
  lowestFreeSlot,
  machineCapacity,
  machineDirectory,
  machineFromRow,
  machineSize,
  machineSizeChanged,
  plannedLoad,
  sizeMeets,
  slotPorts,
  validateMachineInput,
  type MachineRow,
} from "../../src/machines/index.js";

const CUSTOM: MachineRow = {
  id: "mach_1",
  org_id: "org_1",
  name: "big",
  box: "custom",
  cpu: 2,
  memory_mib: 3072,
  max_workspace_mib: 10240,
  workspace_mib: null,
  harnesses: null,
};

test("each tier has its size, and a custom machine its own", () => {
  assert.deepEqual(machineSize({ box: "standard", cpu: null, memory_mib: null }), { cpu: 1, memory_mib: 2048 });
  assert.deepEqual(machineSize({ box: "code", cpu: null, memory_mib: null }), { cpu: 2, memory_mib: 4096 });
  assert.deepEqual(machineSize(CUSTOM), { cpu: 2, memory_mib: 3072 });
});

test("an agent's minimum is the largest of its capabilities' minimums, not their sum", () => {
  assert.deepEqual(agentMinimum({ browser: false, coding: false }), AGENT_MINIMUMS.base);
  assert.deepEqual(agentMinimum({ browser: true, coding: false }), AGENT_MINIMUMS.browser);
  assert.deepEqual(agentMinimum({ browser: true, coding: true }), AGENT_MINIMUMS.coding);
  assert.deepEqual(
    agentsMinimum([
      { browser: true, coding: false },
      { browser: false, coding: false },
    ]),
    AGENT_MINIMUMS.browser,
  );
});

test("a standard machine takes browser agents, a code machine coding ones, a custom one by its size", () => {
  const standard = machineSize({ box: "standard", cpu: null, memory_mib: null });
  const code = machineSize({ box: "code", cpu: null, memory_mib: null });
  assert.equal(sizeMeets(standard, agentMinimum({ browser: true, coding: false })), true);
  assert.equal(sizeMeets(standard, agentMinimum({ browser: false, coding: true })), false);
  assert.equal(sizeMeets(code, agentMinimum({ browser: true, coding: true })), true);
  assert.equal(sizeMeets(machineSize(CUSTOM), agentMinimum({ browser: false, coding: true })), false);
  assert.equal(
    belowMinimumMessage("dev", { browser: false, coding: true }, CUSTOM),
    "dev needs a machine with at least 2 CPUs and 4 GiB; big has 2 CPUs and 3 GiB",
  );
});

test("a machine body: a custom machine has a size within the bounds, no other tier has one", () => {
  assert.deepEqual(validateMachineInput({ name: "default" }), {
    name: "default",
    box: "standard",
    cpu: null,
    memory_mib: null,
    max_workspace_mib: 10240,
  });
  assert.deepEqual(validateMachineInput({ name: "edge", box: "custom", cpu: 0.5, memory_mib: 512 }).cpu, 0.5);
  assert.equal(validateMachineInput({ name: "top", box: "custom", cpu: 4, memory_mib: 8192 }).memory_mib, 8192);
  assert.equal(validateMachineInput({ name: "q", box: "custom", cpu: 1.75, memory_mib: 1024 }).cpu, 1.75);
  for (const cpu of [0.25, 4.25, 1.1]) {
    assert.throws(
      () => validateMachineInput({ name: "m", box: "custom", cpu, memory_mib: 1024 }),
      /cpu must be between 0.5 and 4 in steps of 0.25/,
    );
  }
  for (const memory of [256, 8193, 1024.5]) {
    assert.throws(
      () => validateMachineInput({ name: "m", box: "custom", cpu: 2, memory_mib: memory }),
      /memory_mib must be an integer between 512 and 8192/,
    );
  }
  assert.throws(() => validateMachineInput({ name: "m", box: "code", cpu: 2 }), /only for a custom machine/);
  assert.throws(() => validateMachineInput({ name: "m", box: "lite" }), /box must be standard, code, or custom/);
  assert.throws(() => validateMachineInput({ name: "Bad Name" }), MachineError);
  assert.throws(() => validateMachineInput({}), /name is required/);
  const sized = { name: "m", size: 3 };
  assert.throws(() => validateMachineInput(sized), /unknown keys: size/);
  assert.throws(() => validateMachineInput({ name: "m", max_workspace_mib: 0 }), /max_workspace_mib/);
});

test("an update keeps what the body leaves out, and drops the size when the tier stops being custom", () => {
  assert.deepEqual(validateMachineInput({ max_workspace_mib: 20480 }, CUSTOM), {
    name: "big",
    box: "custom",
    cpu: 2,
    memory_mib: 3072,
    max_workspace_mib: 20480,
  });
  assert.equal(validateMachineInput({ cpu: 3 }, CUSTOM).memory_mib, 3072);
  const coded = validateMachineInput({ box: "code" }, CUSTOM);
  assert.equal(coded.cpu, null);
  assert.equal(coded.memory_mib, null);
  assert.throws(
    () => validateMachineInput({ box: "custom" }, { ...CUSTOM, box: "standard", cpu: null, memory_mib: null }),
    /cpu must be between/,
  );
});

test("a slot sets the agent's display, its ports, and its own port block, none of them shared", () => {
  assert.deepEqual(slotPorts(0), {
    display: 10,
    vnc: 5910,
    cdp: 9300,
    cdpRelay: 9400,
    novnc: 6100,
    ttyd: 7700,
    proxy: 9500,
    portsFrom: 20000,
    portsTo: 20099,
  });
  const seen = new Set<number>();
  for (let slot = 0; slot < MAX_AGENTS_PER_MACHINE; slot += 1) {
    const ports = slotPorts(slot);
    const fixed = [ports.vnc, ports.cdp, ports.cdpRelay, ports.novnc, ports.ttyd, ports.proxy];
    for (const port of [...fixed, ports.portsFrom, ports.portsTo]) {
      assert.equal(seen.has(port), false, `port ${port} is taken twice`);
      seen.add(port);
      assert.ok(port < 65536);
    }
    // X listens on no TCP port; were it to, 6000 + display stays clear of every agent's noVNC.
    assert.ok(6000 + ports.display < slotPorts(0).novnc);
  }
  assert.throws(() => slotPorts(MAX_AGENTS_PER_MACHINE), MachineError);
  assert.throws(() => slotPorts(-1), MachineError);
});

test("placement takes the lowest free slot, under the policy's cap and core's ceiling", () => {
  assert.equal(lowestFreeSlot([]), 0);
  assert.equal(lowestFreeSlot([0, 1, 3]), 2);
  assert.equal(lowestFreeSlot([0, 1], 2), null);
  assert.equal(lowestFreeSlot(Array.from({ length: MAX_AGENTS_PER_MACHINE }, (_, slot) => slot), 100), null);
});

test("a machine's planned load sums its agents' minimums, against its size times the overcommit", () => {
  assert.deepEqual(
    plannedLoad([
      { browser: true, coding: false },
      { browser: false, coding: false },
    ]),
    { cpu: 1.5, memory_mib: 2048 + 256 },
  );
  assert.deepEqual(machineCapacity({ cpu: 1, memory_mib: 2048 }), {
    cpu: OVERCOMMIT.cpu,
    memory_mib: 2048 * OVERCOMMIT.memory,
  });
});

test("the boot layout destroys per-agent sandboxes and moves each home into its machine's directory", async () => {
  const root = tempDir("guilds-layout-");
  mkdirSync(path.join(root, "a_1", ".browser"), { recursive: true });
  writeFileSync(path.join(root, "a_1", ".browser", "Cookies"), "logged-in");
  mkdirSync(path.join(root, "a_2"));
  mkdirSync(path.join(root, "mach_1", "a_2"), { recursive: true });
  writeFileSync(path.join(root, "mach_1", "a_2", "kept.txt"), "already laid out");
  let destroyed = 0;
  await layOutAgentHomes({
    placements: async () => [
      { machineId: "mach_1", agentId: "a_1" },
      { machineId: "mach_1", agentId: "a_2" },
      { machineId: "mach_1", agentId: "a_3" },
    ],
    workspaceRootFor: async () => root,
    destroyAgentSandboxes: async () => {
      destroyed += 1;
      return 2;
    },
  });
  assert.equal(destroyed, 1);
  assert.equal(readFileSync(path.join(root, "mach_1", "a_1", ".browser", "Cookies"), "utf8"), "logged-in");
  assert.equal(existsSync(path.join(root, "a_1")), false);
  assert.equal(readFileSync(path.join(root, "mach_1", "a_2", "kept.txt"), "utf8"), "already laid out");
  assert.equal(existsSync(path.join(root, "a_2")), true, "a home already in place is not overwritten");
  assert.equal(existsSync(path.join(root, "mach_1", "a_3")), false);
});

test("a machine's container is replaced only when its tier, CPUs, or memory change", () => {
  const standard: MachineRow = { ...CUSTOM, box: "standard", cpu: null, memory_mib: null };
  assert.equal(machineSizeChanged(standard, { ...standard, name: "renamed", max_workspace_mib: 1 }), false);
  assert.equal(machineSizeChanged(standard, { ...standard, box: "code" }), true);
  assert.equal(machineSizeChanged(CUSTOM, { ...CUSTOM }), false);
  assert.equal(machineSizeChanged(CUSTOM, { ...CUSTOM, cpu: 2.5 }), true);
  assert.equal(machineSizeChanged(CUSTOM, { ...CUSTOM, memory_mib: 4096 }), true);
  // A custom machine the size of the code tier is still another tier.
  assert.equal(machineSizeChanged({ ...CUSTOM, memory_mib: 4096 }, { ...standard, box: "code" }), true);
});

test("a machine row maps numeric columns to numbers and nulls, and refuses an unknown tier", () => {
  assert.deepEqual(
    machineFromRow({ id: "mach_1", org_id: "org_1", name: "big", box: "custom", cpu: "1.5", memory_mib: "2048", max_workspace_mib: "4096", workspace_mib: "12", harnesses: ["codex", "pi"] }),
    { id: "mach_1", org_id: "org_1", name: "big", box: "custom", cpu: 1.5, memory_mib: 2048, max_workspace_mib: 4096, workspace_mib: 12, harnesses: ["codex"] },
  );
  const plain = machineFromRow({ id: "mach_2", org_id: "org_1", name: "default", box: "standard", cpu: null, memory_mib: null, max_workspace_mib: null });
  assert.equal(plain.cpu, null);
  assert.equal(plain.memory_mib, null);
  assert.equal(plain.workspace_mib, null);
  assert.equal(plain.max_workspace_mib, 10240);
  assert.equal(plain.harnesses, null, "before its container first started");
  assert.throws(() => machineFromRow({ id: "mach_3", box: "lite" }), /machine mach_3 has an unknown box: lite/);
  assert.throws(() => machineFromRow({ id: "mach_4" }), /unknown box: undefined/);
});

test("a machine body: each refusal names what is wrong", () => {
  const extra = { name: "m", zeta: 1, alpha: 2 };
  assert.throws(() => validateMachineInput(extra), /unknown keys: alpha, zeta/);
  assert.throws(() => validateMachineInput({ box: "code" }), /name is required/);
  assert.equal(validateMachineInput({ box: "code" }, CUSTOM).name, "big", "an update keeps the name");
  assert.equal(validateMachineInput({ name: "  spaced  " }).name, "spaced");
  for (const box of ["lite", "Custom"]) {
    assert.throws(() => validateMachineInput({ name: "m", box }), /box must be standard, code, or custom/);
  }
  assert.throws(() => validateMachineInput({ name: "m", box: "custom" }), /cpu must be between/);
  assert.throws(() => validateMachineInput({ name: "m", box: "custom", cpu: 1 }), /memory_mib must be an integer/);
  assert.deepEqual(validateMachineInput({ memory_mib: 1024 }, CUSTOM), {
    name: "big",
    box: "custom",
    cpu: 2,
    memory_mib: 1024,
    max_workspace_mib: 10240,
  });
  assert.throws(() => validateMachineInput({ name: "m", memory_mib: 1024 }), /only for a custom machine/);
  assert.throws(() => validateMachineInput({ cpu: 2 }, { ...CUSTOM, box: "code", cpu: null, memory_mib: null }), /only for a custom machine/);
  for (const cap of [1.5, -5, 0]) {
    assert.throws(
      () => validateMachineInput({ name: "m", max_workspace_mib: cap }),
      /max_workspace_mib must be a positive integer/,
    );
  }
  assert.equal(validateMachineInput({ name: "m", max_workspace_mib: 1 }).max_workspace_mib, 1);
  for (const call of [() => validateMachineInput({}), () => validateMachineInput({ name: "m", box: "x" })]) {
    assert.throws(call, (error: unknown) => error instanceof MachineError && error.status === 422);
  }
});

test("a machine's directory is under the workspace root, and an agent's home in its machine's", () => {
  assert.equal(machineDirectory("/srv/workspaces", "mach_1"), path.join("/srv/workspaces", "mach_1"));
  assert.equal(agentDirectory("/srv/workspaces", "mach_1", "a_1"), path.join("/srv/workspaces", "mach_1", "a_1"));
});
