import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useCreateAgent, useOrgMachines, useOrgModels } from "../../api/queries";
import { hasConnectedProvider } from "../../api/types";
import { useIdentity } from "../../app/identity";
import {
  identityHex,
  Button,
  TextField,
  Banner,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@guildsrun/ui";
import { MachinePicker } from "../machines/MachinePicker";
import { chosenMachine } from "../machines/machines";
import { liveHandleError } from "../names";
import { ConnectProviderGuide } from "../models/ConnectProviderGuide";
import { preselectedModel } from "../models/models";
import { AvatarPicker } from "./settings/AvatarPicker";
import {
  CapabilitiesFields,
  configErrors,
  configFormOf,
  configOf,
  defaultAgentConfig,
  DiskFields,
  LimitFields,
  ModelFields,
  type ConfigForm,
} from "./settings/configForm";
import { focusMax, Group } from "./settings/AgentSettings";

function freshLook() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const seed = Array.from(bytes, (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join(
    "",
  );
  return { shape: `critters:${seed}`, color: identityHex.signal };
}

type CreateAgentDialogProps = {
  guild: { id: string; name: string } | null;
  onClose: () => void;
};

/**
 * A new agent in a guild: its name, look, focus, model, run limits, disk and script caps, the
 * machine it goes on (picked when the organisation has several), and its capabilities. Its focus
 * seeds its Task.
 */
export function CreateAgentDialog({ guild, onClose }: CreateAgentDialogProps) {
  const navigate = useNavigate();
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const machines = useOrgMachines(org.id);
  const create = useCreateAgent(guild?.id ?? "");
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const [look, setLook] = useState(freshLook);
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const [nameStarted, setNameStarted] = useState(false);
  const form =
    config ??
    configFormOf({
      ...defaultAgentConfig,
      model: preselectedModel(models.data, { coding: false }),
    });
  const errors = configErrors(form, { models: models.data, machines: machines.data });
  const machine = chosenMachine(machines.data, form.machine_id);
  const nameError = liveHandleError(name, nameStarted, "agent");
  const noProvider = hasConnectedProvider(models.data) === false;
  const invalid =
    Boolean(nameError) || !name.trim() || Object.keys(errors).length > 0 || !machines.data;

  const close = () => {
    setName("");
    setFocus("");
    setLook(freshLook());
    setConfig(null);
    setNameStarted(false);
    create.reset();
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!guild || invalid) return;
    create.mutate(
      {
        name: name.trim(),
        focus: focus.trim(),
        avatar_shape: look.shape,
        avatar_color: look.color,
        config: configOf(form, models.data),
        ...(machine ? { machine_id: machine.id } : {}),
      },
      {
        onSuccess: (agent) => {
          const guildId = guild.id;
          close();
          void navigate({
            to: "/guilds/$guildId/agents/$agentId/prompt",
            params: { guildId, agentId: agent.id },
          });
        },
      },
    );
  };

  return (
    <Dialog open={guild !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="lg">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="Create an agent"
            description={`A new member of ${guild?.name ?? "the guild"}.`}
          />
          <DialogBody className="gap-6">
            <Group title="Identity">
              <TextField
                tone="surface"
                label="Name"
                mono
                required
                autoFocus
                autoComplete="off"
                placeholder="researcher"
                hint="Other agents tag it with @name. You can change it later in Settings."
                value={name}
                onChange={(event) => {
                  setNameStarted(true);
                  setName(event.currentTarget.value);
                }}
                onBlur={() => setNameStarted(true)}
                {...(nameError ? { error: nameError } : {})}
              />
              <TextField
                tone="surface"
                label="Focus"
                aside="optional"
                maxLength={focusMax}
                showCount
                placeholder="What this agent is for"
                hint="Other agents see it next to its name; it also starts its Task, which you write on the Prompt tab."
                value={focus}
                onChange={(event) => setFocus(event.currentTarget.value)}
              />
              <AvatarPicker
                name={name || "agent"}
                shape={look.shape}
                color={look.color}
                onChange={setLook}
              />
            </Group>
            <Group title="Model">
              {noProvider ? (
                <ConnectProviderGuide what="an agent" />
              ) : (
                <ModelFields
                  form={form}
                  onChange={(patch) => setConfig({ ...form, ...patch })}
                  errors={errors}
                />
              )}
            </Group>
            <Group title="Run limits">
              <LimitFields
                form={form}
                onChange={(patch) => setConfig({ ...form, ...patch })}
                errors={errors}
              />
            </Group>
            <Group title="Disk">
              <DiskFields
                form={form}
                onChange={(patch) => setConfig({ ...form, ...patch })}
                errors={errors}
              />
            </Group>
            <Group title="Machine">
              {machines.isError ? (
                <Banner
                  tone="error"
                  title="Couldn't load the machines"
                  meta={machines.error.message}
                />
              ) : machines.data ? (
                <MachinePicker
                  machines={machines.data}
                  value={form.machine_id}
                  onChange={(machineId) => setConfig({ ...form, machine_id: machineId })}
                  agent={{ browser: form.browser, coding: form.coding }}
                  error={errors.machine}
                />
              ) : null}
            </Group>
            <Group title="Agent capabilities">
              <CapabilitiesFields
                form={form}
                onChange={(next) => setConfig(next)}
                models={models.data}
                machine={machine}
              />
            </Group>
            {create.isError ? (
              <Banner tone="error" title="Couldn't create the agent">
                {create.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending || invalid || noProvider}>
              {create.isPending ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
