import { Bookmark, Check, Code2, FileCode, Globe, Info, type LucideIcon } from "lucide-react";
import { useHarnessCatalog } from "../../../api/queries/agents";
import { useOrgModels } from "../../../api/queries/models";
import type {
  AgentConfig,
  Harness,
  HarnessCatalog,
  HarnessEffort,
  Machine,
  OrgModels,
  ThinkingLevel,
} from "../../../api/types";
import { isCodingOnlyModel } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { useState } from "react";
import { cn, Icon, Select, Slider, TextField } from "@guildsrun/ui";
import { agentMinimum, chosenMachine, sizeMeets } from "../../machines/machines";
import { TooSmallNote } from "../../machines/MachineNotes";
import {
  modelLimits,
  modelOptions,
  modelProviderConnected,
  providerLabel,
} from "../../models/models";
import { ModelKeysLink } from "../../settings/ModelKeysLink";
import {
  catalogFor,
  defaultEffortLabel,
  effortLabels,
  harnessCarried,
  harnessEffortsFor,
  harnessImageNote,
  harnessLabel,
  harnessOffered,
  harnessSubscriptionNote,
  listedHarnessModel,
  isHarness,
  showsHarnessImageNote,
} from "../harness";
import { HarnessReadiness } from "./HarnessReadiness";
import { HarnessLogo } from "../HarnessLogo";
import { BrowserFields, withBrowser } from "./BrowserFields";
/** A new agent's settings, as the server defaults them; the model is the organisation's default, or the operator's choice. */
export const defaultAgentConfig: AgentConfig = {
  model: "",
  temperature: 1,
  max_tokens: 8192,
  max_steps: 30,
  max_tool_calls: 50,
  max_input_tokens: 100000,
  keep_tool_result_generations: 1,
  max_scripts: 10,
  max_workspace_mib: 10240,
  browser: false,
  browser_language: "en-US",
  browser_optimized: false,
  browser_model: null,
  coding: false,
  harness: null,
  harness_model: null,
  harness_effort: null,
  secret_aliases: {},
  scripting: true,
  memory: true,
  thinking_level: "none",
};

/** The step and tool-call budgets a new coding agent starts with, as the server defaults them. */
export const codingLimits = { max_steps: 200, max_tool_calls: 200 } as const;

export const limitFields = [
  { key: "max_tokens", label: "Max output tokens", hint: "Per model reply." },
  { key: "max_steps", label: "Max steps", hint: "Model turns in one generation." },
  {
    key: "max_tool_calls",
    label: "Max tool calls",
    hint: "The run ends when this many tools have been called.",
  },
  {
    key: "max_input_tokens",
    label: "Max input tokens",
    hint: "When the conversation grows past this, the run stops; start a new session.",
  },
  {
    key: "keep_tool_result_generations",
    label: "Keep tool results",
    hint: "How many user turns, including the current one, keep full tool output in the model prompt. Older large results are stubbed; the stored transcript is unchanged.",
  },
] as const;

type LimitKey = (typeof limitFields)[number]["key"];

/** A model config and the agent's machine as a form edits them: numbers stay text while typed. */
export type ConfigForm = {
  model: string;
  thinking: ThinkingLevel;
  temperature: string;
  /** The machine the agent goes on; empty until one is picked among several. */
  machine_id: string;
  browser: boolean;
  browser_language: string;
  /** Whether the browser runs as the agent-optimized browser. */
  browser_optimized: boolean;
  /** The model the agent-optimized browser plans and reads with; empty until one is picked. */
  browser_model: string;
  coding: boolean;
  /** The coding agent's harness; empty until one is picked. */
  harness: Harness | "";
  /** The model the harness runs; empty for its subscription's default. */
  harness_model: string;
  /** The effort the harness runs its model at; empty for the harness's default. */
  harness_effort: HarnessEffort | "";
  /** Variable names the agent's commands see, each holding the value of the secret it names. */
  secret_aliases: Record<string, string>;
  scripting: boolean;
  memory: boolean;
  max_scripts: string;
  max_workspace_mib: string;
} & Record<LimitKey, string>;

export type ConfigErrors = Partial<
  Record<
    | LimitKey
    | "temperature"
    | "max_scripts"
    | "max_workspace_mib"
    | "model"
    | "machine"
    | "harness"
    | "harness_model"
    | "browser_model",
    string
  >
>;

export type ConfigErrorContext = {
  models?: OrgModels | undefined;
  /** The organisation's machines; machine checks wait until they load. */
  machines?: Machine[] | undefined;
};

/** A stored config in the form, on the machine named; empty leaves the machine to pick. */
export function configFormOf(config: AgentConfig, machineId = ""): ConfigForm {
  return {
    model: config.model,
    thinking: config.thinking_level,
    temperature: String(config.temperature),
    machine_id: machineId,
    browser: config.browser,
    browser_language: config.browser_language ?? "en-US",
    browser_optimized: config.browser_optimized === true,
    browser_model: config.browser_model ?? "",
    coding: config.coding,
    harness: isHarness(config.harness) ? config.harness : "",
    harness_model: config.harness_model ?? "",
    harness_effort: config.harness_effort ?? "",
    secret_aliases: { ...config.secret_aliases },
    scripting: config.scripting !== false,
    memory: config.memory !== false,
    max_tokens: String(config.max_tokens),
    max_steps: String(config.max_steps),
    max_tool_calls: String(config.max_tool_calls),
    max_input_tokens: String(config.max_input_tokens),
    keep_tool_result_generations: String(config.keep_tool_result_generations ?? 1),
    max_scripts: String(config.max_scripts ?? 10),
    max_workspace_mib: String(config.max_workspace_mib ?? 10240),
  };
}

function positiveInteger(text: string): boolean {
  return /^\d+$/.test(text.trim()) && Number(text) >= 1;
}

/** The server's rule for a harness model: empty for the default, else an alias or a full model name. */
const harnessModelPattern = /^(?:[A-Za-z0-9][A-Za-z0-9._:/=,[\]-]{0,119})?$/;

export function configErrors(form: ConfigForm, context: ConfigErrorContext = {}): ConfigErrors {
  const errors: ConfigErrors = {};
  for (const field of limitFields) {
    if (!positiveInteger(form[field.key])) errors[field.key] = "A whole number, 1 or more.";
  }
  if (!positiveInteger(form.max_scripts)) errors.max_scripts = "A whole number, 1 or more.";
  if (!positiveInteger(form.max_workspace_mib))
    errors.max_workspace_mib = "A whole number, 1 or more.";
  if (!form.temperature.trim() || !Number.isFinite(Number(form.temperature)))
    errors.temperature = "A number.";
  if (form.coding && !form.harness) errors.harness = "Pick a harness.";
  if (form.coding && !harnessModelPattern.test(form.harness_model.trim()))
    errors.harness_model =
      "Up to 120 letters, digits, and . _ : / = , [ ] -, starting with a letter or digit.";
  if (context.machines) {
    const machine = chosenMachine(context.machines, form.machine_id);
    if (!machine) errors.machine = "Choose a machine.";
  }
  if (!form.model) {
    errors.model = "Choose a model.";
  } else if (isCodingOnlyModel(form.model, context.models) && !form.coding) {
    errors.model = "Turn Coding on to use this model.";
  } else if (modelProviderConnected(context.models, form.model) === false) {
    errors.model = `Connect a ${providerLabel(context.models, form.model)} key on Model keys first.`;
  }
  const browserModel = browserModelError(form, context.models);
  if (browserModel) errors.browser_model = browserModel;
  return errors;
}

/** What is wrong with the agent-optimized browser's model, when the form sends one. */
function browserModelError(form: ConfigForm, models: OrgModels | undefined): string | undefined {
  if (!browserOptimizedOf(form)) return undefined;
  const model = form.browser_model.trim();
  if (!model) return "Choose a browser model.";
  if (isCodingOnlyModel(model, models)) return "A coding plan's model can't browse. Pick another.";
  if (modelProviderConnected(models, model) === false) {
    return `Connect a ${providerLabel(models, model)} key on Model keys first.`;
  }
  return undefined;
}

/** Whether the form sends the agent-optimized browser: only with the browser on. */
function browserOptimizedOf(form: ConfigForm): boolean {
  return form.browser && form.browser_optimized;
}

/** The browser model to send: only with the agent-optimized browser, else null. */
function browserModelOf(form: ConfigForm): string | null {
  return browserOptimizedOf(form) ? form.browser_model.trim() || null : null;
}

/** The harness model to send: only with a harness, and null for its subscription's default. */
function harnessModelOf(form: ConfigForm): string | null {
  return form.coding && form.harness ? form.harness_model.trim() || null : null;
}

/** The harness effort to send: only with a harness, and null for the harness's default. */
function harnessEffortOf(form: ConfigForm): HarnessEffort | null {
  return form.coding && form.harness ? form.harness_effort || null : null;
}

/**
 * The form with another harness model: an effort the new model does not run at goes back to the
 * default. Without the catalogue the effort stays, for the server to check.
 */
export function withHarnessModel(
  form: ConfigForm,
  model: string,
  catalog: readonly HarnessCatalog[] | undefined,
): ConfigForm {
  const entry = form.harness ? catalogFor(catalog, form.harness) : undefined;
  const kept =
    !entry ||
    !form.harness_effort ||
    harnessEffortsFor(entry, model.trim()).includes(form.harness_effort);
  return { ...form, harness_model: model, harness_effort: kept ? form.harness_effort : "" };
}

/**
 * The config to send, without the machine; a model that does not reason gets thinking off, only
 * a coding agent carries a harness and its model, and only an agent with the browser carries the
 * agent-optimized browser and its model.
 */
export function configOf(form: ConfigForm, models: OrgModels | undefined): AgentConfig {
  return {
    model: form.model,
    temperature: Number(form.temperature),
    thinking_level: modelLimits(models, form.model).thinkingOff ? "none" : form.thinking,
    browser: form.browser,
    browser_language: form.browser_language,
    browser_optimized: browserOptimizedOf(form),
    browser_model: browserModelOf(form),
    coding: form.coding,
    harness: form.coding && form.harness ? form.harness : null,
    harness_model: harnessModelOf(form),
    harness_effort: harnessEffortOf(form),
    secret_aliases: form.secret_aliases,
    scripting: form.scripting,
    memory: form.memory,
    max_tokens: Number(form.max_tokens),
    max_steps: Number(form.max_steps),
    max_tool_calls: Number(form.max_tool_calls),
    max_input_tokens: Number(form.max_input_tokens),
    keep_tool_result_generations: Number(form.keep_tool_result_generations),
    max_scripts: Number(form.max_scripts),
    max_workspace_mib: Number(form.max_workspace_mib),
  };
}

type FieldsProps = {
  form: ConfigForm;
  onChange: (patch: Partial<ConfigForm>) => void;
  errors: ConfigErrors;
};

function modelFieldMessage(message: string) {
  const match = /^Connect a (.+) key on Model keys first\.$/.exec(message);
  if (match) {
    return (
      <>
        Connect a {match[1]} key on <ModelKeysLink /> first.
      </>
    );
  }
  return message;
}

/** Model, thinking and temperature; what the chosen model does not take is switched off. */
export function ModelFields({ form, onChange, errors }: FieldsProps) {
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const { thinkingOff, temperatureOff } = modelLimits(models.data, form.model);
  const codingConnected = models.data?.providers.some(
    (item) => item.kind === "coding" && item.connected,
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Select
        tone="surface"
        label="Model"
        placeholder="Choose a model"
        value={form.model}
        onValueChange={(value) => onChange({ model: value })}
        options={modelOptions(models.data, { current: form.model, coding: form.coding })}
        hint={
          form.coding && !codingConnected ? (
            <>
              Coding APIs appear here once a key is connected on <ModelKeysLink />.
            </>
          ) : undefined
        }
        {...(errors.model
          ? { error: modelFieldMessage(errors.model) }
          : models.isError
            ? { error: `Couldn't load the models: ${models.error.message}` }
            : {})}
      />
      <Select
        tone="surface"
        label="Thinking"
        hint={
          thinkingOff
            ? "This model does not reason before replying."
            : "Reasoning effort, for models that support it."
        }
        value={thinkingOff ? "none" : form.thinking}
        disabled={thinkingOff}
        onValueChange={(value) => onChange({ thinking: value as ThinkingLevel })}
        options={[
          { value: "none", label: "Off" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ]}
      />
      <Slider
        label="Temperature"
        min={0}
        max={2}
        step={0.1}
        disabled={temperatureOff}
        hint={temperatureOff ? "This model sets its own temperature." : undefined}
        value={Number.isFinite(Number(form.temperature)) ? Number(form.temperature) : 1}
        onValueChange={(value) => onChange({ temperature: String(value) })}
        {...(errors.temperature ? { error: errors.temperature } : {})}
      />
    </div>
  );
}

export function LimitFields({ form, onChange, errors }: FieldsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {limitFields.map((field) => (
        <TextField
          key={field.key}
          tone="surface"
          label={field.label}
          type="number"
          min={1}
          step={1}
          hint={field.hint}
          value={form[field.key]}
          onChange={(event) => onChange({ [field.key]: event.currentTarget.value })}
          {...(errors[field.key] ? { error: errors[field.key] } : {})}
        />
      ))}
    </div>
  );
}

/** The agent home's disk cap, in MiB. */
export function MaxDiskField({ form, onChange, errors }: FieldsProps) {
  return (
    <TextField
      tone="surface"
      label="Max disk"
      type="number"
      min={1}
      step={1}
      hint="MiB the agent's home may hold. A generation will not start while the home is over this, or while its machine is over the machine's cap. 10240 is 10 GiB."
      value={form.max_workspace_mib}
      onChange={(event) => onChange({ max_workspace_mib: event.currentTarget.value })}
      {...(errors.max_workspace_mib ? { error: errors.max_workspace_mib } : {})}
    />
  );
}

/** How many scripts the agent may keep. */
export function MaxScriptsField({ form, onChange, errors }: FieldsProps) {
  return (
    <TextField
      tone="surface"
      label="Max scripts"
      type="number"
      min={1}
      step={1}
      hint="Reusable Python files this agent may keep. Creating another is refused past this number."
      value={form.max_scripts}
      onChange={(event) => onChange({ max_scripts: event.currentTarget.value })}
      {...(errors.max_scripts ? { error: errors.max_scripts } : {})}
    />
  );
}

/** The agent home's disk cap, in MiB, beside how many scripts the agent may keep. */
export function DiskFields(props: FieldsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <MaxDiskField {...props} />
      <MaxScriptsField {...props} />
    </div>
  );
}

/** Whether a capability is on. Missing `scripting` and `memory` mean on. */
export function capabilityOn(
  config: Partial<Pick<AgentConfig, "browser" | "coding" | "scripting" | "memory">> | undefined,
  key: "browser" | "coding" | "scripting" | "memory",
): boolean {
  if (key === "scripting" || key === "memory") return config?.[key] !== false;
  return Boolean(config?.[key]);
}

/** An on/off capability as a pressed button. */
function CapabilityField({
  label,
  hint,
  checked,
  onChange,
  disabled,
  icon,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-full min-w-0 cursor-pointer flex-col items-start gap-1 rounded-xl bg-surface px-3.5 py-3 text-left transition-colors",
        "hover:bg-paper-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        "selected:bg-ink-fill selected:text-on-ink selected:hover:bg-ink-fill",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        {icon ? <Icon icon={icon} size={16} /> : null}
        {label}
      </span>
      <span className={cn("text-xs text-pretty", checked ? "opacity-80" : "text-muted")}>
        {hint}
      </span>
    </button>
  );
}

/**
 * A new agent's form with coding switched: limits still at the defaults move to the coding
 * budgets, and back when coding is switched off again. Turning coding on also turns on
 * scripting; turning it off clears the harness, its model, and its effort.
 */
export function withCoding(
  form: ConfigForm,
  coding: boolean,
  models?: OrgModels | undefined,
): ConfigForm {
  const from = coding ? defaultAgentConfig : codingLimits;
  const to = coding ? codingLimits : defaultAgentConfig;
  return {
    ...form,
    coding,
    ...(coding
      ? { scripting: true }
      : { harness: "" as const, harness_model: "", harness_effort: "" as const }),
    ...(!coding && isCodingOnlyModel(form.model, models)
      ? { model: models?.default ?? "", thinking: "none" as ThinkingLevel }
      : {}),
    max_steps: form.max_steps === String(from.max_steps) ? String(to.max_steps) : form.max_steps,
    max_tool_calls:
      form.max_tool_calls === String(from.max_tool_calls)
        ? String(to.max_tool_calls)
        : form.max_tool_calls,
  };
}

/** The agent an existing agent's settings edit, for the links and credentials they show. */
export type SettingsAgent = { guildId: string; agentId: string };

/** The model select's values for the subscription's default and for a name typed in. */
const DEFAULT_MODEL = "default";
const CUSTOM_MODEL = "custom";

/**
 * The model the picked harness runs, from its listed models, the subscription's default, or a
 * custom name typed in; then the effort it runs at, among the ones that model takes.
 */
function HarnessModelFields({
  form,
  harness,
  onChange,
  error,
}: {
  form: ConfigForm;
  harness: Harness;
  onChange: (next: ConfigForm) => void;
  error?: string | undefined;
}) {
  const catalog = useHarnessCatalog();
  const entry = catalogFor(catalog.data, harness);
  const model = form.harness_model.trim();
  const listed = listedHarnessModel(entry, model);
  const [customPicked, setCustomPicked] = useState(false);
  const custom = customPicked || (model !== "" && !listed);
  const listedChoice = listed === undefined ? DEFAULT_MODEL : model;
  const pick = (value: string) => {
    setCustomPicked(value === CUSTOM_MODEL);
    if (value === CUSTOM_MODEL) return;
    onChange(withHarnessModel(form, value === DEFAULT_MODEL ? "" : value, catalog.data));
  };
  return (
    <>
      <Select
        tone="surface"
        label="Harness model"
        hint="Custom takes any model name the subscription offers."
        value={custom ? CUSTOM_MODEL : listedChoice}
        onValueChange={pick}
        options={[
          { value: DEFAULT_MODEL, label: "Subscription default" },
          ...(entry?.models ?? []).map((item) => ({
            value: item.id,
            label: item.label,
            description: item.id,
          })),
          { value: CUSTOM_MODEL, label: "Custom…" },
        ]}
      />
      {custom ? (
        <TextField
          tone="surface"
          label="Model name"
          placeholder="Subscription default"
          autoComplete="off"
          value={form.harness_model}
          onChange={(event) => {
            setCustomPicked(true);
            onChange(withHarnessModel(form, event.currentTarget.value, catalog.data));
          }}
          {...(error ? { error } : {})}
        />
      ) : null}
      <HarnessEffortField form={form} entry={entry} onChange={onChange} />
    </>
  );
}

/** The effort select's value for leaving the effort to the model's default. */
const DEFAULT_EFFORT = "default";

/**
 * The effort the harness runs its model at, among the ones the model takes; none is shown for a
 * model that takes none, such as a Cursor model whose name carries it.
 */
function HarnessEffortField({
  form,
  entry,
  onChange,
}: {
  form: ConfigForm;
  entry: HarnessCatalog | undefined;
  onChange: (next: ConfigForm) => void;
}) {
  const model = form.harness_model.trim();
  const efforts = harnessEffortsFor(entry, model);
  if (efforts.length === 0) return null;
  const offered = !form.harness_effort || efforts.includes(form.harness_effort);
  return (
    <Select
      tone="surface"
      label="Effort"
      hint="How hard the model reasons before it answers."
      value={form.harness_effort || DEFAULT_EFFORT}
      onValueChange={(value) =>
        onChange({
          ...form,
          harness_effort: value === DEFAULT_EFFORT ? "" : (value as HarnessEffort),
        })
      }
      options={[
        { value: DEFAULT_EFFORT, label: defaultEffortLabel(listedHarnessModel(entry, model)) },
        ...efforts.map((effort) => ({ value: effort, label: effortLabels[effort] })),
      ]}
      {...(offered ? {} : { error: "This model doesn't run at that effort. Pick another." })}
    />
  );
}

const HARNESS_ITEMS = [
  { value: "claude-code" as const, label: "Claude Code", subtitle: "Anthropic" },
  { value: "codex" as const, label: "Codex", subtitle: "OpenAI" },
  { value: "cursor" as const, label: "Cursor", subtitle: "Cursor" },
  { value: "antigravity" as const, label: "Antigravity", subtitle: "Google" },
] as const;

function HarnessCard({
  harness,
  label,
  subtitle,
  selected,
  available,
  off,
  onPick,
}: {
  harness: Harness;
  label: string;
  subtitle: string;
  selected: boolean;
  available: boolean;
  /** The box turns it off; shown only while the agent is on it. */
  off: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!available}
      onClick={onPick}
      className={cn(
        "group relative flex flex-col items-start gap-2 rounded-xl border p-2.5 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        selected
          ? "border-focus/60 bg-paper-hi shadow-sm ring-2 ring-focus/80"
          : "border-line bg-surface hover:border-rule hover:bg-paper",
        !available && "cursor-not-allowed opacity-45 hover:border-line hover:bg-surface",
      )}
    >
      <div className="flex w-full items-center justify-between">
        <HarnessLogo harness={harness} size={28} />
        {selected ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-focus text-on-focus">
            <Icon icon={Check} size={14} />
          </span>
        ) : null}
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-fg">{label}</span>
        <span className="text-xs text-muted">{subtitle}</span>
      </div>
      {!available || off ? (
        <span className="rounded bg-well px-1.5 py-0.5 text-2xs font-medium text-muted">
          {off ? "Turned off" : "Not on machine"}
        </span>
      ) : null}
    </button>
  );
}

/**
 * A button with its logo for each harness the box offers and, once one is picked, its model and
 * effort. A harness the machine's image lacks is disabled with a note; one the box turns off shows
 * only while the agent is on it. Picking another harness clears the model and effort.
 */
export function HarnessChoiceFields({
  form,
  onChange,
  errors,
  carried,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  errors: ConfigErrors;
  carried?: readonly Harness[] | null | undefined;
}) {
  const pick = (value: Harness) =>
    onChange({
      ...form,
      harness: value,
      harness_model: value === form.harness ? form.harness_model : "",
      harness_effort: value === form.harness ? form.harness_effort : "",
    });
  const catalog = useHarnessCatalog();
  const items = HARNESS_ITEMS.filter((item) =>
    harnessOffered(catalog.data, item.value, form.harness),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-semibold text-fg">Harness</label>
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="radiogroup"
          aria-label="Coding harness"
        >
          {items.map((item) => (
            <HarnessCard
              key={item.value}
              harness={item.value}
              label={item.label}
              subtitle={item.subtitle}
              selected={form.harness === item.value}
              available={harnessCarried(carried, item.value) !== false}
              off={catalogFor(catalog.data, item.value)?.enabled === false}
              onPick={() => pick(item.value)}
            />
          ))}
        </div>
        {errors.harness ? <span className="text-xs text-error">{errors.harness}</span> : null}
      </div>
      {form.harness ? (
        <HarnessModelFields
          key={form.harness}
          form={form}
          harness={form.harness}
          onChange={onChange}
          error={errors.harness_model}
        />
      ) : null}
    </div>
  );
}

/**
 * The coding agent's harness and the model it runs, with a note that it runs on the operator's own
 * subscription; for an existing agent, what its code tasks still need under it.
 */
export function HarnessField({
  form,
  onChange,
  errors,
  agent,
  carried,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  errors: ConfigErrors;
  agent?: SettingsAgent | undefined;
  carried?: readonly Harness[] | null | undefined;
}) {
  const missing = form.harness ? harnessCarried(carried, form.harness) === false : false;
  return (
    <div className="flex flex-col gap-3">
      <HarnessChoiceFields form={form} onChange={onChange} errors={errors} carried={carried} />
      {missing ? (
        <p className="text-sm text-t-ochre-fg">
          This machine&apos;s image doesn&apos;t carry {harnessLabel(form.harness)}, so its code
          tasks fail. Pick another harness, or move the agent to a machine that has it.
        </p>
      ) : agent && form.harness ? (
        <HarnessReadiness
          agent={agent}
          harness={form.harness}
          aliases={form.secret_aliases}
          onAliasesChange={(secret_aliases) => onChange({ ...form, secret_aliases })}
        />
      ) : null}
      {showsHarnessImageNote(carried) ? (
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Icon icon={Info} size={14} className="shrink-0" />
          <span>{harnessImageNote}</span>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Icon icon={Info} size={14} className="shrink-0" />
        <span>{harnessSubscriptionNote}</span>
      </div>
    </div>
  );
}

/**
 * Browser, Coding, scripting, and Memory. Every agent has the CLI, so it has no card. Browser and
 * Coding are greyed out while off when the machine is below the minimum they would set, with a
 * line that points to Settings → Machines; Coding stays on once saved: a coding agent stays one.
 * `codingToggle` false leaves the Coding card out, where the kind of agent was chosen before the form.
 * With the browser on, its settings follow the cards.
 */
export function CapabilitiesFields({
  form,
  onChange,
  models,
  errors = {},
  machine,
  codingToggle = true,
  savedCoding = false,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  models?: OrgModels | undefined;
  errors?: ConfigErrors;
  /** The machine the agent goes on; undefined while none is chosen. */
  machine?: Pick<Machine, "name" | "cpu" | "memory_mib"> | undefined;
  codingToggle?: boolean;
  /** Whether the saved agent codes, which keeps Coding on. */
  savedCoding?: boolean;
}) {
  const browserMinimum = agentMinimum({ browser: true, coding: form.coding });
  const codingMinimum = agentMinimum({ browser: form.browser, coding: true });
  const browserBlocked =
    !form.browser && machine !== undefined && !sizeMeets(machine, browserMinimum);
  const codingBlocked =
    codingToggle && !form.coding && machine !== undefined && !sizeMeets(machine, codingMinimum);
  return (
    <>
      <div
        className={cn("grid grid-cols-2 gap-2", codingToggle ? "sm:grid-cols-4" : "sm:grid-cols-3")}
      >
        <CapabilityField
          label="Browser"
          hint="Browser tab and tools. Uses a browser slot."
          icon={Globe}
          checked={form.browser}
          disabled={browserBlocked}
          onChange={(browser) => onChange(withBrowser(form, browser))}
        />
        {codingToggle ? (
          <CapabilityField
            label="Coding"
            hint={
              savedCoding
                ? "Shell, and a harness for code work. A coding agent stays one."
                : "Shell, and a harness for code work. Turns on scripting. Uses a coding slot."
            }
            icon={Code2}
            checked={form.coding}
            disabled={savedCoding || codingBlocked}
            onChange={(coding) => onChange(withCoding(form, coding, models))}
          />
        ) : null}
        <CapabilityField
          label="Scripting"
          hint="The Scripts tab and the script tools."
          icon={FileCode}
          checked={form.scripting}
          onChange={(scripting) => onChange({ ...form, scripting })}
        />
        <CapabilityField
          label="Memory"
          hint="One Markdown file the agent rewrites to remember across runs."
          icon={Bookmark}
          checked={form.memory}
          onChange={(memory) => onChange({ ...form, memory })}
        />
      </div>
      {machine && codingBlocked ? (
        <TooSmallNote machine={machine} minimum={codingMinimum} what="Coding" />
      ) : machine && browserBlocked ? (
        <TooSmallNote machine={machine} minimum={browserMinimum} what="Browser" />
      ) : null}
      {form.browser ? (
        <BrowserFields form={form} onChange={onChange} models={models} errors={errors} />
      ) : null}
    </>
  );
}
