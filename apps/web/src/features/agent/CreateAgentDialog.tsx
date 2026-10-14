import { useNavigate } from "@tanstack/react-router";
import { Bot, Code2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useCreateAgent, useOrgMachines, useOrgModels } from "../../api/queries";
import { hasConnectedProvider } from "../../api/types";
import { useIdentity } from "../../app/identity";
import {
  Button,
  Banner,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
} from "@guildsrun/ui";
import { MachinePicker } from "../machines/MachinePicker";
import { chosenMachine } from "../machines/machines";
import { ConnectProviderGuide } from "../models/ConnectProviderGuide";
import { preselectedModel } from "../models/models";
import { CodingAgentForm } from "./CreateCodingAgent";
import { identityComplete, IdentityFields, useIdentityDraft } from "./IdentityFields";
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
import { Group } from "./settings/AgentSettings";

export type CreateAgentGuild = { id: string; name: string };

type Kind = "standard" | "coding";

type CreateAgentDialogProps = {
  guild: CreateAgentGuild | null;
  onClose: () => void;
};

function KindCard({
  icon,
  title,
  hint,
  onPick,
}: {
  icon: typeof Bot;
  title: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex min-w-0 cursor-pointer flex-col items-start gap-2 rounded-xl bg-surface px-4 py-4 text-left inset-ring inset-ring-line-3 transition-colors hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="flex items-center gap-2 text-base font-semibold text-fg">
        <Icon icon={icon} size={18} />
        {title}
      </span>
      <span className="text-sm text-pretty text-fg-2">{hint}</span>
    </button>
  );
}

/** The first screen: which kind of agent to create, since the two take different settings. */
function KindChooser({ guild, onPick }: { guild: CreateAgentGuild; onPick: (kind: Kind) => void }) {
  return (
    <>
      <DialogHeader title="Create an agent" description={`A new member of ${guild.name}.`} />
      <DialogBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <KindCard
            icon={Bot}
            title="Agent"
            hint="Talks, researches, and works with tools and connectors on one of the organisation's models."
            onPick={() => onPick("standard")}
          />
          <KindCard
            icon={Code2}
            title="Coding agent"
            hint="Leads code work in the guild's repositories, delegated to a coding harness (Claude Code, Codex, or Cursor) on your own subscription."
            onPick={() => onPick("coding")}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}

/**
 * A new agent without coding: its name, look, focus, model, run limits, disk and script caps,
 * the machine it goes on (picked when the organisation has several), and its capabilities. Its
 * focus seeds its Task.
 */
function StandardAgentForm({ guild, onClose }: { guild: CreateAgentGuild; onClose: () => void }) {
  const navigate = useNavigate();
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const machines = useOrgMachines(org.id);
  const create = useCreateAgent(guild.id);
  const identity = useIdentityDraft();
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const form =
    config ??
    configFormOf({
      ...defaultAgentConfig,
      model: preselectedModel(models.data, { coding: false }),
    });
  const errors = configErrors(form, { models: models.data, machines: machines.data });
  const machine = chosenMachine(machines.data, form.machine_id);
  const noProvider = hasConnectedProvider(models.data) === false;
  const invalid =
    !identityComplete(identity.draft) || Object.keys(errors).length > 0 || !machines.data;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
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
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader title="Create an agent" description={`A new member of ${guild.name}.`} />
      <DialogBody className="gap-6">
        <Group title="Identity">
          <IdentityFields draft={identity.draft} onChange={identity.setDraft} />
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
            <Banner tone="error" title="Couldn't load the machines" meta={machines.error.message} />
          ) : machines.data ? (
            <MachinePicker
              machines={machines.data}
              value={form.machine_id}
              onChange={(machineId) => setConfig({ ...form, machine_id: machineId })}
              agent={{ browser: form.browser, coding: false }}
              error={errors.machine}
            />
          ) : null}
        </Group>
        <Group title="Agent capabilities">
          <CapabilitiesFields
            form={form}
            onChange={(next) => setConfig(next)}
            errors={errors}
            models={models.data}
            machine={machine}
            codingToggle={false}
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
  );
}

/**
 * A new agent in a guild. The first screen asks which kind: an agent, or a coding agent, whose
 * dialog walks through its harness, lead model, and repositories.
 */
export function CreateAgentDialog({ guild, onClose }: CreateAgentDialogProps) {
  const [kind, setKind] = useState<Kind | null>(null);
  const close = () => {
    setKind(null);
    onClose();
  };
  return (
    <Dialog open={guild !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="lg">
        {guild === null ? null : kind === null ? (
          <KindChooser guild={guild} onPick={setKind} />
        ) : kind === "standard" ? (
          <StandardAgentForm guild={guild} onClose={close} />
        ) : (
          <CodingAgentForm guild={guild} onClose={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}
