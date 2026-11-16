import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  useAgent,
  useAgentHarness,
  useHarnessCatalog,
  useOrgMachines,
  useSaveAgentSettings,
} from "../../../api/queries/agents";
import { useGuild } from "../../../api/queries/guilds";
import { useOrgModels } from "../../../api/queries/models";
import type { AgentDetail, AgentHarness, Harness, HarnessCatalog, Machine } from "../../../api/types/agents";
import { hasConnectedProvider } from "../../../api/types/models";
import { useIdentity } from "../../../app/identity";
import {
  Button,
  TextAreaField,
  TextField,
  Banner,
  SkeletonRows,
  Stepper,
  toast,
} from "@guildsrun/ui";
import { MachineGroup, ModelStep, SubscriptionStep } from "../AgentSteps";
import { CodingRepositories } from "../CodingRepositories";
import {
  harnessProblems,
  harnessProblemsSentence,
  missingRepositoryText,
  type HarnessProblem,
} from "../harness";
import { focusMax } from "../IdentityFields";
import { chosenMachine } from "../../machines/machines";
import { agentHandleError, handleHint } from "../../../app/names";
import { AvatarPicker } from "./AvatarPicker";
import { configErrors, configFormOf, configOf, missesRepository, type ConfigForm } from "./configForm";
import { Group } from "./Group";
import {
  openSection,
  sectionErrorKeys,
  sectionHasErrors,
  sectionLabel,
  settingsKindOf,
  settingsSections,
  type SettingsKind,
  type SettingsSection,
} from "./sections";

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
    ...configFormOf(agent.config, agent.model_source, agent.machine_id),
    name: agent.name,
    focus: agent.focus,
    wakeTriggers: agent.wake_triggers,
    shape: agent.avatar_shape,
    color: agent.avatar_color,
  };
}

type IdentitySectionProps = {
  form: Form;
  set: (patch: Partial<Form>) => void;
  nameError: string | undefined;
  savedName: string;
};

/** The agent's name, focus, and mascot, and what wakes it in group chat. */
function IdentitySection({ form, set, nameError, savedName }: IdentitySectionProps) {
  return (
    <>
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
          name={form.name.trim() || savedName}
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
    </>
  );
}

/** What is wrong with the name typed; an empty one reads as the rule a name follows. */
export function settingsNameError(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed ? agentHandleError(trimmed) : handleHint;
}

/** The machine saving moves the agent to; undefined while it stays where it is. */
export function machineMove(
  machine: Machine | undefined,
  placedOn: AgentDetail["machine_id"],
): string | undefined {
  return machine && machine.id !== placedOn ? machine.id : undefined;
}

/**
 * The harness CLIs the machine the agent will run on carries: the one it moves to, else the one it
 * is on as its harness check reports it, else as the machine list does.
 */
export function carriedHarnesses(
  machine: Machine | undefined,
  moveTo: string | undefined,
  status: AgentHarness | undefined,
): readonly Harness[] | null | undefined {
  if (moveTo) return machine?.harnesses;
  return status?.machine_harnesses ?? machine?.harnesses;
}

/** The hint under the machine: that saving moves the agent, or that a subscription agent needs a Code machine. */
export function machineHint(moveTo: string | undefined, kind: SettingsKind): string | undefined {
  if (moveTo)
    return "Saving moves the agent and its home there. It can't move while it is generating.";
  return kind === "subscription" ? "Subscription agents need a Code machine." : undefined;
}

/** What a saved subscription agent still lacks for its harness to run; nothing for an agent on a key. */
export function readinessProblems(
  kind: SettingsKind,
  status: AgentHarness | undefined,
): HarnessProblem[] {
  if (!status || kind === "key") return [];
  return harnessProblems(status);
}

/**
 * What the Repositories section says while the agent picks none: its turns run in its home,
 * unless its harness needs a repository.
 */
export function missingRepositoriesNote(
  form: ConfigForm,
  catalog: readonly HarnessCatalog[] | undefined,
): string {
  if (form.harness && missesRepository(form, catalog)) {
    return `No repository picked. ${missingRepositoryText([form.harness])}`;
  }
  return "No repository picked, so this agent's turns run in its home.";
}

type ReadinessBannerProps = { problems: readonly HarnessProblem[] };

/** A banner at the top of a subscription agent's Settings while its saved harness would fail at start, naming every problem. */
function ReadinessBanner({ problems }: ReadinessBannerProps) {
  if (!problems.length) return null;
  return (
    <Banner tone="warning" title="The subscription isn't ready">
      {harnessProblemsSentence(problems)}
    </Banner>
  );
}

type SettingsFooterProps = {
  dirty: boolean;
  invalid: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
};

/** Discard and Save, under every section, with a note while the form holds unsaved changes. */
function SettingsFooter({ dirty, invalid, saving, onDiscard, onSave }: SettingsFooterProps) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface px-7 py-3">
      {dirty ? <span className="mr-auto text-sm text-muted">Unsaved changes</span> : null}
      <Button variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button disabled={!dirty || invalid || saving} onClick={onSave}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

/**
 * How the agent looks and runs, in the create dialog's steps as sections opened in any order by
 * `?section=`: an agent's Identity, Model, and Machine; a subscription agent's Identity, Harness,
 * Machine, and Repositories. Identity holds the name, focus, mascot, and wake triggers. Model
 * holds the model source, the model and reasoning, the capabilities (Browser greyed out on a
 * machine below its minimum), and the run limits. Machine holds the machine (a new one moves the
 * agent there) and the disk cap against what the machine's other agents reserve. Harness holds the
 * harness with its credentials and model, the capabilities and the run limits. Repositories holds
 * the ones the agent works on, picked among those it can use, over the guild's. The sections
 * follow the form's model source, and one with an error or a readiness problem is flagged. A
 * subscription agent whose saved harness is not ready opens on a banner that lists what is
 * missing. Save sends every section at once.
 */
export function AgentSettings() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const search = useSearch({ from: "/guilds/$guildId/agents/$agentId/settings" });
  const navigate = useNavigate();
  const agent = useAgent(agentId);
  const guild = useGuild(guildId);
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const machines = useOrgMachines(org.id);
  const save = useSaveAgentSettings(agentId, guildId);
  const harness = useAgentHarness(agentId);
  const catalog = useHarnessCatalog();
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
  const setConfig = (next: ConfigForm) => setDraft({ ...form, ...next });
  const errors = configErrors(form, { models: models.data, machines: machines.data, harnesses: catalog.data });
  const machine = chosenMachine(machines.data, form.machine_id);
  const moveTo = machineMove(machine, agent.data.machine_id);
  const nameError = settingsNameError(form.name);
  const invalid = Boolean(nameError) || Object.keys(errors).length > 0;
  const noProvider = hasConnectedProvider(models.data) === false;
  const step = { form, setConfig, errors, machine };

  const kind = settingsKindOf(form);
  const savedKind = settingsKindOf(saved);
  const sections = settingsSections(kind);
  const section = openSection(search.section, kind);
  const problems = readinessProblems(savedKind, harness.data);
  const needsAttention = (key: SettingsSection) =>
    (key === "identity"
      ? Boolean(nameError)
      : sectionHasErrors(sectionErrorKeys(key, kind), errors)) ||
    (key === "harness" && problems.length > 0);
  const flagged = sections.flatMap((key, index) => (needsAttention(key) ? [index] : []));
  const open = (next: SettingsSection) =>
    void navigate({
      to: "/guilds/$guildId/agents/$agentId/settings",
      params: { guildId, agentId },
      search: { section: next },
      replace: true,
    });

  const submit = () => {
    if (!dirty || invalid || save.isPending) return;
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
  // Enter in a field saves. A submit from a dialog's own form reaches here through its portal, and
  // is left to that form.
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (event.target === event.currentTarget) submit();
  };
  const fields = (children: ReactNode) => (
    <form onSubmit={onSubmit} className="flex flex-col gap-7">
      {children}
      <button type="submit" hidden aria-hidden tabIndex={-1} />
    </form>
  );
  /** What each section shows. */
  const views: Readonly<Record<SettingsSection, ReactNode>> = {
    identity: fields(
      <IdentitySection form={form} set={set} nameError={nameError} savedName={agent.data.name} />,
    ),
    model: fields(
      <ModelStep
        {...step}
        models={models.data}
        noProvider={noProvider}
      />,
    ),
    machine: fields(
      <MachineGroup
        {...step}
        machines={machines}
        placed={{
          id: agent.data.id,
          machineId: agent.data.machine_id,
          diskMib: agent.data.config.max_workspace_mib,
        }}
        hint={machineHint(moveTo, kind)}
      />,
    ),
    harness: fields(
      <SubscriptionStep
        {...step}
        models={models.data}
        agent={{ guildId, agentId }}
        carried={carriedHarnesses(machine, moveTo, harness.data)}
      />,
    ),
    repositories: (
      <CodingRepositories
        guild={{ id: guildId, name: guild.data?.name ?? "this guild" }}
        usable={harness.data?.usable_repositories}
        picked={form.repositories}
        onPick={(repositories) => set({ repositories })}
        missingNote={missingRepositoriesNote(form, catalog.data)}
      />
    ),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex max-w-240 flex-col gap-7">
          <ReadinessBanner problems={problems} />
          <Stepper
            aria-label="Settings sections"
            steps={sections.map(sectionLabel)}
            current={sections.indexOf(section)}
            onSelect={(index) => {
              const next = sections[index];
              if (next) open(next);
            }}
            flagged={flagged}
          />
          {views[section]}
          {save.isError ? (
            <Banner tone="error" title="Couldn't save the settings">
              {save.error.message}
            </Banner>
          ) : null}
        </div>
      </div>
      <SettingsFooter
        dirty={dirty}
        invalid={invalid}
        saving={save.isPending}
        onDiscard={() => setDraft(null)}
        onSave={submit}
      />
    </div>
  );
}
