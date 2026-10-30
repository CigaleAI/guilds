import type { Machine } from "../../api/types/agents";
import { Select } from "@guildsrun/ui";
import { LoadBudget } from "./MachineMeters";
import { MachinesSettingsLink, NoMachines, TooSmallNote } from "./MachineNotes";
import {
  chosenMachine,
  machineBoxLabel,
  machineSizeLabel,
  placementBudget,
  sharedMachineNote,
  sizeMeets,
  agentMinimum,
} from "./machines";

type PlacedAgent = { id?: string | undefined; browser: boolean; coding: boolean };

/**
 * Where an agent goes: a Machine picker when the organisation has several machines, else the only
 * one by name, or a pointer to Settings → Machines when it has none. Machines below the agent's
 * minimum are offered disabled. Under it, the machine's planned load with what this agent adds,
 * and what sharing a machine means.
 */
export function MachinePicker({
  machines,
  value,
  onChange,
  agent,
  error,
  hint,
}: {
  machines: Machine[];
  value: string;
  onChange: (machineId: string) => void;
  /** The agent being placed: its id when it already exists, and its flags as the form holds them. */
  agent: PlacedAgent;
  error?: string | undefined;
  hint?: string | undefined;
}) {
  const [only] = machines;
  if (!only) return <NoMachines />;
  const machine = chosenMachine(machines, value);
  return (
    <div className="flex flex-col gap-3">
      {machines.length > 1 ? (
        <Select
          tone="surface"
          label="Machine"
          placeholder="Choose a machine"
          className="max-w-md"
          value={machine?.id ?? ""}
          onValueChange={onChange}
          options={machines.map((item) => {
            const fits = sizeMeets(item, agentMinimum(agent)) || item.id === machine?.id;
            return {
              value: item.id,
              label: `${item.name} · ${machineBoxLabel[item.box]} · ${machineSizeLabel(item)}${fits ? "" : " · too small"}`,
              disabled: !fits,
            };
          })}
          hint={hint}
          {...(error ? { error } : {})}
        />
      ) : (
        <p className="text-sm text-fg-2">
          Runs on <span className="font-mono">{only.name}</span>, the organisation's only machine (
          {machineBoxLabel[only.box]}, {machineSizeLabel(only)}). Add machines under{" "}
          <MachinesSettingsLink />.
        </p>
      )}
      {machine ? <PlacementBudget machine={machine} agent={agent} /> : null}
      <p className="text-sm text-muted">{sharedMachineNote}</p>
    </div>
  );
}

/** Whether the machine meets the agent's minimum, and its planned load with what the agent adds. */
function PlacementBudget({ machine, agent }: { machine: Machine; agent: PlacedAgent }) {
  const budget = placementBudget(machine, agent);
  return (
    <>
      {budget.fits ? null : (
        <TooSmallNote machine={machine} minimum={budget.minimum} what="This agent" />
      )}
      <LoadBudget
        size={machine}
        planned={budget.planned}
        adds={budget.adds}
        addsLabel="this agent's minimum"
        remedy="resize it or pick another machine"
      />
    </>
  );
}
