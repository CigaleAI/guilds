import type { ApplyMachine, ApplyPreview } from "../../api/types";
import { Select } from "@guildsrun/ui";
import { LoadBudget } from "../machines/MachineMeters";
import { MachinesSettingsLink, NoMachines } from "../machines/MachineNotes";
import { machineBoxLabel, machineSizeLabel, sharedMachineNote } from "../machines/machines";

/**
 * The machine every agent of the recipe goes on: a picker when the organisation has several, else
 * the only one by name, or a pointer to Settings → Machines when it has none. Machines below the
 * smallest machine every role runs on are offered disabled. Under it, the machine's planned load
 * with what the recipe's agents add, and the server's findings about the machine.
 */
export function ApplyMachinePicker({
  preview,
  onChange,
}: {
  preview: ApplyPreview;
  onChange: (machineId: string) => void;
}) {
  const [only] = preview.machines;
  if (!only) return <NoMachines />;
  const machine = preview.machines.find((item) => item.id === preview.machine_id);
  const minimum = { cpu: preview.minimum_cpu, memory_mib: preview.minimum_mib };
  return (
    <section aria-label="Machine" className="flex flex-col gap-3">
      {preview.machines.length > 1 ? (
        <Select
          tone="surface"
          label="Machine"
          placeholder="Choose a machine"
          className="max-w-md"
          value={preview.machine_id ?? ""}
          onValueChange={onChange}
          options={preview.machines.map((item) => ({
            value: item.id,
            label: machineLabel(item),
            disabled: !item.fits && item.id !== preview.machine_id,
          }))}
          hint={`Every agent of the recipe goes on this machine. It needs at least ${machineSizeLabel(minimum)}.`}
        />
      ) : (
        <p className="text-sm text-fg-2">
          The agents go on <span className="font-mono">{only.name}</span>, the organisation's only
          machine ({machineBoxLabel[only.box]}, {machineSizeLabel(only)}). They need at least{" "}
          {machineSizeLabel(minimum)}.
        </p>
      )}
      {machine ? (
        <LoadBudget
          size={machine}
          planned={{ cpu: machine.planned_cpu, memory_mib: machine.planned_mib }}
          adds={{ cpu: preview.adds_cpu, memory_mib: preview.adds_mib }}
          addsLabel="the recipe's agents' minimums"
          remedy="resize it or pick another machine"
        />
      ) : null}
      {machine ? <MachineFindings preview={preview} /> : null}
      <p className="text-sm text-muted">{sharedMachineNote}</p>
    </section>
  );
}

function machineLabel(machine: ApplyMachine): string {
  return `${machine.name} · ${machineBoxLabel[machine.box]} · ${machineSizeLabel(machine)}${machine.fits ? "" : " · too small"}`;
}

/** What the server refuses about the chosen machine, with where machines are created and resized. */
function MachineFindings({ preview }: { preview: ApplyPreview }) {
  const findings = preview.errors.filter((finding) => finding.code.startsWith("machine."));
  if (!findings.length) return null;
  return (
    <div className="flex flex-col gap-1 text-sm text-plum-t">
      {findings.map((finding, index) => (
        <p key={`${finding.code}:${index}`}>{finding.message}</p>
      ))}
      <p>
        Pick another machine, or create or resize one under <MachinesSettingsLink />.
      </p>
    </div>
  );
}
