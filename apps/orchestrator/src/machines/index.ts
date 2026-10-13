import path from "node:path";
import { NAME_RE } from "../lib/names.js";
import { numberOrNull } from "../lib/numbers.js";
import { isHarness, type Harness } from "../coding/harnesses.js";

/**
 * An organisation's machines (docs/concepts/guilds-and-agents.md#machines): one sandbox container
 * and one host directory each, sized by a tier. Every agent sits on one machine of its
 * organisation, in a slot that sets its display and ports.
 */

/** A machine's tier: `standard` hosts agents without coding, `code` and `custom` any agent. */
export const MACHINE_BOXES = ["standard", "code", "custom"] as const;
export type MachineBox = (typeof MACHINE_BOXES)[number];

export type MachineSize = { cpu: number; memory_mib: number };

/** The size of each fixed tier. A custom machine carries its own. */
export const MACHINE_TIERS: Record<Exclude<MachineBox, "custom">, MachineSize> = {
  standard: { cpu: 1, memory_mib: 2048 },
  code: { cpu: 2, memory_mib: 4096 },
};

/** A custom machine's size: CPUs in quarter steps and memory in MiB, each within these bounds. */
export const CUSTOM_MIN_CPU = 0.5;
export const CUSTOM_MAX_CPU = 4;
export const CUSTOM_CPU_STEP = 0.25;
export const CUSTOM_MIN_MEMORY_MIB = 512;
export const CUSTOM_MAX_MEMORY_MIB = 8192;

/** The machine every new organisation starts with. */
export const DEFAULT_MACHINE_NAME = "default";
export const DEFAULT_MACHINE_BOX: MachineBox = "standard";
/** A machine's disk cap in MiB, over every agent home on it. */
export const DEFAULT_MACHINE_MAX_WORKSPACE_MIB = 10240;
/** The most agents one machine holds, whatever the organisation's policy says: slots 0 to 31. */
export const MAX_AGENTS_PER_MACHINE = 32;

/** The planned memory of one agent working, by what it runs; the budget sums these per machine. */
export const CAPACITY_WEIGHTS_MIB = {
  base: 100,
  browser: 500,
  coding: 1536,
} as const;

/** A refused machine request or placement, with the HTTP status it answers with. */
export class MachineError extends Error {
  status: 403 | 404 | 409 | 422;

  constructor(status: 403 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = "MachineError";
    this.status = status;
  }
}

export type MachineRow = {
  id: string;
  org_id: string;
  name: string;
  box: MachineBox;
  cpu: number | null;
  memory_mib: number | null;
  max_workspace_mib: number;
  workspace_mib: number | null;
  /** The coding harness CLIs its image carries; null until its container first started. */
  harnesses: Harness[] | null;
};

/** An agent on a machine, as the machine listing carries it. */
export type MachineAgent = {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  slot: number;
  browser: boolean;
  coding: boolean;
};

export type MachineWithAgents = MachineRow & { agents: MachineAgent[] };

export function isMachineBox(value: unknown): value is MachineBox {
  return typeof value === "string" && (MACHINE_BOXES as readonly string[]).includes(value);
}

/** Whether agents with `coding` on may sit on a machine of this tier. */
export function machineAllowsCoding(box: MachineBox): boolean {
  return box !== "standard";
}

/** The CPUs and memory a machine runs with: its tier's, or a custom machine's own. */
export function machineSize(machine: Pick<MachineRow, "box" | "cpu" | "memory_mib">): MachineSize {
  if (machine.box === "custom") {
    return { cpu: Number(machine.cpu), memory_mib: Number(machine.memory_mib) };
  }
  return { ...MACHINE_TIERS[machine.box] };
}

/** Whether a change replaces the machine's container: another tier, CPUs, or memory. */
export function machineSizeChanged(before: MachineRow, after: MachineRow): boolean {
  const from = machineSize(before);
  const to = machineSize(after);
  return before.box !== after.box || from.cpu !== to.cpu || from.memory_mib !== to.memory_mib;
}

/** One agent's planned memory: the base, plus Chrome with `browser`, plus toolchains with `coding`. */
export function agentPlannedMib(flags: { browser: boolean; coding: boolean }): number {
  return (
    CAPACITY_WEIGHTS_MIB.base
    + (flags.browser ? CAPACITY_WEIGHTS_MIB.browser : 0)
    + (flags.coding ? CAPACITY_WEIGHTS_MIB.coding : 0)
  );
}

/** A machine's planned memory: every agent on it working at once. */
export function plannedMib(agents: Array<{ browser: boolean; coding: boolean }>): number {
  return agents.reduce((sum, agent) => sum + agentPlannedMib(agent), 0);
}

/** What an agent's slot sets inside its machine. */
export type SlotPorts = {
  /** The X display number, `:10+slot`. */
  display: number;
  /** The display's VNC server, `5910+slot`, which websockify bridges. */
  vnc: number;
  /** Chrome's DevTools port. */
  cdp: number;
  /** The noVNC page and WebSocket the Browser tab proxies to. */
  novnc: number;
  /** The terminal the CLI tab proxies to. */
  ttyd: number;
  /** The first and last port of the block the agent's own servers use. */
  portsFrom: number;
  portsTo: number;
};

export function slotPorts(slot: number): SlotPorts {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_AGENTS_PER_MACHINE) {
    throw new MachineError(422, `slot must be an integer from 0 to ${MAX_AGENTS_PER_MACHINE - 1}`);
  }
  const display = 10 + slot;
  return {
    display,
    vnc: 5900 + display,
    cdp: 9300 + slot,
    novnc: 6100 + slot,
    ttyd: 7700 + slot,
    portsFrom: 20000 + 100 * slot,
    portsTo: 20000 + 100 * slot + 99,
  };
}

/** The lowest slot no agent on the machine holds; null when all are taken. */
export function lowestFreeSlot(taken: Iterable<number>, ceiling = MAX_AGENTS_PER_MACHINE): number | null {
  const used = new Set(taken);
  for (let slot = 0; slot < Math.min(ceiling, MAX_AGENTS_PER_MACHINE); slot += 1) {
    if (!used.has(slot)) {
      return slot;
    }
  }
  return null;
}

export function validateMachineName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME_RE.test(name)) {
    throw new MachineError(422, "name must match ^[a-z][a-z0-9-]{0,62}$");
  }
  return name;
}

function validateCustomCpu(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < CUSTOM_MIN_CPU
    || value > CUSTOM_MAX_CPU
    || !Number.isInteger(value / CUSTOM_CPU_STEP)
  ) {
    throw new MachineError(
      422,
      `cpu must be between ${CUSTOM_MIN_CPU} and ${CUSTOM_MAX_CPU} in steps of ${CUSTOM_CPU_STEP}`,
    );
  }
  return value;
}

function validateCustomMemory(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < CUSTOM_MIN_MEMORY_MIB
    || value > CUSTOM_MAX_MEMORY_MIB
  ) {
    throw new MachineError(
      422,
      `memory_mib must be an integer between ${CUSTOM_MIN_MEMORY_MIB} and ${CUSTOM_MAX_MEMORY_MIB}`,
    );
  }
  return value;
}

export type MachineInput = {
  name: string;
  box: MachineBox;
  cpu: number | null;
  memory_mib: number | null;
  max_workspace_mib: number;
};

const MACHINE_INPUT_KEYS = new Set(["name", "box", "cpu", "memory_mib", "max_workspace_mib"]);

function rejectUnknownKeys(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !MACHINE_INPUT_KEYS.has(key)).sort();
  if (unknown.length) {
    throw new MachineError(422, `unknown keys: ${unknown.join(", ")}`);
  }
}

function resolveName(body: Record<string, unknown>, current: MachineRow | undefined): string {
  if ("name" in body) {
    return validateMachineName(body.name);
  }
  if (current === undefined) {
    throw new MachineError(422, "name is required");
  }
  return current.name;
}

function resolveBox(body: Record<string, unknown>, current: MachineRow | undefined): MachineBox {
  const box = "box" in body ? body.box : (current?.box ?? DEFAULT_MACHINE_BOX);
  if (!isMachineBox(box)) {
    throw new MachineError(422, "box must be standard, code, or custom");
  }
  return box;
}

/** A custom machine's size: the body's, else the current custom size. Other tiers carry none. */
function resolveCustomSize(
  body: Record<string, unknown>,
  box: MachineBox,
  current: MachineRow | undefined,
): { cpu: number | null; memory_mib: number | null } {
  if (box !== "custom") {
    if (body.cpu !== undefined || body.memory_mib !== undefined) {
      throw new MachineError(422, "cpu and memory_mib are only for a custom machine");
    }
    return { cpu: null, memory_mib: null };
  }
  const kept = current?.box === "custom" ? current : undefined;
  return {
    cpu: validateCustomCpu("cpu" in body ? body.cpu : kept?.cpu),
    memory_mib: validateCustomMemory("memory_mib" in body ? body.memory_mib : kept?.memory_mib),
  };
}

function resolveWorkspaceCap(body: Record<string, unknown>, current: MachineRow | undefined): number {
  const cap = "max_workspace_mib" in body
    ? body.max_workspace_mib
    : (current?.max_workspace_mib ?? DEFAULT_MACHINE_MAX_WORKSPACE_MIB);
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) {
    throw new MachineError(422, "max_workspace_mib must be a positive integer");
  }
  return cap;
}

/**
 * A machine's fields from a create or update body. On an update, `current` fills what the body
 * leaves out; a body that names a tier other than custom drops the size, and a custom machine
 * must have one.
 */
export function validateMachineInput(body: Record<string, unknown>, current?: MachineRow): MachineInput {
  rejectUnknownKeys(body);
  const box = resolveBox(body, current);
  return {
    name: resolveName(body, current),
    box,
    ...resolveCustomSize(body, box, current),
    max_workspace_mib: resolveWorkspaceCap(body, current),
  };
}

/** A machine row from the database: numeric columns as numbers. An unknown tier is refused. */
export function machineFromRow(row: Record<string, unknown>): MachineRow {
  if (!isMachineBox(row.box)) {
    throw new Error(`machine ${String(row.id)} has an unknown box: ${String(row.box)}`);
  }
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    name: String(row.name),
    box: row.box,
    cpu: numberOrNull(row.cpu),
    memory_mib: numberOrNull(row.memory_mib),
    max_workspace_mib: Number(row.max_workspace_mib ?? DEFAULT_MACHINE_MAX_WORKSPACE_MIB),
    workspace_mib: numberOrNull(row.workspace_mib),
    harnesses: Array.isArray(row.harnesses) ? row.harnesses.filter(isHarness) : null,
  };
}

/** The machine's directory on the host, mounted at /home in its container. */
export function machineDirectory(workspaceRoot: string, machineId: string): string {
  return path.join(workspaceRoot, machineId);
}

/** An agent's home on the host: its folder in its machine's directory. */
export function agentDirectory(workspaceRoot: string, machineId: string, agentId: string): string {
  return path.join(workspaceRoot, machineId, agentId);
}
