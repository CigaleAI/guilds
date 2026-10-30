import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SquareTerminal } from "lucide-react";
import { useCreateAgent, useOrgMachines } from "../../api/queries/agents";
import { useCreateSecret, useSecrets } from "../../api/queries/secrets";
import { useOrgModels } from "../../api/queries/models";
import type { Harness } from "../../api/types/agents";
import { hasConnectedProvider } from "../../api/types/models";
import { useIdentity } from "../../app/identity";
import {
  Banner,
  DialogBody,
  DialogHeader,
  Icon,
  Segmented,
  Select,
  Stepper,
  toast,
  type SegmentedOption,
} from "@guildsrun/ui";
import { SecretValueField } from "../access/SecretValueField";
import { chosenMachine } from "../machines/machines";
import { preselectedModel } from "../models/models";
import {
  harnessImageNote,
  harnessLabel,
  harnessLoginAccounts,
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
import { CodingRepositories, useGuildHasRepositories } from "./CodingRepositories";
import { MachineGroup, ModelStep, StepFooter, useSeededDisk, type StepProps } from "./AgentSteps";
import {
  configErrors,
  configFormOf,
  configOf,
  defaultAgentConfig,
  withCoding,
  type ConfigForm,
} from "./settings/configForm";
import { HarnessChoiceFields } from "./settings/HarnessFields";
import { sectionErrors, sectionHasErrors } from "./settings/sections";
import { Group } from "./settings/Group";

type CreateAgentGuild = { id: string; name: string };

const STEPS = ["Identity", "Machine", "Harness", "Lead model", "Repositories"] as const;

type TokenMode = "paste" | "secret" | "cli";

type TokenPasteFieldProps = {
  harness: Harness;
  variable: string;
  value: string;
  onChange: (value: string) => void;
};

function TokenPasteField({ harness, variable, value, onChange }: TokenPasteFieldProps) {
  return (
    <SecretValueField
      tone="surface"
      label={harness === "cursor" ? "Cursor API key" : "Subscription token"}
      placeholder={
        harness === "claude-code"
          ? "Run claude setup-token and paste the result"
          : "Paste API key (sk-...)"
      }
      hint={`Saved as a secret (${variable}) granted to this agent.`}
      value={value}
      onValueChange={onChange}
    />
  );
}

type TokenSelectFieldProps = {
  variable: string;
  value: string;
  guildId: string;
  onChange: (value: string) => void;
};

function TokenSelectField({ variable, value, guildId, onChange }: TokenSelectFieldProps) {
  const secrets = useSecrets({ scope: "guild", id: guildId });
  return (
    <Select
      tone="surface"
      label="Subscription token"
      hint={`A secret reaching this guild, read as ${variable}.`}
      value={value}
      onValueChange={onChange}
      options={tokenOptions(variable, secrets.data ?? [])}
    />
  );
}

type CliLoginCardProps = { label: string };

function CliLoginCard({ label }: CliLoginCardProps) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-well text-fg">
        <Icon icon={SquareTerminal} size={16} />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-fg">CLI Login</span>
        <p className="text-xs text-muted">
          No secret needed now. After creation, open {label}&apos;s CLI tab and authenticate.
        </p>
      </div>
    </div>
  );
}

type TokenStepProps = {
  guildId: string;
  harness: Harness;
  variable: string;
  draft: TokenDraft;
  onChange: (next: TokenDraft) => void;
};

/** The subscription token a new agent's harness runs on: pasted, a saved secret, or CLI login. */
function TokenStep({ guildId, harness, variable, draft, onChange }: TokenStepProps) {
  const [mode, setMode] = useState<TokenMode>(() => {
    if (draft.pasted.trim()) return "paste";
    if (draft.secret !== NO_TOKEN_ALIAS) return "secret";
    return "paste";
  });

  const onModeChange = (next: TokenMode) => {
    setMode(next);
    if (next === "cli") {
      onChange({ secret: NO_TOKEN_ALIAS, pasted: "" });
    } else if (next === "secret") {
      onChange({ ...draft, pasted: "" });
    } else {
      onChange({ ...draft, secret: NO_TOKEN_ALIAS });
    }
  };

  const options: SegmentedOption<TokenMode>[] = [
    { value: "paste", label: harness === "cursor" ? "Paste API key" : "Paste token" },
    { value: "secret", label: "Use saved secret" },
    ...(harness === "claude-code" ? [{ value: "cli" as const, label: "Log in via CLI" }] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label="Subscription token source"
        value={mode}
        onValueChange={onModeChange}
        options={options}
      />
      {mode === "paste" ? (
        <TokenPasteField
          harness={harness}
          variable={variable}
          value={draft.pasted}
          onChange={(pasted) => onChange({ ...draft, pasted })}
        />
      ) : null}
      {mode === "secret" ? (
        <TokenSelectField
          variable={variable}
          value={draft.secret}
          guildId={guildId}
          onChange={(secret) => onChange({ ...draft, secret })}
        />
      ) : null}
      {mode === "cli" ? <CliLoginCard label={harnessLabel(harness)} /> : null}
      <p className="text-xs text-muted">{harnessSubscriptionNote}</p>
    </div>
  );
}

type HarnessStepProps = StepProps & {
  guild: CreateAgentGuild;
  token: TokenDraft;
  onToken: (next: TokenDraft) => void;
};

/** The harness and its model, and the subscription the harness runs on. */
function HarnessStep({ guild, token, onToken, ...step }: HarnessStepProps) {
  const { form, setConfig, errors, machine } = step;
  const variable = form.harness ? harnessSecrets[form.harness] : undefined;

  const onHarnessChange = (next: ConfigForm) => {
    if (next.harness !== form.harness) {
      onToken({ secret: NO_TOKEN_ALIAS, pasted: "" });
    }
    setConfig(next);
  };

  return (
    <>
      <Group title="Harness">
        <p className="text-sm text-fg-2">
          The harness writes the code, headless in the agent&apos;s sandbox, on your own
          subscription. The agent briefs it and checks its work.
        </p>
        <HarnessChoiceFields
          form={form}
          onChange={onHarnessChange}
          errors={errors}
          carried={machine?.harnesses}
        />
        {showsHarnessImageNote(machine?.harnesses) ? (
          <p className="text-xs text-muted">{harnessImageNote}</p>
        ) : null}
      </Group>
      {variable && form.harness ? (
        <Group title="Subscription">
          <TokenStep
            guildId={guild.id}
            harness={form.harness}
            variable={variable}
            draft={token}
            onChange={onToken}
          />
        </Group>
      ) : form.harness ? (
        <Group title="Subscription">
          <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-well text-fg">
              <Icon icon={SquareTerminal} size={16} />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-fg">CLI Login Required</span>
              <p className="text-xs text-muted">
                {harnessLabel(form.harness)} runs on{" "}
                {harnessLoginAccounts[form.harness] ?? "your subscription"}. Once the agent is
                created, log in from its CLI tab.
              </p>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">{harnessSubscriptionNote}</p>
        </Group>
      ) : null}
    </>
  );
}

type CodingAgentFormProps = {
  guild: CreateAgentGuild;
  onClose: () => void;
};

/**
 * A new coding agent, step by step: its identity; the machine with its disk cap, the harness,
 * harness model, and the subscription token the harness runs on; the model that leads it, with
 * its capabilities and run limits; and the guild's repositories. Create sends the agent, then the pasted token as a
 * secret granted to it.
 */
export function CodingAgentForm({ guild, onClose }: CodingAgentFormProps) {
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
  const disk = useSeededDisk();
  const [token, setToken] = useState<TokenDraft>({ secret: NO_TOKEN_ALIAS, pasted: "" });
  const base =
    config ??
    withCoding(
      configFormOf({
        ...defaultAgentConfig,
        model: preselectedModel(models.data, { coding: true }),
      }),
      true,
      models.data,
    );
  const machine = chosenMachine(machines.data, base.machine_id);
  const form = disk.seed(base, machine);
  const errors = configErrors(form, { models: models.data, machines: machines.data });
  const noProvider = hasConnectedProvider(models.data) === false;
  const ready = [
    identityComplete(identity.draft),
    Boolean(machines.data) && !sectionHasErrors(sectionErrors.machine, errors),
    Boolean(form.harness) && !sectionHasErrors(sectionErrors.harness, errors),
    !noProvider && !sectionHasErrors(sectionErrors.model, errors),
    true,
  ][step];
  const busy = create.isPending || createSecret.isPending;
  const stepProps = { form, setConfig, errors, machine };

  const submit = async () => {
    const plan = tokenPlan(
      form.harness ? harnessSecrets[form.harness] : undefined,
      token,
      identity.draft.name.trim(),
      guildSecrets.data ?? [],
    );
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
          <MachineGroup
            {...stepProps}
            machines={machines}
            coding
            onDiskTyped={disk.onTyped}
            hint="Coding agents need a Code machine."
          />
        ) : null}
        {step === 2 ? (
          <HarnessStep {...stepProps} guild={guild} token={token} onToken={setToken} />
        ) : null}
        {step === 3 ? (
          <ModelStep {...stepProps} lead models={models.data} noProvider={noProvider} />
        ) : null}
        {step === 4 ? (
          <CodingRepositories
            guild={guild}
            missingNote="No repository yet. You can create the agent and add one later in the guild's Settings."
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
        busy={busy}
        createLabel={hasRepositories === false ? "Create without a repository" : "Create agent"}
        onStep={setStep}
        onCreate={() => void submit()}
      />
    </div>
  );
}
