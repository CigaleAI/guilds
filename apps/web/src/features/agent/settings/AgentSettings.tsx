import { useParams } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAgent, useOrgModels, useSaveAgentSettings } from "../../../api/queries";
import type { AgentDetail } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { Button, TextAreaField, TextField, Banner, SkeletonRows, toast } from "@guildsrun/ui";
import { agentHandleError, handleHint } from "../../names";
import { AvatarPicker } from "./AvatarPicker";
import {
  BoxFields,
  BoxPicker,
  CapabilitiesFields,
  configErrors,
  configFormOf,
  configOf,
  DiskFields,
  LimitFields,
  ModelFields,
  type ConfigForm,
} from "./configForm";

/** A workspace size in MiB, in GiB from 1 GiB up. */
export function formatMib(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${mib} MiB`;
}

/** The server's cap on an agent's focus. */
export const focusMax = 150;

/** The server's cap on an agent's wake triggers. */
const wakeTriggersMax = 500;

type Form = ConfigForm & { name: string; focus: string; wakeTriggers: string; shape: string; color: string };

function formOf(agent: AgentDetail): Form {
  return {
    ...configFormOf(agent.config),
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

/**
 * How the agent looks and runs: its name, focus and mascot, what wakes it in group chat, its model
 * and reasoning, its run limits, its disk and script caps, its box (Lite, Standard, Code or Custom,
 * and on a custom one its size and the Coding switch), and its extras (Browser, CLI, scripting,
 * Memory; Browser is off on lite, and its language shows while it is on).
 */
export function AgentSettings() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const save = useSaveAgentSettings(agentId, guildId);
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
  const errors = configErrors(form, { models: models.data });
  const nameError = form.name.trim() ? agentHandleError(form.name.trim()) : handleHint;
  const invalid = Boolean(nameError) || Object.keys(errors).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    save.mutate(
      {
        name: form.name.trim(),
        config: configOf(form, models.data),
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
          <Group title="Box">
            <BoxPicker form={form} onChange={(next) => set(next)} models={models.data} error={errors.box} />
            <BoxFields form={form} onChange={(next) => set(next)} models={models.data} errors={errors} />
          </Group>
          <Group title="Agent capabilities">
            <CapabilitiesFields form={form} onChange={(next) => set(next)} />
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
