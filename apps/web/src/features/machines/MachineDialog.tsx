import { useState, type FormEvent } from "react";
import { useCreateMachine, useUpdateMachine } from "../../api/queries/agents";
import type { Machine, MachineBox } from "../../api/types/agents";
import { useIdentity } from "../../app/identity";
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  FormField,
  Segmented,
  TextField,
  toast,
} from "@guildsrun/ui";
import {
  customMachineBounds,
  machineBoxLabel,
  machineFormErrors,
  machineFormOf,
  machineInputOf,
  machineSizeLabel,
  machineTiers,
  newMachineForm,
  type MachineForm,
  type MachineFormErrors,
} from "./machines";

const tierHint: Record<MachineBox, string> = {
  standard: `${machineSizeLabel(machineTiers.standard)}. Hosts agents with a browser, scripts, notes and connectors; no coding.`,
  code: `${machineSizeLabel(machineTiers.code)}. Hosts any agent, coding agents included.`,
  custom: `A size you choose, ${customMachineBounds.minCpu} to ${customMachineBounds.maxCpu} CPUs and ${customMachineBounds.minMemoryMib} to ${customMachineBounds.maxMemoryMib} MiB. Hosts any agent, coding agents included.`,
};

const tierOptions = (Object.keys(machineBoxLabel) as MachineBox[]).map((box) => ({
  value: box,
  label: machineBoxLabel[box],
}));

type FieldsProps = {
  form: MachineForm;
  errors: MachineFormErrors;
  onChange: (patch: Partial<MachineForm>) => void;
};

function withoutName({ name: _name, ...rest }: MachineFormErrors): MachineFormErrors {
  return rest;
}

/**
 * The machine form's state and its save: a new machine is created, an existing one updated. Errors
 * show once the form is submitted, except the name's, which shows as soon as one is typed.
 */
function useMachineSubmit(machine: Machine | null, onClose: () => void) {
  const { org } = useIdentity();
  const create = useCreateMachine(org.id);
  const update = useUpdateMachine(org.id);
  const [form, setForm] = useState<MachineForm>(() =>
    machine ? machineFormOf(machine) : newMachineForm,
  );
  const [touched, setTouched] = useState(false);
  const errors = machineFormErrors(form);
  const invalid = Object.keys(errors).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (invalid) return;
    const input = machineInputOf(form);
    const done = (title: string) => () => {
      toast({ kind: "success", title });
      onClose();
    };
    if (machine)
      update.mutate({ machineId: machine.id, input }, { onSuccess: done("Machine saved") });
    else create.mutate(input, { onSuccess: done("Machine added") });
  };

  return {
    form,
    set: (patch: Partial<MachineForm>) => setForm((current) => ({ ...current, ...patch })),
    errors: touched || form.name ? errors : withoutName(errors),
    submit,
    pending: create.isPending || update.isPending,
    blocked: touched && invalid,
    failure: create.error ?? update.error,
  };
}

/** Adds a machine, or renames, resizes and re-caps one; a new tier or size restarts it once idle. */
export function MachineDialog({
  machine,
  onClose,
}: {
  machine: Machine | null;
  onClose: () => void;
}) {
  const { org } = useIdentity();
  const { form, set, errors, submit, pending, blocked, failure } = useMachineSubmit(
    machine,
    onClose,
  );
  const fieldProps = { form, errors, onChange: set };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={machine ? `Edit ${machine.name}` : "Add a machine"}
            description={
              machine
                ? "A new tier or size restarts the machine once none of its agents is generating."
                : `A new machine for ${org.name}'s agents.`
            }
          />
          <DialogBody className="gap-5">
            <NameField {...fieldProps} autoFocus={!machine} />
            <FormField
              controlId="machine-tier"
              label="Tier"
              labelFor={false}
              hint={tierHint[form.box]}
            >
              <Segmented
                size="sm"
                label="Tier"
                value={form.box}
                onValueChange={(box) => set({ box })}
                options={tierOptions}
              />
            </FormField>
            {form.box === "custom" ? <CustomSizeFields {...fieldProps} /> : null}
            <DiskField {...fieldProps} />
            {failure ? (
              <Banner
                tone="error"
                title={machine ? "Couldn't save the machine" : "Couldn't add the machine"}
              >
                {failure.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={pending || blocked}>
              {pending ? "Saving…" : machine ? "Save" : "Add machine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NameField({ form, errors, onChange, autoFocus }: FieldsProps & { autoFocus: boolean }) {
  return (
    <TextField
      tone="surface"
      label="Name"
      mono
      required
      autoFocus={autoFocus}
      autoComplete="off"
      maxLength={63}
      placeholder="browsers"
      value={form.name}
      onChange={(event) => onChange({ name: event.currentTarget.value })}
      {...(errors.name ? { error: errors.name } : {})}
    />
  );
}

/** A custom machine's CPUs and memory, within the bounds the server accepts. */
function CustomSizeFields({ form, errors, onChange }: FieldsProps) {
  const { minCpu, maxCpu, cpuStep, minMemoryMib, maxMemoryMib } = customMachineBounds;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TextField
        tone="surface"
        label="CPUs"
        type="number"
        min={minCpu}
        max={maxCpu}
        step={cpuStep}
        hint={`${minCpu} to ${maxCpu}, in steps of ${cpuStep}.`}
        value={form.cpu}
        onChange={(event) => onChange({ cpu: event.currentTarget.value })}
        {...(errors.cpu ? { error: errors.cpu } : {})}
      />
      <TextField
        tone="surface"
        label="Memory"
        type="number"
        min={minMemoryMib}
        max={maxMemoryMib}
        step={1}
        hint={`MiB, ${minMemoryMib} to ${maxMemoryMib}. 2048 is 2 GiB.`}
        value={form.memory_mib}
        onChange={(event) => onChange({ memory_mib: event.currentTarget.value })}
        {...(errors.memory_mib ? { error: errors.memory_mib } : {})}
      />
    </div>
  );
}

function DiskField({ form, errors, onChange }: FieldsProps) {
  return (
    <TextField
      tone="surface"
      label="Max disk"
      type="number"
      min={1}
      step={1}
      hint="MiB every agent home on this machine may hold together. A generation will not start while the machine is over this. 10240 is 10 GiB."
      value={form.max_workspace_mib}
      onChange={(event) => onChange({ max_workspace_mib: event.currentTarget.value })}
      {...(errors.max_workspace_mib ? { error: errors.max_workspace_mib } : {})}
    />
  );
}
