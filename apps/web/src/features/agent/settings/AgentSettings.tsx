import { useParams } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  useAgent,
  useAgentHarness,
  useOrgMachines,
  useOrgModels,
  useSaveAgentSettings,
} from "../../../api/queries";
import type { AgentDetail } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { Button, TextAreaField, TextField, Banner, SkeletonRows, toast } from "@guildsrun/ui";
import { MachinePicker } from "../../machines/MachinePicker";
import { chosenMachine } from "../../machines/machines";
import { agentHandleError, handleHint } from "../../names";
import { AvatarPicker } from "./AvatarPicker";
import {
  CapabilitiesFields,
  configErrors,
  configFormOf,
  configOf,
  DiskFields,
  harnessFieldId,
  LimitFields,
  ModelFields,
  type ConfigForm,
} from "./configForm";

/** The server's cap on an agent's focus. */
export const focusMax = 150;

/** The server's cap on an agent's wake triggers. */
const wakeTriggersMax = 500;

type Form = ConfigForm & {
  name: string;
  focus: string;
  wakeTriggers: string;
  shape: string;
  color: string;
};

function formOf(agent: AgentDetail): Form {
  return {
    ...configFormOf(agent.config, agent.machine_id),
    name: agent.name,
    focus: agent.focus,
    wakeTriggers: agent.wake_triggers,
    shape: agent.avatar_shape,
    color: agent.avatar_color,
  };
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="type-label text-muted">{title}</h3>
      {children}
    </section>
  );
}

/** Brings the Harness select into view and focuses it. */
function focusHarnessField() {
  const field = document.getElementById(harnessFieldId);
  field?.scrollIntoView({ block: "center", behavior: "smooth" });
  field?.focus({ preventScroll: true });
}

/** A coding agent without a harness: native coding is gone, and its coding runs fail until one is picked. */
function HarnessMissingNotice({ coding }: { coding: boolean }) {
  return (
    <Banner
      tone="warning"
      title="Native coding is no longer available"
      action={
        coding ? (
          <Button variant="outline" size="sm" onClick={focusHarnessField}>
            Pick a harness
          </Button>
        ) : undefined
      }
    >
      This agent needs a harness to run with Coding on: pick Claude Code, Codex or Cursor under
      Agent capabilities and save, or turn Coding off.
    </Banner>
  );
}

/**
 * How the agent looks and runs: its name, focus and mascot, what wakes it in group chat, its model
 * and reasoning, its run limits, its disk and script caps, its machine (a picker when the
 * organisation has several; a new one moves the agent there), and its capabilities (Browser,
 * Coding, CLI, scripting, Memory; Coding is greyed out on a standard machine, the browser's
 * language shows while it is on, and the harness with its credentials while Coding is). A coding
 * agent without a harness opens on a notice that leads to the Harness select.
 */
export function AgentSettings() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const machines = useOrgMachines(org.id);
  const save = useSaveAgentSettings(agentId, guildId);
  const harness = useAgentHarness(agentId);
  const [draft, setDraft] = useState<Form | null>(null);

  const saved = useMemo(() => (agent.data ? formOf(agent.data) : null), [agent.data]);
  const form = draft ?? saved;

  if (!agent.data || !form || !saved) {
    return (
      <div className="p-7">
        <SkeletonRows rows={6} label="Loading settings" />
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = (patch: Partial<Form>) => setDraft({ ...form, ...patch });
  const errors = configErrors(form, { models: models.data, machines: machines.data });
  const machine = chosenMachine(machines.data, form.machine_id);
  const moveTo = machine && machine.id !== agent.data.machine_id ? machine.id : undefined;
  const carried = moveTo
    ? machine?.harnesses
    : (harness.data?.machine_harnesses ?? machine?.harnesses);
  const nameError = form.name.trim() ? agentHandleError(form.name.trim()) : handleHint;
  const invalid = Boolean(nameError) || Object.keys(errors).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    save.mutate(
      {
        name: form.name.trim(),
        config: configOf(form, models.data),
        ...(moveTo ? { machine_id: moveTo } : {}),
        focus: form.focus.trim(),
        wake_triggers: form.wakeTriggers.trim(),
        avatar_shape: form.shape,
        avatar_color: form.color,
      },
      {
        onSuccess: () => {
          setDraft(null);
          toast({ kind: "success", title: "Settings saved" });
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex max-w-240 flex-col gap-7">
          {agent.data.deprecated === "coding.harness_missing" ? (
            <HarnessMissingNotice coding={form.coding} />
          ) : null}
          <Group title="Identity">
            <TextField
              tone="surface"
              label="Name"
              mono
              required
              autoComplete="off"
              maxLength={63}
              placeholder="researcher"
              hint="Other agents tag it with @name."
              value={form.name}
              onChange={(event) => set({ name: event.currentTarget.value })}
              {...(nameError ? { error: nameError } : {})}
            />
            <TextField
              tone="surface"
              label="Focus"
              maxLength={focusMax}
              showCount
              placeholder="What this agent is for"
              hint="A short line other agents see next to its name."
              value={form.focus}
              onChange={(event) => set({ focus: event.currentTarget.value })}
            />
            <AvatarPicker
              name={form.name.trim() || agent.data.name}
              shape={form.shape}
              color={form.color}
              onChange={(look) => set({ shape: look.shape, color: look.color })}
            />
          </Group>
          <Group title="Group chat">
            <TextAreaField
              tone="surface"
              font="sans"
              rows={3}
              label="Wake me when"
              aside="optional"
              maxLength={wakeTriggersMax}
              showCount
              placeholder={form.focus.trim() || "A message asks for what this agent does"}
              hint="The untagged messages this agent should answer. Left empty, its focus stands in."
              value={form.wakeTriggers}
              onChange={(event) => set({ wakeTriggers: event.currentTarget.value })}
            />
          </Group>
          <Group title="Model">
            <ModelFields form={form} onChange={set} errors={errors} />
          </Group>
          <Group title="Run limits">
            <LimitFields form={form} onChange={set} errors={errors} />
          </Group>
          <Group title="Disk">
            <DiskFields form={form} onChange={set} errors={errors} />
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
                onChange={(machineId) => set({ machine_id: machineId })}
                agent={{ id: agent.data.id, browser: form.browser, coding: form.coding }}
                error={errors.machine}
                hint={
                  moveTo
                    ? "Saving moves the agent and its home there. It can't move while it is generating."
                    : undefined
                }
              />
            ) : null}
          </Group>
          <Group title="Agent capabilities">
            <CapabilitiesFields
              form={form}
              onChange={(next) => set(next)}
              errors={errors}
              models={models.data}
              machine={machine}
              agent={{ guildId, agentId }}
              carried={carried}
            />
          </Group>
          {save.isError ? (
            <Banner tone="error" title="Couldn't save the settings">
              {save.error.message}
            </Banner>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface px-7 py-3">
        {dirty ? <span className="mr-auto text-sm text-muted">Unsaved changes</span> : null}
        <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
          Discard
        </Button>
        <Button type="submit" disabled={!dirty || invalid || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
