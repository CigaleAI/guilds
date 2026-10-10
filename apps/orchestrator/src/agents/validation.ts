import { isCodingOnlyModel, parseModelId } from "../llm/providers.js";

export const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
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
  "cli",
  "browser",
  "browser_language",
  "coding",
  "scripting",
  "memory",
  "thinking_level",
  "box",
  "cpu",
  "memory_mib",
]);
/** Keys a config may leave out: a custom box's size, absent on every other box. */
export const OPTIONAL_CONFIG_KEYS = new Set(["cpu", "memory_mib"]);
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
/** A new agent can open a terminal on its machine unless the operator turns this off. */
export const DEFAULT_CLI = true;
/** A new agent keeps script tools unless the operator turns this off. */
export const DEFAULT_SCRIPTING = true;
/** A new agent keeps Memory and `memory_write` unless the operator turns this off. */
export const DEFAULT_MEMORY = true;
/** The step and tool-call budgets an agent created with `coding` on starts with. */
export const CODING_MAX_STEPS = 200;
export const CODING_MAX_TOOL_CALLS = 200;
export const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "none";
/** Chrome UI and Accept-Language when the agent has a browser and none is stored. */
export const DEFAULT_BROWSER_LANGUAGE = "en-US";
/**
 * The boxes an agent runs on. `lite` is the small guest for scripts, notes, MCP, and the CLI,
 * with `browser` and `coding` off. The others run the standard image, with Chromium and the
 * toolchains: `standard` is the browser agent's machine, with `coding` off; `code` is the coding
 * agent's, larger, with `coding` on; `custom` is sized by the operator (`cpu`, `memory_mib`),
 * with `coding` their choice. On every box but lite, `browser` is the operator's choice, on by
 * default.
 */
export const BOXES = ["lite", "standard", "code", "custom"] as const;
export type Box = (typeof BOXES)[number];
export const DEFAULT_BOX: Box = "lite";
/** A custom box's size: CPUs in quarter steps and memory in MiB, each within these bounds. */
export const CUSTOM_MIN_CPU = 0.5;
export const CUSTOM_MAX_CPU = 4;
export const CUSTOM_CPU_STEP = 0.25;
export const CUSTOM_MIN_MEMORY_MIB = 512;
export const CUSTOM_MAX_MEMORY_MIB = 8192;
export type CustomSize = { cpu: number; memory_mib: number };
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
  cli: boolean;
  browser: boolean;
  browser_language: string;
  coding: boolean;
  scripting: boolean;
  memory: boolean;
  thinking_level: ThinkingLevel;
  box: Box;
  /** A custom box's size; absent on every other box. */
  cpu?: number;
  memory_mib?: number;
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

/** The box the flags call for: `code` with coding on, `standard` with the browser alone, `lite` with neither. */
export function boxForFlags(flags: { browser?: unknown; coding?: unknown }): Box {
  if (flags.coding === true) {
    return "code";
  }
  return flags.browser === true ? "standard" : "lite";
}

function isBox(value: unknown): value is Box {
  return typeof value === "string" && (BOXES as readonly string[]).includes(value);
}

/** The agent's box; a missing or unknown key follows the flags. */
export function boxOf(config: unknown): Box {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return DEFAULT_BOX;
  }
  const record = config as Record<string, unknown>;
  return isBox(record.box) ? record.box : boxForFlags(record);
}

export function addMissingBox(config: Record<string, unknown>): Record<string, unknown> {
  return fillMissingKeys(config, { box: boxForFlags(config) });
}

/** The flags a box settles, and the default for the ones it leaves to the operator. */
function flagsForBox(box: Box): { browser: boolean; coding: boolean } {
  switch (box) {
    case "lite":
      return { browser: false, coding: false };
    case "standard":
      return { browser: true, coding: false };
    case "code":
      return { browser: true, coding: true };
    case "custom":
      return { browser: true, coding: false };
  }
}

/**
 * The flags a payload leaves out follow its box: lite turns both off; standard turns the browser
 * on and coding off; code turns both on; custom turns the browser on and coding off. With no box
 * either, the box follows the flags the payload does name, and lite with none. A box the flags
 * then disagree with is refused by `validateBox`.
 */
export function addMissingBoxAndFlags(config: Record<string, unknown>): Record<string, unknown> {
  const withBox = addMissingBox(config);
  return fillMissingKeys(withBox, flagsForBox(boxOf(withBox)));
}

/** A box, which must agree with the flags: lite has both off, standard has coding off, code has it on. */
export function validateBox(value: unknown, flags: { browser: boolean; coding: boolean }): Box {
  if (!isBox(value)) {
    throw new AgentValidationError("box must be lite, standard, code, or custom");
  }
  if (value === "lite" && (flags.browser || flags.coding)) {
    throw new AgentValidationError("a lite box has browser and coding off");
  }
  if (value === "standard" && flags.coding) {
    throw new AgentValidationError("a standard box has coding off");
  }
  if (value === "code" && !flags.coding) {
    throw new AgentValidationError("a code box has coding on");
  }
  return value;
}

/**
 * A custom box's size, which it must have within the bounds; any other box has none. Returns
 * `null` for a box without a size.
 */
export function validateCustomSize(box: Box, cpu: unknown, memoryMib: unknown): CustomSize | null {
  if (box !== "custom") {
    if (cpu !== undefined || memoryMib !== undefined) {
      throw new AgentValidationError("cpu and memory_mib are only for a custom box");
    }
    return null;
  }
  if (
    typeof cpu !== "number" ||
    !Number.isFinite(cpu) ||
    cpu < CUSTOM_MIN_CPU ||
    cpu > CUSTOM_MAX_CPU ||
    !Number.isInteger(cpu / CUSTOM_CPU_STEP)
  ) {
    throw new AgentValidationError(
      `cpu must be between ${CUSTOM_MIN_CPU} and ${CUSTOM_MAX_CPU} in steps of ${CUSTOM_CPU_STEP}`,
    );
  }
  if (
    typeof memoryMib !== "number" ||
    !Number.isInteger(memoryMib) ||
    memoryMib < CUSTOM_MIN_MEMORY_MIB ||
    memoryMib > CUSTOM_MAX_MEMORY_MIB
  ) {
    throw new AgentValidationError(
      `memory_mib must be an integer between ${CUSTOM_MIN_MEMORY_MIB} and ${CUSTOM_MAX_MEMORY_MIB}`,
    );
  }
  return { cpu, memory_mib: memoryMib };
}

/** A custom box's stored size; `null` on another box or when the size is missing or malformed. */
export function customSizeOf(config: unknown): CustomSize | null {
  if (!config || typeof config !== "object" || Array.isArray(config) || boxOf(config) !== "custom") {
    return null;
  }
  const record = config as Record<string, unknown>;
  try {
    return validateCustomSize("custom", record.cpu, record.memory_mib);
  } catch {
    return null;
  }
}

export function addMissingCliScriptingAndMemory(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return fillMissingKeys(config, {
    cli: DEFAULT_CLI,
    scripting: DEFAULT_SCRIPTING,
    memory: DEFAULT_MEMORY,
  });
}

/** Whether the operator CLI tab and API are on; missing means on. */
export function cliOf(config: Record<string, unknown> | null | undefined): boolean {
  return config?.cli !== false;
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
 * A new agent's configuration: its box and flags settled, and with `coding` on, missing step and
 * tool-call limits take the coding budgets instead of the defaults.
 */
export function withCodingLimits(config: Record<string, unknown>): Record<string, unknown> {
  const settled = addMissingBoxAndFlags(config);
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
  return addMissingBoxAndFlags(
    addMissingCliScriptingAndMemory(
      addMissingThinkingLevel(
        addMissingBrowserLanguage(addMissingRunLimits(addMissingTemperatureAndStepLimits(config))),
      ),
    ),
  );
}

function rejectUnknownOrMissingConfigKeys(filled: Record<string, unknown>): void {
  const extra = [...Object.keys(filled)].filter((key) => !CONFIG_KEYS.has(key)).sort();
  const missing = [...CONFIG_KEYS].filter((key) => !OPTIONAL_CONFIG_KEYS.has(key) && !(key in filled)).sort();
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
  const box = validateBox(filled.box, { browser, coding });
  const size = validateCustomSize(box, filled.cpu, filled.memory_mib);
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
    cli: requireBooleanField(filled.cli, "cli"),
    browser,
    browser_language: validateBrowserLanguage(filled.browser_language),
    coding,
    scripting: requireBooleanField(filled.scripting, "scripting"),
    memory: requireBooleanField(filled.memory, "memory"),
    thinking_level: validateThinkingLevel(filled.thinking_level),
    box,
    ...(size ?? {}),
  };
}
