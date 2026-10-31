import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCreateAgent, useOrgMachines } from "../../api/queries/agents";
import { useOrgModels } from "../../api/queries/models";
import { hasConnectedProvider } from "../../api/types/models";
import { useIdentity } from "../../app/identity";
import { Banner, DialogBody, DialogHeader, Stepper } from "@guildsrun/ui";
import { chosenMachine } from "../machines/machines";
import { preselectedModel } from "../models/models";
import { MachineGroup, ModelStep, StepFooter, useSeededDisk } from "./AgentSteps";
import { identityComplete, IdentityFields, useIdentityDraft } from "./IdentityFields";
import {
  configErrors,
  configFormOf,
  configOf,
  defaultAgentConfig,
  type ConfigForm,
} from "./settings/configForm";
import { sectionErrors, sectionHasErrors } from "./settings/sections";
import { Group } from "./settings/Group";

type CreateAgentGuild = { id: string; name: string };

const STEPS = ["Identity", "Model", "Machine"] as const;

type StandardAgentFormProps = {
  guild: CreateAgentGuild;
  onClose: () => void;
};

/**
 * A new agent without coding, step by step: its identity; the model that runs it, with its
 * capabilities and run limits; and the machine it goes on, with its disk cap. Its focus seeds its
 * Task.
 */
export function StandardAgentForm({ guild, onClose }: StandardAgentFormProps) {
  const navigate = useNavigate();
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const machines = useOrgMachines(org.id);
  const create = useCreateAgent(guild.id);
  const identity = useIdentityDraft();
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const disk = useSeededDisk();
  const base =
    config ??
    configFormOf({
      ...defaultAgentConfig,
      model: preselectedModel(models.data, { coding: false }),
    });
  const machine = chosenMachine(machines.data, base.machine_id);
  const form = disk.seed(base, machine);
  const errors = configErrors(form, { models: models.data, machines: machines.data });
  const noProvider = hasConnectedProvider(models.data) === false;
  const ready = [
    identityComplete(identity.draft),
    !noProvider && !sectionHasErrors(sectionErrors.model, errors),
    Boolean(machines.data) && !sectionHasErrors(sectionErrors.machine, errors),
  ][step];

  const submit = () => {
    create.mutate(
      {
        name: identity.draft.name.trim(),
        focus: identity.draft.focus.trim(),
        avatar_shape: identity.draft.look.shape,
        avatar_color: identity.draft.look.color,
        config: configOf(form, models.data),
        ...(machine ? { machine_id: machine.id } : {}),
      },
      {
        onSuccess: (agent) => {
          onClose();
          void navigate({
            to: "/guilds/$guildId/agents/$agentId/prompt",
            params: { guildId: guild.id, agentId: agent.id },
          });
        },
      },
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <DialogHeader
        title="Create an agent"
        description={`Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`}
      />
      <DialogBody className="gap-6">
        <Stepper steps={[...STEPS]} current={step} />
        {step === 0 ? (
          <Group title="Identity">
            <IdentityFields draft={identity.draft} onChange={identity.setDraft} />
          </Group>
        ) : null}
        {step === 1 ? (
          <ModelStep
            form={form}
            setConfig={setConfig}
            errors={errors}
            machine={machine}
            lead={false}
            models={models.data}
            noProvider={noProvider}
          />
        ) : null}
        {step === 2 ? (
          <MachineGroup
            form={form}
            setConfig={setConfig}
            errors={errors}
            machine={machine}
            machines={machines}
            coding={false}
            onDiskTyped={disk.onTyped}
          />
        ) : null}
        {create.isError ? (
          <Banner tone="error" title="Couldn't create the agent">
            {create.error.message}
          </Banner>
        ) : null}
      </DialogBody>
      <StepFooter
        step={step}
        count={STEPS.length}
        ready={ready ?? false}
        busy={create.isPending}
        createLabel="Create agent"
        onStep={setStep}
        onCreate={submit}
      />
    </div>
  );
}
