import { useOrgModels } from "../../../api/queries";
import type { AgentConfig, Box, OrgModels, ThinkingLevel } from "../../../api/types";
import { customBoxBounds, isCodingOnlyModel } from "../../../api/types";
import { useIdentity } from "../../../app/identity";
import { Checkbox, FormField, RadioGroup, Select, Slider, TextField } from "@guildsrun/ui";
import { modelLimits, modelOptions, modelProviderConnected, providerLabel } from "../../models/models";
import { ModelKeysLink } from "../../settings/ModelKeysLink";
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
  scripting: true,
  memory: true,
  thinking_level: "none",
  box: "lite",
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

/** A model config as a form edits it: numbers stay text while typed. */
export type ConfigForm = {
  model: string;
  thinking: ThinkingLevel;
  temperature: string;
  box: Box;
  /** A custom box's size, as typed; empty on the other boxes. */
  cpu: string;
  memory_mib: string;
  cli: boolean;
  browser: boolean;
  browser_language: string;
  coding: boolean;
  scripting: boolean;
  memory: boolean;
  max_scripts: string;
  max_workspace_mib: string;
} & Record<LimitKey, string>;

export type ConfigErrors = Partial<
  Record<
    LimitKey | "temperature" | "max_scripts" | "max_workspace_mib" | "model" | "box" | "cpu" | "memory_mib",
    string
  >
>;

export type ConfigErrorContext = {
  models?: OrgModels | undefined;
};

export function configFormOf(config: AgentConfig): ConfigForm {
  return {
    model: config.model,
    thinking: config.thinking_level,
    temperature: String(config.temperature),
    box: config.box ?? boxForFlags(config),
    cpu: config.cpu === undefined ? "" : String(config.cpu),
    memory_mib: config.memory_mib === undefined ? "" : String(config.memory_mib),
    cli: config.cli !== false,
    browser: config.browser,
    browser_language: config.browser_language ?? "en-US",
    coding: config.coding,
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

/** The box the flags call for: code with coding on, standard with the browser alone, lite with neither. */
function boxForFlags(flags: { browser?: boolean; coding?: boolean }): Box {
  if (flags.coding) return "code";
  return flags.browser ? "standard" : "lite";
}

function positiveInteger(text: string): boolean {
  return /^\d+$/.test(text.trim()) && Number(text) >= 1;
}

function customCpu(text: string): boolean {
  const value = Number(text);
  return (
    text.trim() !== "" &&
    Number.isFinite(value) &&
    value >= customBoxBounds.minCpu &&
    value <= customBoxBounds.maxCpu &&
    Number.isInteger(value / customBoxBounds.cpuStep)
  );
}

function customMemory(text: string): boolean {
  return (
    positiveInteger(text) &&
    Number(text) >= customBoxBounds.minMemoryMib &&
    Number(text) <= customBoxBounds.maxMemoryMib
  );
}

/** What the box refuses, as the server does: the flags it settles, and a size only on custom. */
function boxError(form: ConfigForm): string | undefined {
  if (form.box === "lite" && (form.browser || form.coding))
    return "A lite box has no browser and no code tools.";
  if (form.box === "standard" && form.coding) return "A standard box has no code tools. Pick Code or Custom.";
  if (form.box === "code" && !form.coding) return "A code box has coding on.";
  return undefined;
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
  const box = boxError(form);
  if (box) errors.box = box;
  if (form.box === "custom") {
    if (!customCpu(form.cpu))
      errors.cpu = `${customBoxBounds.minCpu} to ${customBoxBounds.maxCpu} CPUs, in steps of ${customBoxBounds.cpuStep}.`;
    if (!customMemory(form.memory_mib))
      errors.memory_mib = `A whole number of MiB, ${customBoxBounds.minMemoryMib} to ${customBoxBounds.maxMemoryMib}.`;
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

/** The config to send; a model that does not reason gets thinking off. */
export function configOf(form: ConfigForm, models: OrgModels | undefined): AgentConfig {
  return {
    model: form.model,
    temperature: Number(form.temperature),
    thinking_level: modelLimits(models, form.model).thinkingOff ? "none" : form.thinking,
    box: form.box,
    ...(form.box === "custom" ? { cpu: Number(form.cpu), memory_mib: Number(form.memory_mib) } : {}),
    cli: form.cli,
    browser: form.browser,
    browser_language: form.browser_language,
    coding: form.coding,
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

/** Workspace disk cap, in MiB. */
export function DiskFields({ form, onChange, errors }: FieldsProps) {
  return (
    <TextField
      tone="surface"
      label="Max disk"
      type="number"
      min={1}
      step={1}
      hint="MiB the agent's workspace may hold. A generation will not start if the workspace is already over this. 10240 is 10 GiB."
      value={form.max_workspace_mib}
      onChange={(event) => onChange({ max_workspace_mib: event.currentTarget.value })}
      {...(errors.max_workspace_mib ? { error: errors.max_workspace_mib } : {})}
    />
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

function CapabilityField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        label={label}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <p className="pl-7 text-sm text-fg-2">{hint}</p>
    </div>
  );
}

/**
 * A new agent's form with coding switched: limits still at the defaults move to the coding
 * budgets, and back when coding is switched off again. Turning coding on also turns on CLI
 * and scripting.
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
    ...(coding ? { cli: true, scripting: true } : {}),
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

/**
 * The form moved onto a box. Lite turns the browser and coding off and takes the default budgets
 * back. Standard turns the browser on and coding off. Code turns both on, with the coding budgets,
 * CLI and scripting. Custom turns the browser on, keeps the coding switch where it is, and starts
 * its size from the tier the form leaves: the code size with coding on, else the standard one.
 */
export function withBox(form: ConfigForm, box: Box, models?: OrgModels | undefined): ConfigForm {
  switch (box) {
    case "lite":
      return { ...withCoding(form, false, models), box, browser: false, cpu: "", memory_mib: "" };
    case "standard":
      return { ...withCoding(form, false, models), box, browser: true, cpu: "", memory_mib: "" };
    case "code":
      return { ...withCoding(form, true, models), box, browser: true, cpu: "", memory_mib: "" };
    case "custom":
      return {
        ...form,
        box,
        browser: true,
        cpu: form.cpu || (form.coding ? "2" : "1"),
        memory_mib: form.memory_mib || (form.coding ? "4096" : "2048"),
      };
  }
}

const boxOptions: Array<{ value: Box; title: string; hint: string }> = [
  {
    value: "lite",
    title: "Lite",
    hint: "Scripts, notes, connectors and a terminal on the smallest machine: 0.5 CPU, 256 MiB. No browser, no code tools.",
  },
  {
    value: "standard",
    title: "Standard",
    hint: "A browser on a medium machine: 1 CPU, 2 GiB, with Chromium. No code tools. Takes one browser slot from the plan.",
  },
  {
    value: "code",
    title: "Code",
    hint: "Coding and a browser on the large machine: 2 CPU, 4 GiB, with Node.js, build tools, git and Chromium. Takes one browser slot and one coding slot from the plan.",
  },
  {
    value: "custom",
    title: "Custom",
    hint: `The browser machine at a size you choose, ${customBoxBounds.minCpu} to ${customBoxBounds.maxCpu} CPUs and ${customBoxBounds.minMemoryMib} to ${customBoxBounds.maxMemoryMib} MiB, with coding on or off.`,
  },
];

/** Lite, Standard, Code or Custom. Changing an existing agent's box replaces its sandbox. */
export function BoxPicker({
  form,
  onChange,
  models,
  error,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  models?: OrgModels | undefined;
  error?: string | undefined;
}) {
  return (
    <FormField controlId="agent-box" labelFor={false} error={error}>
      <RadioGroup
        id="agent-box"
        aria-label="Box"
        className="gap-3"
        value={form.box}
        onValueChange={(value) => onChange(withBox(form, value as Box, models))}
        options={boxOptions.map((option) => ({
          value: option.value,
          label: (
            <span className="flex flex-col gap-0.5">
              <span>{option.title}</span>
              <span className="text-sm text-fg-2">{option.hint}</span>
            </span>
          ),
        }))}
      />
    </FormField>
  );
}

/** Chrome's language on a box with a browser. */
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

/** A custom box's CPUs and memory. */
function CustomSizeFields({
  form,
  onChange,
  errors,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  errors: ConfigErrors;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TextField
        tone="surface"
        label="CPUs"
        type="number"
        min={customBoxBounds.minCpu}
        max={customBoxBounds.maxCpu}
        step={customBoxBounds.cpuStep}
        hint={`${customBoxBounds.minCpu} to ${customBoxBounds.maxCpu}, in steps of ${customBoxBounds.cpuStep}.`}
        value={form.cpu}
        onChange={(event) => onChange({ ...form, cpu: event.currentTarget.value })}
        {...(errors.cpu ? { error: errors.cpu } : {})}
      />
      <TextField
        tone="surface"
        label="Memory"
        type="number"
        min={customBoxBounds.minMemoryMib}
        max={customBoxBounds.maxMemoryMib}
        step={1}
        hint={`MiB, ${customBoxBounds.minMemoryMib} to ${customBoxBounds.maxMemoryMib}. 2048 is 2 GiB.`}
        value={form.memory_mib}
        onChange={(event) => onChange({ ...form, memory_mib: event.currentTarget.value })}
        {...(errors.memory_mib ? { error: errors.memory_mib } : {})}
      />
    </div>
  );
}

/**
 * What the chosen box leaves to the operator: nothing on lite; the Browser switch (and its
 * language) on every other box; on custom, the Coding switch and the size as well. Switching the
 * browser or coding, or resizing, replaces the sandbox.
 */
export function BoxFields({
  form,
  onChange,
  models,
  errors,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  models?: OrgModels | undefined;
  errors: ConfigErrors;
}) {
  if (form.box === "lite") return null;
  return (
    <>
      {form.box === "custom" ? <CustomSizeFields form={form} onChange={onChange} errors={errors} /> : null}
      <CapabilityField
        label="Browser"
        hint="Adds the Browser tab and browser tools. Its signed-in profile lives in the agent's sandbox, which is replaced when this changes. It takes one of the plan's browser slots."
        checked={form.browser}
        onChange={(browser) => onChange({ ...form, browser })}
      />
      {form.browser ? <BrowserLanguageField form={form} onChange={onChange} /> : null}
      {form.box === "custom" ? (
        <CapabilityField
          label="Coding"
          hint="Adds the shell and code tools. It also turns on CLI and scripting. It takes one of the plan's coding slots. The sandbox is replaced when this changes."
          checked={form.coding}
          onChange={(coding) => onChange(withCoding(form, coding, models))}
        />
      ) : null}
    </>
  );
}

/** The extras any box may have: CLI, scripting, and Memory. */
export function CapabilitiesFields({
  form,
  onChange,
}: {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
}) {
  return (
    <>
      <CapabilityField
        label="CLI"
        hint="Adds the CLI tab, a terminal on the agent's machine."
        checked={form.cli}
        onChange={(cli) => onChange({ ...form, cli })}
      />
      <CapabilityField
        label="Scripting"
        hint="Adds the Scripts tab and the script tools."
        checked={form.scripting}
        onChange={(scripting) => onChange({ ...form, scripting })}
      />
      <CapabilityField
        label="Memory"
        hint="Adds Memory to the opening system prompt and the memory_write tool. The agent writes whatever it wants to remember between runs."
        checked={form.memory}
        onChange={(memory) => onChange({ ...form, memory })}
      />
    </>
  );
}
