import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCreateAgent, useHarnessCatalog, useOrgMachines } from "../../api/queries/agents";
import { useOrgModels } from "../../api/queries/models";
import { hasConnectedProvider } from "../../api/types/models";
import { useIdentity } from "../../app/identity";
import { Banner, DialogBody, DialogHeader, Stepper } from "@guildsrun/ui";
import { chosenMachine } from "../machines/machines";
import { preselectedModel } from "../models/models";
import { MachineGroup, ModelStep, StepFooter, SubscriptionStep, useSeededDisk } from "./AgentSteps";
import { identityComplete, IdentityFields, useIdentityDraft } from "./IdentityFields";
import {
  configErrors,
  configFormOf,
  configOf,
  defaultAgentConfig,
  type ConfigForm,
} from "./settings/configForm";
import { modelStepComplete, sectionErrors, sectionHasErrors } from "./settings/sections";
import { Group } from "./settings/Group";

type CreateAgentGuild = { id: string; name: string };

const STEPS = ["Identity", "Model", "Machine"] as const;

type StandardAgentFormProps = {
  guild: CreateAgentGuild;
  onClose: () => void;
};

/**
 * A new agent without coding, step by step: its identity; its model source, a model on a key or a
 * subscription on a harness, with its capabilities and run limits; and the machine it goes on,
 * with its disk cap. Its focus seeds its Task.
 */
export function StandardAgentForm({ guild, onClose }: StandardAgentFormProps) {
  const navigate = useNavigate();
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const machines = useOrgMachines(org.id);
  const catalog = useHarnessCatalog();
  const create = useCreateAgent(guild.id);
  const identity = useIdentityDraft();
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const disk = useSeededDisk();
  const base =
    config ??
    configFormOf(
      { ...defaultAgentConfig, model: preselectedModel(models.data, { coding: false }) },
      "key",
    );
  const machine = chosenMachine(machines.data, base.machine_id);
  const form = disk.seed(base, machine);
  const errors = configErrors(form, { models: models.data, machines: machines.data, harnesses: catalog.data });
  const noProvider = hasConnectedProvider(models.data) === false;
  const ready = [
    identityComplete(identity.draft),
    modelStepComplete(form, errors, noProvider),
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
        {step === 1 && form.model_source === "subscription" ? (
          <SubscriptionStep
            form={form}
            setConfig={setConfig}
            errors={errors}
            machine={machine}
            models={models.data}
          />
        ) : null}
        {step === 1 && form.model_source === "key" ? (
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
