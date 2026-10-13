import { Bookmark, Code2, FileCode, Globe, SquareTerminal, type LucideIcon } from "lucide-react";
import { useOrgModels } from "../../../api/queries";
import type {
  AgentConfig,
  Harness,
  Machine,
  MachineRef,
  OrgModels,
  ThinkingLevel,
} from "../../../api/types";
import { isCodingOnlyModel } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { cn, Icon, Select, Slider, TextField } from "@guildsrun/ui";
import { chosenMachine, machineAllowsCoding } from "../../machines/machines";
import { StandardMachineNote } from "../../machines/MachineNotes";
import { modelLimits, modelOptions, modelProviderConnected, providerLabel } from "../../models/models";
import { ModelKeysLink } from "../../settings/ModelKeysLink";
import { harnessOptions, isHarness } from "../harness";
import { HarnessCredentials } from "./HarnessCredentials";
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
  cli: true,
  browser: false,
  browser_language: "en-US",
  coding: false,
  harness: null,
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

/** Chrome language tags the settings picker offers, US English first. */
export const browserLanguageOptions = [
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "ar", label: "Arabic" },
  { value: "bg", label: "Bulgarian" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "zh-TW", label: "Chinese (Traditional)" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "el", label: "Greek" },
  { value: "he", label: "Hebrew" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
  { value: "id", label: "Indonesian" },
  { value: "it-IT", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "ms", label: "Malay" },
  { value: "nb", label: "Norwegian" },
  { value: "pl", label: "Polish" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sr", label: "Serbian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es-ES", label: "Spanish" },
  { value: "es-419", label: "Spanish (Latin America)" },
  { value: "sv", label: "Swedish" },
  { value: "th", label: "Thai" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
  { value: "vi", label: "Vietnamese" },
] as const;

function languageOptions(current: string) {
  if (browserLanguageOptions.some((item) => item.value === current)) {
    return browserLanguageOptions;
  }
  return [{ value: current, label: current }, ...browserLanguageOptions];
}

/** A model config and the agent's machine as a form edits them: numbers stay text while typed. */
export type ConfigForm = {
  model: string;
  thinking: ThinkingLevel;
  temperature: string;
  /** The machine the agent goes on; empty until one is picked among several. */
  machine_id: string;
  cli: boolean;
  browser: boolean;
  browser_language: string;
  coding: boolean;
  /** The coding agent's harness; empty until one is picked. */
  harness: Harness | "";
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
    | "harness",
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
    cli: config.cli !== false,
    browser: config.browser,
    browser_language: config.browser_language ?? "en-US",
    coding: config.coding,
    harness: isHarness(config.harness) ? config.harness : "",
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
  return errors;
}

/**
 * The config to send, without the machine; a model that does not reason gets thinking off, and
 * only a coding agent carries a harness.
 */
export function configOf(form: ConfigForm, models: OrgModels | undefined): AgentConfig {
  return {
    model: form.model,
    temperature: Number(form.temperature),
    thinking_level: modelLimits(models, form.model).thinkingOff ? "none" : form.thinking,
    cli: form.cli,
    browser: form.browser,
    browser_language: form.browser_language,
    coding: form.coding,
    harness: form.coding && form.harness ? form.harness : null,
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
  const codingConnected = models.data?.providers.some((item) => item.kind === "coding" && item.connected);
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

/** The agent home's disk cap, in MiB, beside how many scripts the agent may keep. */
export function DiskFields({ form, onChange, errors }: FieldsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
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
    </div>
  );
}

/** Whether a capability is on. Missing `cli`, `scripting`, and `memory` mean on. */
export function capabilityOn(
  config:
    Partial<Pick<AgentConfig, "cli" | "browser" | "coding" | "scripting" | "memory">> | undefined,
  key: "cli" | "browser" | "coding" | "scripting" | "memory",
): boolean {
  if (key === "cli" || key === "scripting" || key === "memory") return config?.[key] !== false;
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
      <span className={cn("text-xs text-pretty", checked ? "opacity-80" : "text-muted")}>{hint}</span>
    </button>
  );
}

/**
 * A new agent's form with coding switched: limits still at the defaults move to the coding
 * budgets, and back when coding is switched off again. Turning coding on also turns on CLI
 * and scripting; turning it off clears the harness.
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
    ...(coding ? { cli: true, scripting: true } : { harness: "" as const }),
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

/** Chrome's language while the browser is on. */
function BrowserLanguageField({ form, onChange }: { form: ConfigForm; onChange: (next: ConfigForm) => void }) {
  return (
    <Select
      tone="surface"
      label="Browser language"
      hint="Chrome's interface language and the language sites see. Changing it restarts the browser."
      value={form.browser_language}
      onValueChange={(value) => onChange({ ...form, browser_language: value })}
      options={languageOptions(form.browser_language)}
    />
  );
}

/** The agent an existing agent's settings edit, for the links and credentials they show. */
export type SettingsAgent = { guildId: string; agentId: string };

/**
 * The coding agent's harness, with a note that it runs on the operator's own subscription; for
 * an existing agent, the harness's credential status under it.
 */
function HarnessField({
  form,
  onChange,
  error,
  agent,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  error?: string | undefined;
  agent?: SettingsAgent | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Select
        tone="surface"
        label="Harness"
        placeholder="Choose a harness"
        value={form.harness}
        onValueChange={(value) => onChange({ ...form, harness: value as Harness })}
        options={harnessOptions}
        {...(error ? { error } : {})}
      />
      {agent && form.harness ? (
        <HarnessCredentials {...agent} harness={form.harness} cli={form.cli} />
      ) : null}
      <p className="text-sm text-muted">
        The harness does the code work on your own subscription. Using a personal subscription in a
        shared organisation may fall outside the vendor&apos;s terms.
      </p>
    </div>
  );
}

/**
 * Browser, Coding, CLI, scripting, and Memory. Coding is greyed out on a standard machine, with a
 * line that points to Settings → Machines; an agent that already codes there can still switch it
 * off. A coding agent picks its harness.
 */
export function CapabilitiesFields({
  form,
  onChange,
  errors = {},
  models,
  machine,
  agent,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  errors?: ConfigErrors;
  models?: OrgModels | undefined;
  /** The machine the agent goes on; undefined while none is chosen. */
  machine?: MachineRef | undefined;
  /** The agent being edited; undefined while one is created. */
  agent?: SettingsAgent | undefined;
}) {
  const standard = machine !== undefined && !machineAllowsCoding(machine.box);
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <CapabilityField
          label="Browser"
          hint="Browser tab and tools. Uses a browser slot."
          icon={Globe}
          checked={form.browser}
          onChange={(browser) => onChange({ ...form, browser })}
        />
        <CapabilityField
          label="Coding"
          hint="Shell, and a harness for code work. Turns on CLI and scripting. Uses a coding slot."
          icon={Code2}
          checked={form.coding}
          disabled={standard && !form.coding}
          onChange={(coding) => onChange(withCoding(form, coding, models))}
        />
        <CapabilityField
          label="CLI"
          hint="The CLI tab, a terminal on the machine."
          icon={SquareTerminal}
          checked={form.cli}
          onChange={(cli) => onChange({ ...form, cli })}
        />
        <CapabilityField
          label="Scripting"
          hint="The Scripts tab and the script tools."
          icon={FileCode}
          checked={form.scripting}
          onChange={(scripting) => onChange({ ...form, scripting })}
        />
        <CapabilityField
          label="Memory"
          hint="Notes the agent keeps between runs."
          icon={Bookmark}
          checked={form.memory}
          onChange={(memory) => onChange({ ...form, memory })}
        />
      </div>
      {standard ? <StandardMachineNote machine={machine} /> : null}
      {form.coding ? (
        <HarnessField form={form} onChange={onChange} error={errors.harness} agent={agent} />
      ) : null}
      {form.browser ? <BrowserLanguageField form={form} onChange={onChange} /> : null}
    </>
  );
}
