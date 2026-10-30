import { HARNESSES, type Harness, EFFORTS, type Effort } from "../db/schema/index.js";
import { isCodingOnlyModel, parseModelId } from "../llm/providers.js";
import { HARNESS_MODEL_RE, harnessOffMessage, isHarness, isHarnessOff } from "../coding/harnesses.js";
import { harnessEffortsFor, isEffort } from "../coding/harness-models.js";
import { SECRET_NAME } from "../credentials/validate.js";
import type { AgentConfig, ThinkingLevel } from "../db/schema/index.js";
import { integrationState, SYSTEM_ONE } from "../instance/integrations.js";
import { AgentValidationError } from "./validation.js";

export const CONFIG_KEYS = new Set([
  "model",
  "temperature",
  "max_tokens",
  "max_steps",
  "max_tool_calls",
  "max_input_tokens",
  "keep_tool_result_generations",
  "max_scripts",
  "max_workspace_mib",
  "browser",
  "browser_language",
  "browser_optimized",
  "browser_model",
  "coding",
  "harness",
  "harness_model",
  "harness_effort",
  "secret_aliases",
  "scripting",
  "memory",
  "thinking_level",
]);
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_MAX_STEPS = 30;
export const DEFAULT_MAX_TOOL_CALLS = 50;
export const DEFAULT_MAX_INPUT_TOKENS = 100_000;
/** How many user turns, including the current one, keep full tool results in the model prompt. */
export const DEFAULT_KEEP_TOOL_RESULT_GENERATIONS = 1;
export const DEFAULT_MAX_SCRIPTS = 10;
/** An agent's workspace cap, in MiB. Above this the next generation fails at start. */
export const DEFAULT_MAX_WORKSPACE_MIB = 10240;
/** A new agent keeps script tools unless the operator turns this off. */
export const DEFAULT_SCRIPTING = true;
/** A new agent keeps Memory and `memory_write` unless the operator turns this off. */
export const DEFAULT_MEMORY = true;
/** How many secret aliases an agent's config may hold. */
export const SECRET_ALIASES_MAX = 32;
/** The step and tool-call budgets an agent created with `coding` on starts with. */
export const CODING_MAX_STEPS = 200;
export const CODING_MAX_TOOL_CALLS = 200;
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "none";
/** Chrome UI and Accept-Language when the agent has a browser and none is stored. */
export const DEFAULT_BROWSER_LANGUAGE = "en-US";
/** A new agent browses with the step-by-step browser tools unless the operator turns this on. */
export const DEFAULT_BROWSER_OPTIMIZED = false;
/** Chrome language tags an agent may use. */
export const BROWSER_LANGUAGES = [
  "ar",
  "bg",
  "cs",
  "da",
  "de-DE",
  "el",
  "en-GB",
  "en-US",
  "es-419",
  "es-ES",
  "et",
  "fi",
  "fr-FR",
  "he",
  "hi",
  "hr",
  "hu",
  "id",
  "it-IT",
  "ja",
  "ko",
  "lt",
  "lv",
  "ms",
  "nb",
  "nl",
  "pl",
  "pt-BR",
  "pt-PT",
  "ro",
  "ru",
  "sk",
  "sl",
  "sr",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
  "zh-CN",
  "zh-TW",
] as const;
export type BrowserLanguage = (typeof BROWSER_LANGUAGES)[number];
const BROWSER_LANGUAGE_SET = new Set<string>(BROWSER_LANGUAGES);

/**
 * The value each setting takes when a payload leaves it out: no browser, the step-by-step browser
 * tools, no coding, no harness, the harness's default model and effort, no secret aliases, and the
 * default limits. Only `model` has none.
 */
const AGENT_CONFIG_DEFAULTS: Omit<AgentConfig, "model"> = {
  temperature: DEFAULT_TEMPERATURE,
  max_tokens: DEFAULT_MAX_TOKENS,
  max_steps: DEFAULT_MAX_STEPS,
  max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
  max_input_tokens: DEFAULT_MAX_INPUT_TOKENS,
  keep_tool_result_generations: DEFAULT_KEEP_TOOL_RESULT_GENERATIONS,
  max_scripts: DEFAULT_MAX_SCRIPTS,
  max_workspace_mib: DEFAULT_MAX_WORKSPACE_MIB,
  browser: false,
  browser_language: DEFAULT_BROWSER_LANGUAGE,
  browser_optimized: DEFAULT_BROWSER_OPTIMIZED,
  browser_model: null,
  coding: false,
  harness: null,
  harness_model: null,
  harness_effort: null,
  secret_aliases: {},
  scripting: DEFAULT_SCRIPTING,
  memory: DEFAULT_MEMORY,
  thinking_level: DEFAULT_THINKING_LEVEL,
};

/**
 * A new agent's configuration payload: with `coding` on, missing step and tool-call limits take
 * the coding budgets instead of the defaults.
 */
export function withCodingLimits(config: Record<string, unknown>): Record<string, unknown> {
  if (config.coding !== true) {
    return config;
  }
  return { max_steps: CODING_MAX_STEPS, max_tool_calls: CODING_MAX_TOOL_CALLS, ...config };
}

export function validateBrowserLanguage(value: unknown): string {
  const text = (typeof value === "string" ? value : "").trim();
  if (BROWSER_LANGUAGE_SET.has(text)) {
    return text;
  }
  throw new AgentValidationError("browser_language must be a supported Chrome language");
}

const NONE_THINKING_ALIASES = new Set(["", "none", "off", "disabled"]);
const ACTIVE_THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high"];

export function validateThinkingLevel(value: unknown): ThinkingLevel {
  const text = (typeof value === "string" ? value : "").trim().toLowerCase();
  if (NONE_THINKING_ALIASES.has(text)) {
    return "none";
  }
  const level = ACTIVE_THINKING_LEVELS.find((item) => item === text);
  if (level !== undefined) {
    return level;
  }
  throw new AgentValidationError("thinking_level must be one of: none, low, medium, high");
}

function rejectUnknownOrMissingConfigKeys(filled: Record<string, unknown>): void {
  const extra = [...Object.keys(filled)].filter((key) => !CONFIG_KEYS.has(key)).sort();
  const missing = [...CONFIG_KEYS].filter((key) => !(key in filled)).sort();
  if (extra.length === 0 && missing.length === 0) {
    return;
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing keys: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    parts.push(`unknown keys: ${extra.join(", ")}`);
  }
  throw new AgentValidationError(parts.join("; "));
}

/** A stored model id: `{provider}/{model}` with a provider core speaks to; the catalog is not consulted. */
function requireModelId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentValidationError("model must be a non-empty string");
  }
  const model = value.trim();
  if (!parseModelId(model)) {
    throw new AgentValidationError(`unknown model provider: ${model}`);
  }
  return model;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AgentValidationError(`${field} must be a number`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AgentValidationError(`${field} must be a positive integer`);
  }
  return value;
}

function requireBooleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AgentValidationError(`${field} must be a boolean`);
  }
  return value;
}

/** The agent-optimized browser is a mode of the browser: an agent without one cannot turn it on. */
function rejectBrowserOptimizedWithoutBrowser(browserOptimized: boolean, browser: boolean): void {
  if (browserOptimized && !browser) {
    throw new AgentValidationError("browser_optimized requires browser");
  }
}

/**
 * Whether the agent's runs browse with the agent-optimized browser: its config turns it on and the
 * System One key is on. Without the key its runs offer the step-by-step browser tools.
 */
export function isOptimizedBrowserOn(config: Pick<AgentConfig, "browser_optimized">): boolean {
  return config.browser_optimized === true && integrationState(SYSTEM_ONE) === "on";
}

/**
 * The model the agent-optimized browser plans and reads with: with `browser_optimized` on, a
 * `{provider}/{model}` id of a provider core speaks to that is not for coding agents only; with it
 * off, null or blank, read as null.
 */
function requireBrowserModel(value: unknown, browserOptimized: boolean): string | null {
  const model = typeof value === "string" ? value.trim() : value;
  if (!browserOptimized) {
    if (model === null || model === "") {
      return null;
    }
    throw new AgentValidationError("browser_model is only for the agent-optimized browser");
  }
  if (typeof model !== "string" || !parseModelId(model) || isCodingOnlyModel(model)) {
    throw new AgentValidationError(
      "browser_model must be a marketplace {provider}/{model} when browser_optimized is on",
    );
  }
  return model;
}

function requireHarness(value: unknown): Harness | null {
  if (value === null) {
    return null;
  }
  if (!isHarness(value)) {
    throw new AgentValidationError(`harness must be one of: ${HARNESSES.join(", ")}`);
  }
  return value;
}

function rejectHarnessWithoutCoding(harness: Harness | null, coding: boolean): void {
  if (harness !== null && !coding) {
    throw new AgentValidationError("harness is only for coding agents");
  }
}

/** The harness's model: null or blank for its subscription's default, else a model name for a set harness. */
function requireHarnessModel(value: unknown, harness: Harness | null): string | null {
  const model = typeof value === "string" ? value.trim() : value;
  if (model === null || model === "") {
    return null;
  }
  if (typeof model !== "string" || !HARNESS_MODEL_RE.test(model)) {
    throw new AgentValidationError(
      "harness_model must be a model name: up to 120 letters, digits, and . _ : / = , [ ] -",
    );
  }
  if (harness === null) {
    throw new AgentValidationError("harness_model needs a harness");
  }
  return model;
}

/** Why the harness does not run the model at an effort: it takes none, or other ones. */
function unofferedEffortMessage(harness: Harness, model: string | null): string {
  const efforts = harnessEffortsFor(harness, model);
  const named = model ?? "the default model";
  return efforts.length === 0
    ? `harness_effort: ${named} takes no effort on ${harness}`
    : `harness_effort must be one of ${efforts.join(", ")} for ${named}`;
}

/** The harness's effort: null or blank for the harness's default, else one the model runs at. */
function requireHarnessEffort(value: unknown, harness: Harness | null, model: string | null): Effort | null {
  const effort = typeof value === "string" ? value.trim() : value;
  if (effort === null || effort === "") {
    return null;
  }
  if (!isEffort(effort)) {
    throw new AgentValidationError(`harness_effort must be one of: ${EFFORTS.join(", ")}`);
  }
  if (harness === null) {
    throw new AgentValidationError("harness_effort needs a harness");
  }
  if (!harnessEffortsFor(harness, model).includes(effort)) {
    throw new AgentValidationError(unofferedEffortMessage(harness, model));
  }
  return effort;
}

function isAliasMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAliasEntry(alias: string, source: unknown): string {
  if (!SECRET_NAME.test(alias) || typeof source !== "string" || !SECRET_NAME.test(source)) {
    throw new AgentValidationError("secret_aliases maps environment variable names to secret names");
  }
  if (source === alias) {
    throw new AgentValidationError(`secret_aliases: ${alias} must name another secret`);
  }
  return source;
}

/** The agent's secret aliases: a map of variable names to secret names, at most `SECRET_ALIASES_MAX`. */
function requireSecretAliases(value: unknown): Record<string, string> {
  if (!isAliasMap(value)) {
    throw new AgentValidationError("secret_aliases must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > SECRET_ALIASES_MAX) {
    throw new AgentValidationError(`secret_aliases holds at most ${SECRET_ALIASES_MAX} entries`);
  }
  return Object.fromEntries(entries.map(([alias, source]) => [alias, requireAliasEntry(alias, source)]));
}

/** Whether a value is secret aliases an agent's config takes, as `validateAgentConfig` checks them. */
export function isValidSecretAliases(value: unknown): value is Record<string, string> {
  try {
    requireSecretAliases(value);
    return true;
  } catch (error) {
    if (error instanceof AgentValidationError) {
      return false;
    }
    throw error;
  }
}

/**
 * A coding agent needs a harness: every create and update is refused without one, and an update
 * cannot switch a coding agent's coding off. A stored coding agent without one still validates;
 * it is not ready, and its coding runs fail at start.
 */
export function assertCodingAgent(config: AgentConfig, previous?: AgentConfig): void {
  if (previous?.coding === true && !config.coding) {
    throw new AgentValidationError("coding cannot be switched off on a coding agent");
  }
  if (!config.coding) {
    return;
  }
  if (config.harness === null) {
    throw new AgentValidationError(`coding agents need a harness: ${HARNESSES.join(", ")}`);
  }
  assertHarnessPickable(config.harness, previous);
}

/** A harness the box turns off cannot be picked; an agent already on it keeps it until it picks another. */
function assertHarnessPickable(harness: Harness, previous?: AgentConfig): void {
  if (isHarnessOff(harness) && previous?.harness !== harness) {
    throw new AgentValidationError(harnessOffMessage(harness));
  }
}

function rejectCodingOnlyModelWithoutCoding(model: string, coding: boolean): void {
  if (isCodingOnlyModel(model) && !coding) {
    throw new AgentValidationError("coding API models are only for coding agents");
  }
}

/**
 * An agent's config from a payload: every key the payload leaves out takes its default, then
 * each value is checked. A payload without a model, with a key that is not a setting, or with a
 * value a setting does not take is refused with `AgentValidationError`.
 */
export function validateAgentConfig(config: Record<string, unknown>): AgentConfig {
  const filled: Record<string, unknown> = { ...AGENT_CONFIG_DEFAULTS, ...config };
  rejectUnknownOrMissingConfigKeys(filled);
  const model = requireModelId(filled.model);
  const coding = requireBooleanField(filled.coding, "coding");
  const browser = requireBooleanField(filled.browser, "browser");
  const browserOptimized = requireBooleanField(filled.browser_optimized, "browser_optimized");
  rejectBrowserOptimizedWithoutBrowser(browserOptimized, browser);
  rejectCodingOnlyModelWithoutCoding(model, coding);
  const harness = requireHarness(filled.harness);
  rejectHarnessWithoutCoding(harness, coding);
  const harnessModel = requireHarnessModel(filled.harness_model, harness);
  return {
    model,
    temperature: requireFiniteNumber(filled.temperature, "temperature"),
    max_tokens: requirePositiveInteger(filled.max_tokens, "max_tokens"),
    max_steps: requirePositiveInteger(filled.max_steps, "max_steps"),
    max_tool_calls: requirePositiveInteger(filled.max_tool_calls, "max_tool_calls"),
    max_input_tokens: requirePositiveInteger(filled.max_input_tokens, "max_input_tokens"),
    keep_tool_result_generations: requirePositiveInteger(
      filled.keep_tool_result_generations,
      "keep_tool_result_generations",
    ),
    max_scripts: requirePositiveInteger(filled.max_scripts, "max_scripts"),
    max_workspace_mib: requirePositiveInteger(filled.max_workspace_mib, "max_workspace_mib"),
    browser,
    browser_language: validateBrowserLanguage(filled.browser_language),
    browser_optimized: browserOptimized,
    browser_model: requireBrowserModel(filled.browser_model, browserOptimized),
    coding,
    harness,
    harness_model: harnessModel,
    harness_effort: requireHarnessEffort(filled.harness_effort, harness, harnessModel),
    secret_aliases: requireSecretAliases(filled.secret_aliases),
    scripting: requireBooleanField(filled.scripting, "scripting"),
    memory: requireBooleanField(filled.memory, "memory"),
    thinking_level: validateThinkingLevel(filled.thinking_level),
  };
}
