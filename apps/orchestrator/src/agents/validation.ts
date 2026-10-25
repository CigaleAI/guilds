import { isCodingOnlyModel, parseModelId } from "../llm/providers.js";
import { HARNESS_MODEL_RE, HARNESSES, harnessOffMessage, isHarness, isHarnessOff, type Harness } from "../coding/harnesses.js";
import { EFFORTS, harnessEffortsFor, isEffort, type Effort } from "../coding/harness-models.js";
import { SECRET_NAME } from "../credentials/validate.js";
import { NAME_RE } from "../lib/names.js";

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
export const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "none";
/** Chrome UI and Accept-Language when the agent has a browser and none is stored. */
export const DEFAULT_BROWSER_LANGUAGE = "en-US";
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
export const FOCUS_MAX = 150;
export const WAKE_TRIGGERS_MAX = 500;
export const AVATAR_SEED_RE = /^[a-z0-9][a-z0-9:-]{0,62}$/;
export const AVATAR_COLOR_RE = /^#[0-9a-f]{6}$/;
export const DEFAULT_AVATAR_SHAPE = "teardrop";
export const DEFAULT_AVATAR_COLOR = "#7c5cff";

export class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentValidationError";
  }
}

export type AgentConfig = {
  model: string;
  temperature: number;
  max_tokens: number;
  max_steps: number;
  max_tool_calls: number;
  max_input_tokens: number;
  keep_tool_result_generations: number;
  max_scripts: number;
  max_workspace_mib: number;
  browser: boolean;
  browser_language: string;
  coding: boolean;
  harness: Harness | null;
  /** The model the harness runs; null leaves it to the harness's subscription. */
  harness_model: string | null;
  /** The effort the harness runs its model at; null leaves it to the harness. */
  harness_effort: Effort | null;
  /**
   * Variable names the agent's commands see beside the secrets reaching it, each holding the
   * value of the secret it names: `{ CLAUDE_CODE_OAUTH_TOKEN: "BOB_TOKEN" }`. An alias wins over
   * a secret of its own name.
   */
  secret_aliases: Record<string, string>;
  scripting: boolean;
  memory: boolean;
  thinking_level: ThinkingLevel;
};

export function validateAgentName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new AgentValidationError("name must match ^[a-z][a-z0-9-]{0,62}$");
  }
  if (name === "user") {
    throw new AgentValidationError("name 'user' is reserved");
  }
  return name;
}

export function validateFocus(focus: string | null | undefined): string {
  const text = (focus ?? "").trim();
  if (text.length > FOCUS_MAX) {
    throw new AgentValidationError(`focus must be at most ${FOCUS_MAX} characters`);
  }
  return text;
}

export function validateWakeTriggers(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (text.length > WAKE_TRIGGERS_MAX) {
    throw new AgentValidationError(`wake_triggers must be at most ${WAKE_TRIGGERS_MAX} characters`);
  }
  return text;
}

export function validateAvatarShape(value: string | null | undefined): string {
  const text = (value ?? "").trim().toLowerCase() || DEFAULT_AVATAR_SHAPE;
  if (!AVATAR_SEED_RE.test(text)) {
    throw new AgentValidationError(
      "avatar_shape must be 1-63 lowercase letters, digits, colons, or hyphens",
    );
  }
  return text;
}

export function validateAvatarColor(value: string | null | undefined): string {
  const text = (value ?? "").trim().toLowerCase() || DEFAULT_AVATAR_COLOR;
  if (!AVATAR_COLOR_RE.test(text)) {
    throw new AgentValidationError("avatar_color must be a 6-digit hex color");
  }
  return text;
}

function fillMissingKeys(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const missing = Object.keys(defaults).filter((key) => !(key in config));
  if (missing.length === 0) {
    return config;
  }
  const updated = { ...config };
  for (const key of missing) {
    updated[key] = defaults[key];
  }
  return updated;
}

export function addMissingBrowser(config: Record<string, unknown>): Record<string, unknown> {
  return fillMissingKeys(config, { browser: false });
}

/**
 * What a payload leaves out: no browser, no coding, no harness, the harness's default model and
 * effort, and no secret aliases.
 */
export function addMissingFlags(config: Record<string, unknown>): Record<string, unknown> {
  return fillMissingKeys(config, {
    browser: false,
    coding: false,
    harness: null,
    harness_model: null,
    harness_effort: null,
    secret_aliases: {},
  });
}

export function addMissingScriptingAndMemory(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return fillMissingKeys(config, {
    scripting: DEFAULT_SCRIPTING,
    memory: DEFAULT_MEMORY,
  });
}

/** Whether script tools and the Scripts tab are on; missing means on. */
export function scriptingOf(config: Record<string, unknown> | null | undefined): boolean {
  return config?.scripting !== false;
}

/** Whether Memory is hydrated and `memory_write` is offered; missing means on. */
export function memoryOf(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return true;
  }
  return (config as Record<string, unknown>).memory !== false;
}

/**
 * A new agent's configuration: its flags settled, and with `coding` on, missing step and
 * tool-call limits take the coding budgets instead of the defaults.
 */
export function withCodingLimits(config: Record<string, unknown>): Record<string, unknown> {
  const settled = addMissingFlags(config);
  if (settled.coding !== true) {
    return settled;
  }
  const updated = { ...settled };
  if (!("max_steps" in updated)) {
    updated.max_steps = CODING_MAX_STEPS;
  }
  if (!("max_tool_calls" in updated)) {
    updated.max_tool_calls = CODING_MAX_TOOL_CALLS;
  }
  return updated;
}

export function addMissingTemperatureAndStepLimits(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return fillMissingKeys(config, {
    temperature: DEFAULT_TEMPERATURE,
    max_tokens: DEFAULT_MAX_TOKENS,
    max_steps: DEFAULT_MAX_STEPS,
  });
}

export function addMissingRunLimits(config: Record<string, unknown>): Record<string, unknown> {
  return fillMissingKeys(config, {
    max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
    max_input_tokens: DEFAULT_MAX_INPUT_TOKENS,
    keep_tool_result_generations: DEFAULT_KEEP_TOOL_RESULT_GENERATIONS,
    max_scripts: DEFAULT_MAX_SCRIPTS,
    max_workspace_mib: DEFAULT_MAX_WORKSPACE_MIB,
  });
}

/** How many user turns keep full tool results; missing or invalid config uses the default. */
export function keepToolResultGenerationsOf(config: Record<string, unknown> | null | undefined): number {
  const value = config?.keep_tool_result_generations;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return DEFAULT_KEEP_TOOL_RESULT_GENERATIONS;
}

/** How many scripts the agent may keep; missing or invalid config uses the default. */
export function maxScriptsOf(config: Record<string, unknown> | null | undefined): number {
  const value = config?.max_scripts;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return DEFAULT_MAX_SCRIPTS;
}

/** The agent's workspace cap in MiB; missing or invalid config uses the default. */
export function maxWorkspaceMibOf(config: Record<string, unknown> | null | undefined): number {
  const value = config?.max_workspace_mib;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return DEFAULT_MAX_WORKSPACE_MIB;
}

export function addMissingThinkingLevel(config: Record<string, unknown>): Record<string, unknown> {
  return fillMissingKeys(config, { thinking_level: DEFAULT_THINKING_LEVEL });
}

export function addMissingBrowserLanguage(config: Record<string, unknown>): Record<string, unknown> {
  return fillMissingKeys(config, { browser_language: DEFAULT_BROWSER_LANGUAGE });
}

/** Chrome language for this config; missing or unknown tags use US English. */
export function browserLanguageOf(config: unknown): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return DEFAULT_BROWSER_LANGUAGE;
  }
  const value = (config as Record<string, unknown>).browser_language;
  if (typeof value === "string" && BROWSER_LANGUAGE_SET.has(value)) {
    return value;
  }
  return DEFAULT_BROWSER_LANGUAGE;
}

export function validateBrowserLanguage(value: unknown): string {
  const text = (typeof value === "string" ? value : "").trim();
  if (BROWSER_LANGUAGE_SET.has(text)) {
    return text;
  }
  throw new AgentValidationError("browser_language must be a supported Chrome language");
}

const NONE_THINKING_ALIASES = new Set(["", "none", "off", "disabled"]);
const ACTIVE_THINKING_LEVELS = new Set<ThinkingLevel>(["low", "medium", "high"]);

export function validateThinkingLevel(value: unknown): ThinkingLevel {
  const text = (typeof value === "string" ? value : "").trim().toLowerCase();
  if (NONE_THINKING_ALIASES.has(text)) {
    return "none";
  }
  if (ACTIVE_THINKING_LEVELS.has(text as ThinkingLevel)) {
    return text as ThinkingLevel;
  }
  throw new AgentValidationError("thinking_level must be one of: none, low, medium, high");
}

function fillMissingAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
  return addMissingFlags(
    addMissingScriptingAndMemory(
      addMissingThinkingLevel(
        addMissingBrowserLanguage(addMissingRunLimits(addMissingTemperatureAndStepLimits(config))),
      ),
    ),
  );
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

/** The agent's secret aliases as stored, or an empty map when the config has none or they do not validate. */
export function secretAliasesOf(config: Record<string, unknown> | null | undefined): Record<string, string> {
  try {
    return requireSecretAliases(config?.secret_aliases ?? {});
  } catch {
    return {};
  }
}

/**
 * A coding agent needs a harness: every create and update is refused without one, and an update
 * cannot switch a coding agent's coding off. A stored coding agent without one still validates;
 * it is not ready, and its coding runs fail at start.
 */
export function assertCodingAgent(config: AgentConfig, previous?: Record<string, unknown>): void {
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
function assertHarnessPickable(harness: Harness, previous?: Record<string, unknown>): void {
  if (isHarnessOff(harness) && previous?.harness !== harness) {
    throw new AgentValidationError(harnessOffMessage(harness));
  }
}

function rejectCodingOnlyModelWithoutCoding(model: string, coding: boolean): void {
  if (isCodingOnlyModel(model) && !coding) {
    throw new AgentValidationError("coding API models are only for coding agents");
  }
}

export function validateConfig(config: Record<string, unknown>): AgentConfig {
  const filled = fillMissingAgentConfig(config);
  rejectUnknownOrMissingConfigKeys(filled);
  const model = requireModelId(filled.model);
  const coding = requireBooleanField(filled.coding, "coding");
  const browser = requireBooleanField(filled.browser, "browser");
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
