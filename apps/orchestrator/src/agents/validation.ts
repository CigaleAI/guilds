import { normalizeAvatarColor, normalizeAvatarShape } from "../avatars/index.js";
import { harnessEffortsFor, isEffort } from "../coding/harness-models.js";
import { HARNESS_MODEL_RE, harnessOffMessage, isHarness, isHarnessOff } from "../coding/harnesses.js";
import { SECRET_NAME } from "../credentials/validate.js";
import {
  EFFORTS,
  HARNESSES,
  type AgentConfig,
  type Effort,
  type Harness,
  type ThinkingLevel,
} from "../db/schema/index.js";
import { isJsonObject, type JsonObject } from "../lib/json.js";
import { NAME_RE } from "../lib/names.js";
import { isCodingOnlyModel, parseModelId } from "../llm/providers.js";
import {
  AGENT_CONFIG_DEFAULTS,
  BROWSER_LANGUAGES,
  CODING_AGENT_CONFIG_DEFAULTS,
  CONFIG_KEYS,
  SECRET_ALIASES_MAX,
  type AgentConfigDefaults,
} from "./config.js";

export const FOCUS_MAX = 150;
export const WAKE_TRIGGERS_MAX = 500;

export class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentValidationError";
  }
}

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
  const shape = normalizeAvatarShape(value);
  if (shape === null) {
    throw new AgentValidationError(
      "avatar_shape must be 1-63 lowercase letters, digits, colons, or hyphens",
    );
  }
  return shape;
}

export function validateAvatarColor(value: string | null | undefined): string {
  const color = normalizeAvatarColor(value);
  if (color === null) {
    throw new AgentValidationError("avatar_color must be a 6-digit hex color");
  }
  return color;
}

const BROWSER_LANGUAGE_SET = new Set<string>(BROWSER_LANGUAGES);

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

function rejectUnknownOrMissingConfigKeys(filled: JsonObject): void {
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
function requireSecretAliases(value: unknown): AgentConfig["secret_aliases"] {
  if (!isJsonObject(value)) {
    throw new AgentValidationError("secret_aliases must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > SECRET_ALIASES_MAX) {
    throw new AgentValidationError(`secret_aliases holds at most ${SECRET_ALIASES_MAX} entries`);
  }
  return Object.fromEntries(entries.map(([alias, source]) => [alias, requireAliasEntry(alias, source)]));
}

/** Whether a value is secret aliases an agent's config takes, as `validateAgentConfig` checks them. */
export function isValidSecretAliases(value: unknown): value is AgentConfig["secret_aliases"] {
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

/** A request's or a recipe's config payload as an object; an absent one is empty, anything else is refused. */
function configPayload(payload: unknown): JsonObject {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (!isJsonObject(payload)) {
    throw new AgentValidationError("config must be an object");
  }
  return payload;
}

/**
 * An agent's config from a payload's settings: every key the payload leaves out takes its value
 * in `defaults`, then each value is checked. A payload without a model, with a key that is not a
 * setting, or with a value a setting does not take is refused with `AgentValidationError`.
 */
function agentConfigFrom(settings: JsonObject, defaults: AgentConfigDefaults): AgentConfig {
  const filled: JsonObject = { ...defaults, ...settings };
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
    max_wake_ups: requirePositiveInteger(filled.max_wake_ups, "max_wake_ups"),
    keep_tool_result_generations:
      filled.keep_tool_result_generations === null
        ? null
        : requirePositiveInteger(filled.keep_tool_result_generations, "keep_tool_result_generations"),
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

/**
 * An agent's config from a payload (a request's, a recipe role's, or the one an agent stores):
 * every setting it leaves out takes its default, then each value is checked. An absent payload is
 * empty; a payload that is not an object, has no model, has a key that is not a setting, or has a
 * value a setting does not take is refused with `AgentValidationError`.
 */
export function validateAgentConfig(payload: unknown): AgentConfig {
  return agentConfigFrom(configPayload(payload), AGENT_CONFIG_DEFAULTS);
}

/**
 * A new agent's config from its payload, as `validateAgentConfig` reads it, except that with
 * `coding` on, the step and tool-call limits it leaves out take the coding budgets.
 */
export function validateNewAgentConfig(payload: unknown): AgentConfig {
  const settings = configPayload(payload);
  const defaults = settings.coding === true ? CODING_AGENT_CONFIG_DEFAULTS : AGENT_CONFIG_DEFAULTS;
  return agentConfigFrom(settings, defaults);
}
