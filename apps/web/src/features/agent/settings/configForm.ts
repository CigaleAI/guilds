import type {
  AgentConfig,
  Harness,
  HarnessCatalog,
  HarnessEffort,
  Machine,
  ThinkingLevel,
} from "../../../api/types/agents";
import type { OrgModels } from "../../../api/types/models";
import { isCodingOnlyModel } from "../../../api/types/models";
import { chosenMachine } from "../../machines/machines";
import { modelLimits, modelProviderConnected, providerLabel } from "../../models/models";
import { catalogFor, harnessEffortsFor, isHarness } from "../harness";

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

/** The run limits, the script cap and the disk cap that are not a whole number of 1 or more. */
function budgetErrors(form: ConfigForm): ConfigErrors {
  const errors: ConfigErrors = {};
  for (const field of limitFields) {
    if (!positiveInteger(form[field.key])) errors[field.key] = "A whole number, 1 or more.";
  }
  if (!positiveInteger(form.max_scripts)) errors.max_scripts = "A whole number, 1 or more.";
  if (!positiveInteger(form.max_workspace_mib))
    errors.max_workspace_mib = "A whole number, 1 or more.";
  return errors;
}

/** What is wrong with a coding agent's harness and its model; nothing for an agent that does not code. */
function harnessErrors(form: ConfigForm): ConfigErrors {
  const errors: ConfigErrors = {};
  if (form.coding && !form.harness) errors.harness = "Pick a harness.";
  if (form.coding && !harnessModelPattern.test(form.harness_model.trim()))
    errors.harness_model =
      "Up to 120 letters, digits, and . _ : / = , [ ] -, starting with a letter or digit.";
  return errors;
}

/** What is wrong with the agent's model: none chosen, a coding plan's without Coding, or its provider not connected. */
function modelError(form: ConfigForm, models: OrgModels | undefined): string | undefined {
  if (!form.model) return "Choose a model.";
  if (isCodingOnlyModel(form.model, models) && !form.coding) {
    return "Turn Coding on to use this model.";
  }
  if (modelProviderConnected(models, form.model) === false) {
    return `Connect a ${providerLabel(models, form.model)} key on Model keys first.`;
  }
  return undefined;
}

export function configErrors(form: ConfigForm, context: ConfigErrorContext = {}): ConfigErrors {
  const errors: ConfigErrors = budgetErrors(form);
  if (!form.temperature.trim() || !Number.isFinite(Number(form.temperature)))
    errors.temperature = "A number.";
  Object.assign(errors, harnessErrors(form));
  if (context.machines && !chosenMachine(context.machines, form.machine_id)) {
    errors.machine = "Choose a machine.";
  }
  const model = modelError(form, context.models);
  if (model) errors.model = model;
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

export type FieldsProps = {
  form: ConfigForm;
  onChange: (patch: Partial<ConfigForm>) => void;
  errors: ConfigErrors;
};

/** Whether a capability is on. Missing `scripting` and `memory` mean on. */
export function capabilityOn(
  config: Partial<Pick<AgentConfig, "browser" | "coding" | "scripting" | "memory">> | undefined,
  key: "browser" | "coding" | "scripting" | "memory",
): boolean {
  if (key === "scripting" || key === "memory") return config?.[key] !== false;
  return Boolean(config?.[key]);
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
      ? { model: models?.default ?? "", thinking: "none" as const }
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
