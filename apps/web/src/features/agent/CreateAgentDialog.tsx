import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useCreateAgent, useModels, useOrgModelKeys } from "../../api/queries";
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
import { agentHandleError } from "../names";
import { AvatarPicker } from "./settings/AvatarPicker";
import {
  BoxPicker,
  BrowserLanguageField,
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
 * A new agent in a guild: its name, look, focus, model, and the box it runs on. Its focus seeds
 * its Task. Lite is the default; Standard turns coding and the browser on together.
 */
export function CreateAgentDialog({ guild, onClose }: CreateAgentDialogProps) {
  const navigate = useNavigate();
  const models = useModels();
  const { org } = useIdentity();
  const modelKeys = useOrgModelKeys(org.id);
  const create = useCreateAgent(guild?.id ?? "");
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const [look, setLook] = useState(freshLook);
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const form =
    config ??
    configFormOf({
      ...defaultAgentConfig,
      model: models.data?.default ?? defaultAgentConfig.model,
    });
  const errors = configErrors(form, {
    catalog: models.data,
    connectedProviders: modelKeys.isSuccess ? modelKeys.data.map((item) => item.provider) : undefined,
  });
  const nameError = agentHandleError(name.trim());

  const close = () => {
    setName("");
    setFocus("");
    setLook(freshLook());
    setConfig(null);
    create.reset();
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!guild || nameError || Object.keys(errors).length) return;
    create.mutate(
      {
        name: name.trim(),
        focus: focus.trim(),
        avatar_shape: look.shape,
        avatar_color: look.color,
        config: configOf(form, models.data),
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
                onChange={(event) => setName(event.currentTarget.value)}
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
              <ModelFields
                form={form}
                onChange={(patch) => setConfig({ ...form, ...patch })}
                errors={errors}
              />
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
            <Group title="Box">
              <BoxPicker
                form={form}
                onChange={(next) => setConfig(next)}
                catalog={models.data}
                error={errors.box}
              />
              {form.box === "standard" ? (
                <BrowserLanguageField form={form} onChange={(next) => setConfig(next)} />
              ) : null}
            </Group>
            <Group title="Agent capabilities">
              <CapabilitiesFields form={form} onChange={(next) => setConfig(next)} />
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
            <Button type="submit" disabled={create.isPending || !name.trim() || Boolean(nameError)}>
              {create.isPending ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
