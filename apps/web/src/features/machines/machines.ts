import type { OrgRole } from "../../api/types/org";
import type { Machine, MachineBox, MachineInput } from "../../api/types/agents";

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

/** A machine's CPUs and memory. */
export type MachineSize = { cpu: number; memory_mib: number };

/**
 * Machine sizing, as the server rules it (docs/concepts/machines.md#machine-sizing): the
 * smallest machine an agent runs on, by what it has on. An agent's minimum is the largest of these,
 * CPUs and memory each, not their sum. A machine below it refuses the agent.
 */
export const agentMinimums = {
  base: { cpu: 0.5, memory_mib: 256 },
  browser: { cpu: 1, memory_mib: 2048 },
  coding: { cpu: 2, memory_mib: 4096 },
} as const satisfies Record<string, MachineSize>;

/**
 * How far a machine's agents may oversubscribe it before placement warns, as the server rules it:
 * the sum of their minimums against these multiples of its CPUs and memory. Few agents work at
 * once; memory gets the lower factor because running out of it kills processes.
 */
export const overcommit = { cpu: 5, memory: 3 } as const;

/** What an agent has on that sets its minimum. */
export type AgentNeeds = { browser: boolean; coding: boolean };

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

/** The smallest machine an agent runs on: the largest of the minimums of what it has on. */
export function agentMinimum(needs: AgentNeeds): MachineSize {
  const parts: MachineSize[] = [
    agentMinimums.base,
    ...(needs.browser ? [agentMinimums.browser] : []),
    ...(needs.coding ? [agentMinimums.coding] : []),
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

/** The planned load a machine takes before placement warns: its size times `overcommit`. */
export function machineCapacity(size: MachineSize): MachineSize {
  return { cpu: size.cpu * overcommit.cpu, memory_mib: size.memory_mib * overcommit.memory };
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
export function machineSizeLabel(machine: MachineSize): string {
  return `${machine.cpu} CPU · ${formatMib(machine.memory_mib)}`;
}

/** The sizing rules in a sentence, for every place that shows a machine's planned load. */
export const sizingNote =
  `Each agent counts its minimum: ${machineSizeLabel(agentMinimums.base)}, ` +
  `${machineSizeLabel(agentMinimums.browser)} with a browser, ` +
  `${machineSizeLabel(agentMinimums.coding)} with coding. A machine takes up to ` +
  `${overcommit.cpu}× its CPUs and ${overcommit.memory}× its memory in minimums before it warns, ` +
  `since few agents work at once.`;

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

/** A machine's planned load on one resource: what is there, what a placement adds, and the capacity. */
export type LoadShare = { planned: number; adds: number; capacity: number; over: boolean };

/** What adding `adds` to a machine's planned load does, CPUs and memory each. */
export function loadShares(
  machine: MachineSize & { planned_cpu: number; planned_mib: number },
  adds: MachineSize = { cpu: 0, memory_mib: 0 },
): { cpu: LoadShare; memory: LoadShare } {
  const capacity = machineCapacity(machine);
  const share = (planned: number, add: number, cap: number): LoadShare => ({
    planned,
    adds: add,
    capacity: cap,
    over: planned + add > cap,
  });
  return {
    cpu: share(machine.planned_cpu, adds.cpu, capacity.cpu),
    memory: share(machine.planned_mib, adds.memory_mib, capacity.memory_mib),
  };
}

/**
 * What an agent placed on a machine does to it: whether the machine meets the agent's minimum, and
 * the machine's planned load without the agent with what it adds. An agent already on the machine
 * counts once, with the needs it is given here.
 */
export function placementBudget(
  machine: Pick<Machine, "cpu" | "memory_mib" | "planned_cpu" | "planned_mib" | "agents">,
  agent: { id?: string | undefined } & AgentNeeds,
): { fits: boolean; minimum: MachineSize; planned: MachineSize; adds: MachineSize } {
  const current = machine.agents.find((item) => item.id === agent.id);
  const own = current ? agentMinimum(current) : { cpu: 0, memory_mib: 0 };
  const minimum = agentMinimum(agent);
  return {
    fits: sizeMeets(machine, minimum),
    minimum,
    planned: {
      cpu: machine.planned_cpu - own.cpu,
      memory_mib: machine.planned_mib - own.memory_mib,
    },
    adds: minimum,
  };
}

/** The smallest disk cap a new agent is seeded with from a machine's unreserved disk. */
export const minSeededDiskMib = 1024;

/**
 * What an agent's own disk cap does to its machine's disk: the free disk as last measured (null
 * before a measure), what the other agents' caps reserve, the room they leave unreserved, and
 * whether this cap passes it, so the machine's cap could stop the agent before its own does. An
 * agent already on the machine gives its saved cap as `ownMib`, which the reserve then leaves out.
 */
export function diskBudget(
  machine: Pick<Machine, "max_workspace_mib" | "workspace_mib" | "allocated_workspace_mib">,
  capMib: number,
  ownMib = 0,
): {
  freeMib: number | null;
  othersMib: number;
  unreservedMib: number;
  addsMib: number;
  machineMib: number;
  over: boolean;
} {
  const machineMib = machine.max_workspace_mib;
  const othersMib = Math.max(0, machine.allocated_workspace_mib - ownMib);
  const unreservedMib = Math.max(0, machineMib - othersMib);
  return {
    freeMib:
      machine.workspace_mib === null ? null : Math.max(0, machineMib - machine.workspace_mib),
    othersMib,
    unreservedMib,
    addsMib: capMib,
    machineMib,
    over: capMib > unreservedMib,
  };
}

/**
 * The disk cap a new agent starts with on a machine: the default, or the machine's unreserved disk
 * when that is smaller and still at least `minSeededDiskMib`. Below that, the default stands and
 * the budget warns.
 */
export function seededDiskMib(
  machine: Pick<Machine, "max_workspace_mib" | "allocated_workspace_mib">,
  defaultMib: number,
): number {
  const unreserved = machine.max_workspace_mib - machine.allocated_workspace_mib;
  return unreserved >= minSeededDiskMib ? Math.min(defaultMib, unreserved) : defaultMib;
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
