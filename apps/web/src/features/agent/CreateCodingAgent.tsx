import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  useAccess,
  useCreateAgent,
  useCreateSecret,
  useGuildRepositories,
  useOrgMachines,
  useOrgModels,
  useSecrets,
} from "../../api/queries";
import {
  hasConnectedProvider,
  type GithubSelectedRepository,
  type Machine,
  type OrgModels,
} from "../../api/types";
import { useIdentity } from "../../app/identity";
import {
  Button,
  Banner,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  Select,
  Stepper,
  TextField,
  toast,
} from "@guildsrun/ui";
import { GithubSettings } from "../access/GithubRepositories";
import { useServerConnect } from "../access/ConnectDialogs";
import { GuildRepositories } from "../guild/pages/GuildRepositories";
import { MachinePicker } from "../machines/MachinePicker";
import { chosenMachine } from "../machines/machines";
import { ConnectProviderGuide } from "../models/ConnectProviderGuide";
import { preselectedModel } from "../models/models";
import {
  harnessImageNote,
  harnessLabel,
  harnessSecrets,
  harnessSubscriptionNote,
  harnessTokenDescription,
  NO_TOKEN_ALIAS,
  showsHarnessImageNote,
  tokenOptions,
  tokenPlan,
  type TokenDraft,
} from "./harness";
import { identityComplete, IdentityFields, useIdentityDraft } from "./IdentityFields";
import {
  CapabilitiesFields,
  configErrors,
  configFormOf,
  configOf,
  defaultAgentConfig,
  DiskFields,
  HarnessChoiceFields,
  LimitFields,
  ModelFields,
  withCoding,
  type ConfigErrors,
  type ConfigForm,
} from "./settings/configForm";
import { Group } from "./settings/AgentSettings";

type CreateAgentGuild = { id: string; name: string };

const STEPS = ["Identity", "Harness", "Lead model", "Repositories"] as const;

/** The errors each step owns; a step is ready when none of its keys is set. */
const STEP_ERRORS: ReadonlyArray<ReadonlyArray<keyof ConfigErrors>> = [
  [],
  ["machine", "harness", "harness_model"],
  [
    "model",
    "temperature",
    "max_tokens",
    "max_steps",
    "max_tool_calls",
    "max_input_tokens",
    "keep_tool_result_generations",
    "max_scripts",
    "max_workspace_mib",
  ],
  [],
];

function stepHasErrors(step: number, errors: ConfigErrors): boolean {
  return (STEP_ERRORS[step] ?? []).some((key) => errors[key] !== undefined);
}

/** The subscription token a new agent's harness runs on: one of the guild's secrets, or a token pasted now. */
function TokenStep({
  guildId,
  variable,
  draft,
  onChange,
}: {
  guildId: string;
  variable: string;
  draft: TokenDraft;
  onChange: (next: TokenDraft) => void;
}) {
  const secrets = useSecrets({ scope: "guild", id: guildId });
  const pasted = Boolean(draft.pasted.trim());
  return (
    <div className="flex flex-col gap-3">
      <Select
        tone="surface"
        label="Subscription token"
        hint={`A secret reaching this guild, read as ${variable}. Your own token keeps the work on your subscription.`}
        value={pasted ? NO_TOKEN_ALIAS : draft.secret}
        disabled={pasted}
        onValueChange={(secret) => onChange({ ...draft, secret })}
        options={tokenOptions(variable, secrets.data ?? [])}
      />
      <TextField
        tone="surface"
        label="Or paste a token"
        type="password"
        autoComplete="off"
        hint="Saved as a secret for this agent alone once it exists, and picked above."
        value={draft.pasted}
        onChange={(event) => onChange({ ...draft, pasted: event.currentTarget.value })}
      />
    </div>
  );
}

/** The GitHub login the guild's repositories come from: connect one, or pick repositories on it. */
function GithubBlock({ guildId }: { guildId: string }) {
  const owner = { scope: "guild", id: guildId } as const;
  const access = useAccess(owner);
  const connect = useServerConnect(owner);
  const github = access.data?.mcp.find((server) => server.slug === "github");
  if (!github) return null;
  if (github.oauth_setup_state === "unsupported") {
    return (
      <p className="text-sm text-fg-2">
        The GitHub App is not set up on this box. A platform admin registers it under{" "}
        <Link to="/admin" className="underline">
          Admin
        </Link>
        , Platform keys; until then, repositories are added by URL below.
      </p>
    );
  }
  const connected = github.connection_id !== null && github.status === "connected";
  const owned = github.connection_owner_scope === "guild" ? github.connection_id : null;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-60 flex-1 text-sm text-fg-2">
          {connected
            ? `GitHub · ${github.account_hint}${owned ? "" : " (the organisation's login; connect here to pick for this guild alone)"}`
            : "Install the GitHub App on your account and pick the repositories it may reach; private ones need it."}
        </p>
        {!connected || !owned ? (
          <Button
            size="sm"
            variant="outline"
            disabled={connect.busy}
            onClick={() => connect.start(github)}
          >
            {connect.busy ? "Connecting…" : "Connect GitHub"}
          </Button>
        ) : null}
      </div>
      {connected ? <GithubSettings server={github} owned={owned} /> : null}
      {connect.dialogs}
    </div>
  );
}

/** Whether the guild has a repository for code tasks: one picked on its GitHub login, or one added by URL. */
function useGuildHasRepositories(guildId: string): boolean | null {
  const listed = useGuildRepositories(guildId);
  const access = useAccess({ scope: "guild", id: guildId });
  if (!listed.data || !access.data) return null;
  const github = access.data.mcp.find((server) => server.slug === "github");
  const picked = (github?.settings.repositories as GithubSelectedRepository[] | undefined) ?? [];
  return listed.data.repositories.length > 0 || picked.length > 0;
}

function RepositoriesStep({
  guild,
  hasRepositories,
}: {
  guild: CreateAgentGuild;
  hasRepositories: boolean | null;
}) {
  return (
    <>
      <p className="text-sm text-fg-2">
        Code tasks run in the guild&apos;s repositories, cloned into the agent&apos;s sandbox. Every
        coding agent of {guild.name} shares them. Without one, this agent&apos;s runs fail at start.
      </p>
      <GithubBlock guildId={guild.id} />
      <GuildRepositories guild={guild} />
      {hasRepositories === false ? (
        <p className="text-sm text-t-ochre-fg">
          No repository yet. You can create the agent and add one later in the guild&apos;s
          Settings.
        </p>
      ) : null}
    </>
  );
}

/** What every step edits: the config form, its errors, and the machine it names. */
type StepProps = {
  form: ConfigForm;
  setConfig: (next: ConfigForm) => void;
  errors: ConfigErrors;
  machine: Machine | undefined;
};

/** The machine, the harness and its model, and the subscription the harness runs on. */
function HarnessStep({
  guild,
  machines,
  token,
  onToken,
  ...step
}: StepProps & {
  guild: CreateAgentGuild;
  machines: ReturnType<typeof useOrgMachines>;
  token: TokenDraft;
  onToken: (next: TokenDraft) => void;
}) {
  const { form, setConfig, errors, machine } = step;
  const variable = form.harness ? harnessSecrets[form.harness] : undefined;
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
            agent={{ browser: form.browser, coding: true }}
            error={errors.machine}
            hint="Coding agents need a Code machine."
          />
        ) : null}
      </Group>
      <Group title="Harness">
        <p className="text-sm text-fg-2">
          The harness writes the code, headless in the agent&apos;s sandbox, on your own
          subscription. The agent briefs it and checks its work.
        </p>
        <HarnessChoiceFields
          form={form}
          onChange={setConfig}
          errors={errors}
          carried={machine?.harnesses}
        />
        {showsHarnessImageNote(machine?.harnesses) ? (
          <p className="text-sm text-muted">{harnessImageNote}</p>
        ) : null}
        <p className="text-sm text-muted">{harnessSubscriptionNote}</p>
      </Group>
      {variable ? (
        <Group title="Subscription">
          <TokenStep guildId={guild.id} variable={variable} draft={token} onChange={onToken} />
        </Group>
      ) : form.harness ? (
        <Group title="Subscription">
          <p className="text-sm text-fg-2">
            {harnessLabel(form.harness)} runs on a login: once the agent exists, log in from its CLI
            tab.
          </p>
        </Group>
      ) : null}
    </>
  );
}

/** The model that leads the agent, its capabilities, and its limits behind a disclosure. */
function LeadModelStep({
  models,
  noProvider,
  ...step
}: StepProps & { models: OrgModels | undefined; noProvider: boolean }) {
  const { form, setConfig, errors, machine } = step;
  const patch = (next: Partial<ConfigForm>) => setConfig({ ...form, ...next });
  return (
    <>
      <Group title="Lead model">
        <p className="text-sm text-fg-2">
          Two models work here. The lead model plans, talks to you, and reviews the work, on the
          organisation&apos;s key. The harness writes the code on your subscription.
        </p>
        {noProvider ? (
          <ConnectProviderGuide what="a coding agent" />
        ) : (
          <ModelFields form={form} onChange={patch} errors={errors} />
        )}
      </Group>
      <Group title="Agent capabilities">
        <CapabilitiesFields
          form={form}
          onChange={setConfig}
          errors={errors}
          models={models}
          machine={machine}
          codingToggle={false}
        />
      </Group>
      <details className="flex flex-col gap-4">
        <summary className="cursor-pointer text-sm font-semibold text-fg-2">
          Run limits and disk
        </summary>
        <div className="mt-4 flex flex-col gap-4">
          <LimitFields form={form} onChange={patch} errors={errors} />
          <DiskFields form={form} onChange={patch} errors={errors} />
        </div>
      </details>
    </>
  );
}

/** The dialog's Back, Next, and Create buttons for the step in progress. */
function StepFooter({
  step,
  ready,
  busy,
  createLabel,
  onStep,
  onCreate,
}: {
  step: number;
  ready: boolean;
  busy: boolean;
  createLabel: string;
  onStep: (step: number) => void;
  onCreate: () => void;
}) {
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
      {step < STEPS.length - 1 ? (
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

/**
 * A new coding agent, step by step: its identity; the machine, harness, harness model, and the
 * subscription token the harness runs on; the model that leads it, with its capabilities and
 * limits; and the guild's repositories. Create sends the agent, then the pasted token as a
 * secret granted to it.
 */
export function CodingAgentForm({
  guild,
  onClose,
}: {
  guild: CreateAgentGuild;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const machines = useOrgMachines(org.id);
  const guildSecrets = useSecrets({ scope: "guild", id: guild.id });
  const hasRepositories = useGuildHasRepositories(guild.id);
  const create = useCreateAgent(guild.id);
  const createSecret = useCreateSecret();
  const identity = useIdentityDraft();
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const [token, setToken] = useState<TokenDraft>({ secret: NO_TOKEN_ALIAS, pasted: "" });
  const form =
    config ??
    withCoding(
      configFormOf({
        ...defaultAgentConfig,
        model: preselectedModel(models.data, { coding: true }),
      }),
      true,
      models.data,
    );
  const errors = configErrors(form, { models: models.data, machines: machines.data });
  const machine = chosenMachine(machines.data, form.machine_id);
  const noProvider = hasConnectedProvider(models.data) === false;
  const ready = [
    identityComplete(identity.draft),
    Boolean(machines.data) && Boolean(form.harness) && !stepHasErrors(1, errors),
    !noProvider && !stepHasErrors(2, errors),
    true,
  ][step];
  const busy = create.isPending || createSecret.isPending;
  const stepProps = { form, setConfig, errors, machine };

  const submit = async () => {
    const plan = tokenPlan({
      variable: form.harness ? harnessSecrets[form.harness] : undefined,
      draft: token,
      agentName: identity.draft.name.trim(),
      guildSecrets: guildSecrets.data ?? [],
    });
    const agent = await create.mutateAsync({
      name: identity.draft.name.trim(),
      focus: identity.draft.focus.trim(),
      avatar_shape: identity.draft.look.shape,
      avatar_color: identity.draft.look.color,
      config: configOf({ ...form, secret_aliases: plan.aliases }, models.data),
      ...(machine ? { machine_id: machine.id } : {}),
    });
    if (plan.add && form.harness) {
      await createSecret
        .mutateAsync({
          name: plan.add,
          value: token.pasted.trim(),
          description: harnessTokenDescription[form.harness] ?? "",
          org_wide: false,
          guild_ids: [],
          agent_ids: [agent.id],
        })
        .catch((error: Error) =>
          toast({
            kind: "error",
            title: `${agent.name} was created, but its token was not saved`,
            description: `${error.message} Add it under Settings.`,
          }),
        );
    }
    onClose();
    void navigate({
      to: "/guilds/$guildId/agents/$agentId/prompt",
      params: { guildId: guild.id, agentId: agent.id },
    });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <DialogHeader
        title="Create a coding agent"
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
          <HarnessStep
            {...stepProps}
            guild={guild}
            machines={machines}
            token={token}
            onToken={setToken}
          />
        ) : null}
        {step === 2 ? (
          <LeadModelStep {...stepProps} models={models.data} noProvider={noProvider} />
        ) : null}
        {step === 3 ? <RepositoriesStep guild={guild} hasRepositories={hasRepositories} /> : null}
        {create.isError ? (
          <Banner tone="error" title="Couldn't create the agent">
            {create.error.message}
          </Banner>
        ) : null}
      </DialogBody>
      <StepFooter
        step={step}
        ready={ready ?? false}
        busy={busy}
        createLabel={hasRepositories === false ? "Create without a repository" : "Create agent"}
        onStep={setStep}
        onCreate={() => void submit()}
      />
    </div>
  );
}
