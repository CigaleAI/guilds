import type { Machine, MachineBox, MachineInput, OrgRole } from "../../api/types";

/**
 * The size of each fixed tier, for the tier picker before a machine exists; it mirrors the
 * server's tiers. An existing machine's size comes from the server's machine list.
 */
export const machineTiers: Record<
  Exclude<MachineBox, "custom">,
  { cpu: number; memory_mib: number }
> = {
  standard: { cpu: 1, memory_mib: 2048 },
  code: { cpu: 2, memory_mib: 4096 },
};

/** A custom machine's size: CPUs in quarter steps and memory in MiB, within these bounds. */
export const customMachineBounds = {
  minCpu: 0.5,
  maxCpu: 4,
  cpuStep: 0.25,
  minMemoryMib: 512,
  maxMemoryMib: 8192,
} as const;

/** The disk cap a new machine starts with, in MiB. */
export const defaultMachineMaxWorkspaceMib = 10240;

/**
 * The planned memory of one agent working, by what it runs, as the server weighs it. Only what an
 * agent being placed adds is computed here; a machine's own plan is the server's `planned_mib`.
 */
export const capacityWeightsMib = {
  base: 100,
  browser: 500,
  coding: 1536,
} as const;

/** The server's rule for a machine's name. */
export const machineNamePattern = /^[a-z][a-z0-9-]{0,62}$/;

export const machineBoxLabel: Record<MachineBox, string> = {
  standard: "Standard",
  code: "Code",
  custom: "Custom",
};

/** The line every placement shows: what sharing a machine means. */
export const sharedMachineNote = "Agents on one machine can read each other's files and sessions.";

/** Owners and admins create, resize and delete machines; every member sees them. */
export function canManageMachines(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/** Whether agents with coding on may sit on a machine of this tier. */
export function machineAllowsCoding(box: MachineBox): boolean {
  return box !== "standard";
}

/** The memory one agent plans to use when it works: the base, plus its browser and coding. */
export function agentPlannedMib(flags: { browser: boolean; coding: boolean }): number {
  return (
    capacityWeightsMib.base +
    (flags.browser ? capacityWeightsMib.browser : 0) +
    (flags.coding ? capacityWeightsMib.coding : 0)
  );
}

/** Every agent on a machine, those in guilds the viewer cannot see included. */
export function machineAgentCount(machine: Pick<Machine, "agents" | "hidden_agents">): number {
  return machine.agents.length + machine.hidden_agents;
}

/** A memory size in MiB, in GiB from 1 GiB up. */
export function formatMib(mib: number): string {
  if (mib < 1024) return `${mib} MiB`;
  const gib = mib / 1024;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

/** A machine's size in a line: "2 CPU · 4 GiB". */
export function machineSizeLabel(machine: { cpu: number; memory_mib: number }): string {
  return `${machine.cpu} CPU · ${formatMib(machine.memory_mib)}`;
}

/**
 * The machine an agent goes on: the one chosen, else the organisation's only one. Undefined while
 * the machines load, or while several wait for a choice.
 */
export function chosenMachine<T extends { id: string }>(
  machines: readonly T[] | undefined,
  machineId: string,
): T | undefined {
  if (!machines) return undefined;
  return (
    machines.find((item) => item.id === machineId) ??
    (machines.length === 1 ? machines[0] : undefined)
  );
}

/**
 * What an agent placed on a machine does to its budget: the memory the other agents there plan to
 * use, what this agent adds, and whether the sum passes the machine's memory. An agent already on
 * the machine counts once, with the flags it is given here.
 */
export function placementBudget(
  machine: Pick<Machine, "memory_mib" | "planned_mib" | "agents">,
  agent: { id?: string | undefined; browser: boolean; coding: boolean },
): { othersMib: number; addsMib: number; totalMib: number; memoryMib: number; over: boolean } {
  const current = machine.agents.find((item) => item.id === agent.id);
  const othersMib = machine.planned_mib - (current ? agentPlannedMib(current) : 0);
  const addsMib = agentPlannedMib(agent);
  const totalMib = othersMib + addsMib;
  return {
    othersMib,
    addsMib,
    totalMib,
    memoryMib: machine.memory_mib,
    over: totalMib > machine.memory_mib,
  };
}

/** A machine as its create or edit form holds it: numbers stay text while typed. */
export type MachineForm = {
  name: string;
  box: MachineBox;
  /** A custom machine's size, as typed; kept while another tier is picked, sent only on custom. */
  cpu: string;
  memory_mib: string;
  max_workspace_mib: string;
};

export type MachineFormErrors = Partial<Record<keyof MachineForm, string>>;

/** A new machine's form: standard, with the default disk cap and a custom size seeded from code. */
export const newMachineForm: MachineForm = {
  name: "",
  box: "standard",
  cpu: String(machineTiers.code.cpu),
  memory_mib: String(machineTiers.code.memory_mib),
  max_workspace_mib: String(defaultMachineMaxWorkspaceMib),
};

/** An existing machine in its form. */
export function machineFormOf(machine: Machine): MachineForm {
  return {
    name: machine.name,
    box: machine.box,
    cpu: String(machine.cpu),
    memory_mib: String(machine.memory_mib),
    max_workspace_mib: String(machine.max_workspace_mib),
  };
}

function wholeNumber(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

function cpuValid(text: string): boolean {
  const cpu = Number(text);
  const { minCpu, maxCpu, cpuStep } = customMachineBounds;
  return text.trim() !== "" && cpu >= minCpu && cpu <= maxCpu && Number.isInteger(cpu / cpuStep);
}

function memoryValid(text: string): boolean {
  const memory = Number(text);
  const { minMemoryMib, maxMemoryMib } = customMachineBounds;
  return wholeNumber(text) && memory >= minMemoryMib && memory <= maxMemoryMib;
}

/** What the server would refuse in a custom size: CPUs off the quarter steps or out of bounds, memory out of bounds. */
export function customSizeErrors(form: Pick<MachineForm, "cpu" | "memory_mib">): MachineFormErrors {
  const { minCpu, maxCpu, cpuStep, minMemoryMib, maxMemoryMib } = customMachineBounds;
  return {
    ...(cpuValid(form.cpu) ? {} : { cpu: `${minCpu} to ${maxCpu} CPUs, in steps of ${cpuStep}.` }),
    ...(memoryValid(form.memory_mib)
      ? {}
      : { memory_mib: `A whole number of MiB, ${minMemoryMib} to ${maxMemoryMib}.` }),
  };
}

/**
 * What the server would refuse in a machine form: the name rule, a custom size out of bounds, and a
 * disk cap under 1 MiB. A tier the machine's agents cannot use is the server's to refuse.
 */
export function machineFormErrors(form: MachineForm): MachineFormErrors {
  const diskValid = wholeNumber(form.max_workspace_mib) && Number(form.max_workspace_mib) >= 1;
  return {
    ...(machineNamePattern.test(form.name.trim())
      ? {}
      : { name: "Lowercase letters, digits and hyphens, starting with a letter; up to 63." }),
    ...(form.box === "custom" ? customSizeErrors(form) : {}),
    ...(diskValid ? {} : { max_workspace_mib: "A whole number, 1 or more." }),
  };
}

/** The body to send: the size only on custom. */
export function machineInputOf(form: MachineForm): MachineInput {
  return {
    name: form.name.trim(),
    box: form.box,
    ...(form.box === "custom"
      ? { cpu: Number(form.cpu), memory_mib: Number(form.memory_mib) }
      : {}),
    max_workspace_mib: Number(form.max_workspace_mib),
  };
}
