import { useState } from "react";
import type { useOrgMachines } from "../../api/queries/agents";
import type { Harness, Machine } from "../../api/types/agents";
import type { OrgModels } from "../../api/types/models";
import { Banner, Button, DialogClose, DialogFooter } from "@guildsrun/ui";
import { DiskBudget } from "../machines/MachineMeters";
import { MachinePicker } from "../machines/MachinePicker";
import { diskBudget, seededDiskMib } from "../machines/machines";
import { ConnectProviderGuide } from "../models/ConnectProviderGuide";
import { CapabilitiesFields } from "./settings/CapabilitiesFields";
import {
  defaultAgentConfig,
  type ConfigErrors,
  type ConfigForm,
  type SettingsAgent,
} from "./settings/configForm";
import { Group } from "./settings/Group";
import { HarnessField } from "./settings/HarnessFields";
import { LimitFields, MaxDiskField, MaxScriptsField } from "./settings/LimitFields";
import { ModelFields } from "./settings/ModelFields";
import { ModelSourceField } from "./settings/ModelSourceField";

/** What every step edits: the config form, its errors, and the machine it names. */
export type StepProps = {
  form: ConfigForm;
  setConfig: (next: ConfigForm) => void;
  errors: ConfigErrors;
  machine: Machine | undefined;
};

/**
 * A new agent's disk cap, seeded from the chosen machine's unreserved disk (`seededDiskMib`) until
 * the operator types one.
 */
export function useSeededDisk() {
  const [typed, setTyped] = useState(false);
  return {
    seed: (form: ConfigForm, machine: Machine | undefined): ConfigForm =>
      typed || !machine
        ? form
        : {
            ...form,
            max_workspace_mib: String(seededDiskMib(machine, defaultAgentConfig.max_workspace_mib)),
          },
    onTyped: () => setTyped(true),
  };
}

/** An existing agent as its machine sees it: its id, and the machine and disk cap it has saved. */
export type PlacedAgent = { id: string; machineId: string; diskMib: number };

type MachineGroupProps = StepProps & {
  machines: ReturnType<typeof useOrgMachines>;
  hint?: string | undefined;
  placed?: PlacedAgent | undefined;
  onDiskTyped?: () => void;
};

/**
 * The machine the agent goes on, with what it adds to that machine's memory, then its disk cap
 * against the disk the machine's other agents reserve. An existing agent's own saved cap is not
 * counted among the others on its current machine.
 */
export function MachineGroup({
  form,
  setConfig,
  errors,
  machine,
  machines,
  hint,
  placed,
  onDiskTyped,
}: MachineGroupProps) {
  const ownMib = placed && machine?.id === placed.machineId ? placed.diskMib : 0;
  const disk = machine ? diskBudget(machine, Number(form.max_workspace_mib) || 0, ownMib) : null;
  return (
    <>
      <Group title="Machine">
        {machines.isError ? (
          <Banner tone="error" title="Couldn't load the machines" meta={machines.error.message} />
        ) : machines.data ? (
          <MachinePicker
            machines={machines.data}
            value={form.machine_id}
            onChange={(machineId) => setConfig({ ...form, machine_id: machineId })}
            agent={{
              id: placed?.id,
              browser: form.browser,
              model_source: form.model_source,
            }}
            error={errors.machine}
            hint={hint}
          />
        ) : null}
      </Group>
      {disk ? (
        <Group title="Disk">
          <MaxDiskField
            form={form}
            onChange={(patch) => {
              onDiskTyped?.();
              setConfig({ ...form, ...patch });
            }}
            errors={errors}
          />
          <DiskBudget {...disk} />
        </Group>
      ) : null}
    </>
  );
}

type ModelStepProps = StepProps & {
  models: OrgModels | undefined;
  noProvider: boolean;
};

/**
 * The choice of model source, the model that runs the agent, its capabilities, and its run limits
 * behind a disclosure.
 */
export function ModelStep({ models, noProvider, ...step }: ModelStepProps) {
  const { form, setConfig, errors, machine } = step;
  const patch = (next: Partial<ConfigForm>) => setConfig({ ...form, ...next });
  return (
    <>
      <Group title="Model">
        <ModelSourceField form={form} onChange={setConfig} />
        {noProvider ? (
          <ConnectProviderGuide what="an agent" />
        ) : (
          <ModelFields form={form} onChange={patch} errors={errors} />
        )}
      </Group>
      <Group title="Agent capabilities">
        <CapabilitiesFields
          form={form}
          onChange={setConfig}
          models={models}
          errors={errors}
          machine={machine}
        />
      </Group>
      <details className="flex flex-col gap-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg-2">Run limits</summary>
        <div className="mt-4 flex flex-col gap-4">
          <LimitFields form={form} onChange={patch} errors={errors} />
          <div className="grid gap-4 md:grid-cols-2">
            <MaxScriptsField form={form} onChange={patch} errors={errors} />
          </div>
        </div>
      </details>
    </>
  );
}

type SubscriptionStepProps = StepProps & {
  models: OrgModels | undefined;
  /** The existing agent whose credentials and readiness the harness shows; undefined while creating one. */
  agent?: SettingsAgent | undefined;
  carried?: readonly Harness[] | null | undefined;
};

/**
 * A subscription agent's step: the choice of model source, the harness it runs on with that
 * harness's model and effort (and, for an existing agent, its credential and readiness), its
 * capabilities, and the run limits its harness keeps.
 */
export function SubscriptionStep({ models, agent, carried, ...step }: SubscriptionStepProps) {
  const { form, setConfig, errors, machine } = step;
  const patch = (next: Partial<ConfigForm>) => setConfig({ ...form, ...next });
  return (
    <>
      <Group title="Harness">
        <ModelSourceField form={form} onChange={setConfig} />
        <HarnessField
          form={form}
          onChange={setConfig}
          errors={errors}
          agent={agent}
          carried={carried}
        />
      </Group>
      <Group title="Agent capabilities">
        <CapabilitiesFields
          form={form}
          onChange={setConfig}
          models={models}
          errors={errors}
          machine={machine}
        />
      </Group>
      <details className="flex flex-col gap-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg-2">Run limits</summary>
        <div className="mt-4 flex flex-col gap-4">
          <LimitFields form={form} onChange={patch} errors={errors} />
          <div className="grid gap-4 md:grid-cols-2">
            <MaxScriptsField form={form} onChange={patch} errors={errors} />
          </div>
        </div>
      </details>
    </>
  );
}

type StepFooterProps = {
  step: number;
  count: number;
  ready: boolean;
  busy: boolean;
  createLabel: string;
  onStep: (step: number) => void;
  onCreate: () => void;
};

/** The dialog's Back, Next, and Create buttons for the step in progress. */
export function StepFooter({
  step,
  count,
  ready,
  busy,
  createLabel,
  onStep,
  onCreate,
}: StepFooterProps) {
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button variant="ghost">Cancel</Button>
      </DialogClose>
      {step > 0 ? (
        <Button variant="outline" disabled={busy} onClick={() => onStep(step - 1)}>
          Back
        </Button>
      ) : null}
      {step < count - 1 ? (
        <Button disabled={!ready} onClick={() => onStep(step + 1)}>
          Next
        </Button>
      ) : (
        <Button disabled={busy || !ready} onClick={onCreate}>
          {busy ? "Creating…" : createLabel}
        </Button>
      )}
    </DialogFooter>
  );
}
