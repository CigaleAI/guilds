import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { NAME_RE } from "../lib/names.js";
import { numberOrNull } from "../lib/numbers.js";
import { isHarness } from "../coding/harnesses.js";
import type { MachineWithAgentsQueryRow } from "../db/machines.js";
import { DEFAULT_MACHINE_BOX, DEFAULT_MACHINE_MAX_WORKSPACE_MIB, type Harness } from "../db/schema/index.js";

/**
 * An organisation's machines (docs/concepts/machines.md): one sandbox container
 * and one host directory each, sized by a tier. Every agent sits on one machine of its
 * organisation, in a slot that sets its display and ports.
 */

/** A machine's tier: `standard` and `code` have fixed sizes, `custom` its own. */
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

/** The most agents one machine holds, whatever the organisation's policy says: slots 0 to 31. */
export const MAX_AGENTS_PER_MACHINE = 32;

/**
 * Machine sizing (docs/concepts/machines.md#machine-sizing). The smallest machine an
 * agent runs on, by what it has on: every agent has `base`, and `browser` and `coding` raise it.
 * An agent's minimum is the largest of these, CPUs and memory each, not their sum: Chrome and the
 * coding toolchain only run while the agent works. Placement refuses a machine below the minimum.
 */
export const AGENT_MINIMUMS = {
  base: { cpu: 0.5, memory_mib: 256 },
  browser: { cpu: 1, memory_mib: 2048 },
  coding: { cpu: 2, memory_mib: 4096 },
} as const satisfies Record<string, MachineSize>;

/**
 * How far a machine's agents may oversubscribe it before placement warns: the sum of their
 * minimums against these multiples of its CPUs and memory. Few agents work at once, so a machine
 * takes more than it could run together. Memory gets the lower factor: too little CPU slows agents
 * down, too little memory gets their processes killed. Past either, placement warns; it never refuses.
 */
export const OVERCOMMIT = { cpu: 5, memory: 3 } as const;

/** What an agent has on that sets its minimum. */
export type AgentNeeds = { browser: boolean; coding: boolean };

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
  /** The agent's own disk cap in MiB. */
  max_workspace_mib: number;
};

export type MachineWithAgents = MachineRow & { agents: MachineAgent[] };

export function isMachineBox(value: unknown): value is MachineBox {
  return typeof value === "string" && (MACHINE_BOXES as readonly string[]).includes(value);
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

/** The smallest machine an agent runs on: the largest of the minimums of what it has on. */
export function agentMinimum(needs: AgentNeeds): MachineSize {
  const parts: MachineSize[] = [
    AGENT_MINIMUMS.base,
    ...(needs.browser ? [AGENT_MINIMUMS.browser] : []),
    ...(needs.coding ? [AGENT_MINIMUMS.coding] : []),
  ];
  return {
    cpu: Math.max(...parts.map((part) => part.cpu)),
    memory_mib: Math.max(...parts.map((part) => part.memory_mib)),
  };
}

/** The smallest machine every one of these agents runs on. */
export function agentsMinimum(agents: readonly AgentNeeds[]): MachineSize {
  return agentMinimum({
    browser: agents.some((agent) => agent.browser),
    coding: agents.some((agent) => agent.coding),
  });
}

/** Whether a machine of this size meets a minimum, CPUs and memory both. */
export function sizeMeets(size: MachineSize, minimum: MachineSize): boolean {
  return size.cpu >= minimum.cpu && size.memory_mib >= minimum.memory_mib;
}

/** A size in words: "2 CPUs and 4 GiB". */
export function sizeLabel(size: MachineSize): string {
  const gib = size.memory_mib / 1024;
  const memory = size.memory_mib < 1024 ? `${size.memory_mib} MiB` : `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
  return `${size.cpu} ${size.cpu === 1 ? "CPU" : "CPUs"} and ${memory}`;
}

/** Why an agent cannot go on a machine below its minimum. */
export function belowMinimumMessage(what: string, needs: AgentNeeds, machine: Pick<MachineRow, "name" | "box" | "cpu" | "memory_mib">): string {
  return `${what} needs a machine with at least ${sizeLabel(agentMinimum(needs))}; ${machine.name} has ${sizeLabel(machineSize(machine))}`;
}

/** A machine's planned load: the sum of its agents' minimums. */
export function plannedLoad(agents: readonly AgentNeeds[]): MachineSize {
  return agents.reduce(
    (sum, agent) => {
      const minimum = agentMinimum(agent);
      return { cpu: sum.cpu + minimum.cpu, memory_mib: sum.memory_mib + minimum.memory_mib };
    },
    { cpu: 0, memory_mib: 0 },
  );
}

/** The planned load a machine takes before placement warns: its size times `OVERCOMMIT`. */
export function machineCapacity(size: MachineSize): MachineSize {
  return { cpu: size.cpu * OVERCOMMIT.cpu, memory_mib: size.memory_mib * OVERCOMMIT.memory };
}

/** The disk a machine's agents reserve: the sum of their own disk caps. */
export function allocatedWorkspaceMib(agents: Array<{ max_workspace_mib: number }>): number {
  return agents.reduce((sum, agent) => sum + agent.max_workspace_mib, 0);
}

/** What an agent's slot sets inside its machine. */
export type SlotPorts = {
  /** The X display number, `:10+slot`. */
  display: number;
  /** The display's VNC server, `5910+slot`, which websockify bridges. */
  vnc: number;
  /** Chrome's DevTools port. */
  cdp: number;
  /** The DevTools relay gost serves on every interface, forwarding to `cdp` with Chrome's Host. */
  cdpRelay: number;
  /** The noVNC page and WebSocket the Browser tab proxies to. */
  novnc: number;
  /** The terminal the CLI tab proxies to. */
  ttyd: number;
  /** Reserved for the slot's local forward proxy. */
  proxy: number;
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
    cdpRelay: 9400 + slot,
    novnc: 6100 + slot,
    ttyd: 7700 + slot,
    proxy: 9500 + slot,
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

/** A machine's fields as a create or update request sends them; an update leaves out what it keeps. */
export const MachineBodySchema = Type.Object({
  name: Type.Optional(Type.String()),
  box: Type.Optional(Type.String()),
  cpu: Type.Optional(Type.Number()),
  memory_mib: Type.Optional(Type.Number()),
  max_workspace_mib: Type.Optional(Type.Number()),
});

export type MachineBody = Static<typeof MachineBodySchema>;

export type MachineInput = {
  name: string;
  box: MachineBox;
  cpu: number | null;
  memory_mib: number | null;
  max_workspace_mib: number;
};

const MACHINE_INPUT_KEYS = new Set(["name", "box", "cpu", "memory_mib", "max_workspace_mib"]);

function rejectUnknownKeys(body: MachineBody): void {
  const unknown = Object.keys(body).filter((key) => !MACHINE_INPUT_KEYS.has(key)).sort();
  if (unknown.length) {
    throw new MachineError(422, `unknown keys: ${unknown.join(", ")}`);
  }
}

function resolveName(body: MachineBody, current: MachineRow | undefined): string {
  if (body.name !== undefined) {
    return validateMachineName(body.name);
  }
  if (current === undefined) {
    throw new MachineError(422, "name is required");
  }
  return current.name;
}

function resolveBox(body: MachineBody, current: MachineRow | undefined): MachineBox {
  const box = body.box ?? current?.box ?? DEFAULT_MACHINE_BOX;
  if (!isMachineBox(box)) {
    throw new MachineError(422, "box must be standard, code, or custom");
  }
  return box;
}

/** A custom machine's size: the body's, else the current custom size. Other tiers carry none. */
function resolveCustomSize(
  body: MachineBody,
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
    cpu: validateCustomCpu(body.cpu ?? kept?.cpu),
    memory_mib: validateCustomMemory(body.memory_mib ?? kept?.memory_mib),
  };
}

function resolveWorkspaceCap(body: MachineBody, current: MachineRow | undefined): number {
  const cap =
    body.max_workspace_mib ?? current?.max_workspace_mib ?? DEFAULT_MACHINE_MAX_WORKSPACE_MIB;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new MachineError(422, "max_workspace_mib must be a positive integer");
  }
  return cap;
}

/**
 * A machine's fields from a create or update body. On an update, `current` fills what the body
 * leaves out; a body that names a tier other than custom drops the size, and a custom machine
 * must have one.
 */
export function validateMachineInput(body: MachineBody, current?: MachineRow): MachineInput {
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

/** A machine row with the agents on it, each with its own disk cap from its config. */
export function machineWithAgentsFromRow(row: MachineWithAgentsQueryRow): MachineWithAgents {
  return {
    ...machineFromRow(row),
    agents: row.agents ?? [],
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
