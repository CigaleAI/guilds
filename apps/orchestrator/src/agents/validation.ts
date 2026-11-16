import { normalizeAvatarColor, normalizeAvatarShape } from "../avatars/index.js";
import { harnessEffortsFor, isEffort } from "../coding/harness-models.js";
import {
  HARNESS_MODEL_RE,
  harnessNeedsRepository,
  harnessOffMessage,
  isHarness,
  isHarnessOff,
  subscriptionRepositoryMessage,
} from "../coding/harnesses.js";
import { REPOSITORY_NAME_RE } from "../coding/repositories.js";
import { SECRET_NAME } from "../credentials/validate.js";
import {
  EFFORTS,
  HARNESSES,
  modelSourceOf,
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
  CONFIG_KEYS,
  MODEL_LOOP_SETTINGS,
  SECRET_ALIASES_MAX,
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

/**
 * A stored model id: `{provider}/{model}` with a provider core speaks to, or null for a
 * subscription agent; the catalog is not consulted.
 */
function requireModelId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentValidationError("model must be a non-empty string, or null for a subscription agent");
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
 * `{provider}/{model}` id of a provider core speaks to that is not a coding plan's; with it
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

/**
 * An agent has one model source: a model on a key, or, without a model, a subscription on its
 * harness. An agent with a harness is a subscription agent.
 */
function rejectUnsoundModelSource(model: string | null, harness: Harness | null): void {
  if (model !== null && harness !== null) {
    throw new AgentValidationError("harness is for a subscription agent, which has no model");
  }
  if (model === null && harness === null) {
    throw new AgentValidationError("an agent without a model is a subscription agent: it needs a harness");
  }
}

/** Refuses a model-loop setting a subscription agent's config gives a value other than its default. */
function rejectModelLoopSettings(config: AgentConfig): void {
  if (modelSourceOf(config).kind === "key") {
    return;
  }
  const set = MODEL_LOOP_SETTINGS.filter((key) => config[key] !== AGENT_CONFIG_DEFAULTS[key]);
  if (set.length > 0) {
    throw new AgentValidationError(
      `a subscription agent takes no ${set.join(", ")}: they set the model loop, which its harness replaces`,
    );
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

/** The repositories an agent works on: a list of repository names, each once. */
function requireRepositories(value: unknown): AgentConfig["repositories"] {
  if (!Array.isArray(value)) {
    throw new AgentValidationError("repositories must be a list of repository names");
  }
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !REPOSITORY_NAME_RE.test(name)) {
      throw new AgentValidationError(`repositories: ${String(name)} is not a repository name`);
    }
    if (names.includes(name)) {
      throw new AgentValidationError(`repositories: ${name} is listed twice`);
    }
    names.push(name);
  }
  return names;
}

/** Only a subscription agent, which has no model, works on repositories: a list on an agent on a key is refused. */
function rejectRepositoriesOnKey(repositories: AgentConfig["repositories"], model: string | null): void {
  if (repositories.length && model !== null) {
    throw new AgentValidationError("repositories are only for subscription agents");
  }
}

/** Whether a value is repositories an agent's config takes, as `validateAgentConfig` checks them. */
export function isValidRepositoryList(value: unknown): value is AgentConfig["repositories"] {
  try {
    requireRepositories(value);
    return true;
  } catch (error) {
    if (error instanceof AgentValidationError) {
      return false;
    }
    throw error;
  }
}

/**
 * Refuses a config whose repositories name one outside `usable`, the repositories the agent can
 * use, naming each. One the agent's `previous` config already lists stays when the agent can no
 * longer use it; its turns fail at start until it is unpicked.
 */
export function assertUsableRepositories(
  config: AgentConfig,
  usable: readonly string[],
  previous?: AgentConfig,
): void {
  const kept = new Set(previous?.repositories ?? []);
  const outside = config.repositories.filter((name) => !usable.includes(name) && !kept.has(name));
  if (outside.length) {
    throw new AgentValidationError(
      `repositories: the agent cannot use ${outside.join(", ")}: add it to the guild's Repositories first`,
    );
  }
}

/** A harness the box turns off cannot be picked; an agent already on it keeps it until it picks another. */
function assertHarnessPickable(harness: Harness, previous?: AgentConfig): void {
  if (isHarnessOff(harness) && previous?.harness !== harness) {
    throw new AgentValidationError(harnessOffMessage(harness));
  }
}

/**
 * A subscription agent needs a harness the box does not turn off: every create, and every switch
 * to that harness, is refused on one it does. An agent already on the harness keeps it. On a
 * harness that needs a repository, every create and update is refused without one. A stored
 * agent whose repositories are all gone still validates; its runs fail at start until it picks one.
 */
export function assertSubscriptionAgent(config: AgentConfig, previous?: AgentConfig): void {
  if (modelSourceOf(config).kind === "key" || config.harness === null) {
    return;
  }
  assertHarnessPickable(config.harness, previous);
  if (harnessNeedsRepository(config.harness) && !config.repositories.length) {
    throw new AgentValidationError(subscriptionRepositoryMessage(config.harness));
  }
}

function rejectCodingOnlyModel(model: string | null): void {
  if (model !== null && isCodingOnlyModel(model)) {
    throw new AgentValidationError("a coding plan's models run no agent");
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
 * An agent's config from a payload's settings: every key the payload leaves out takes its
 * default, then each value is checked. A payload without a model key, with a key that is
 * not a setting, with a value a setting does not take, or with a model source that does not hold
 * is refused with `AgentValidationError`.
 */
function agentConfigFrom(settings: JsonObject): AgentConfig {
  const filled: JsonObject = { ...AGENT_CONFIG_DEFAULTS, ...settings };
  rejectUnknownOrMissingConfigKeys(filled);
  const model = requireModelId(filled.model);
  const browser = requireBooleanField(filled.browser, "browser");
  const browserOptimized = requireBooleanField(filled.browser_optimized, "browser_optimized");
  rejectBrowserOptimizedWithoutBrowser(browserOptimized, browser);
  rejectCodingOnlyModel(model);
  const harness = requireHarness(filled.harness);
  rejectUnsoundModelSource(model, harness);
  const harnessModel = requireHarnessModel(filled.harness_model, harness);
  const repositories = requireRepositories(filled.repositories);
  rejectRepositoriesOnKey(repositories, model);
  const config: AgentConfig = {
    model,
    temperature: requireFiniteNumber(filled.temperature, "temperature"),
    max_tokens: requirePositiveInteger(filled.max_tokens, "max_tokens"),
    max_steps: requirePositiveInteger(filled.max_steps, "max_steps"),
    max_tool_calls: requirePositiveInteger(filled.max_tool_calls, "max_tool_calls"),
    max_input_tokens: requirePositiveInteger(filled.max_input_tokens, "max_input_tokens"),
    max_wake_ups: requirePositiveInteger(filled.max_wake_ups, "max_wake_ups"),
    max_turn_minutes: requirePositiveInteger(filled.max_turn_minutes, "max_turn_minutes"),
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
    harness,
    harness_model: harnessModel,
    harness_effort: requireHarnessEffort(filled.harness_effort, harness, harnessModel),
    repositories,
    secret_aliases: requireSecretAliases(filled.secret_aliases),
    scripting: requireBooleanField(filled.scripting, "scripting"),
    memory: requireBooleanField(filled.memory, "memory"),
    thinking_level: validateThinkingLevel(filled.thinking_level),
  };
  rejectModelLoopSettings(config);
  return config;
}

/**
 * An agent's config from a payload (a request's, a recipe role's, or the one an agent stores):
 * every setting it leaves out takes its default, then each value is checked. An absent payload is
 * empty; a payload that is not an object, has no model, has a key that is not a setting, or has a
 * value a setting does not take is refused with `AgentValidationError`.
 */
export function validateAgentConfig(payload: unknown): AgentConfig {
  return agentConfigFrom(configPayload(payload));
}
