import type { AgentConfig, ResolvedAgentConfig, ThinkingLevel } from "../db/schema/index.js";
import { integrationState, SYSTEM_ONE } from "../instance/integrations.js";

export const CONFIG_KEYS = new Set([
  "model",
  "temperature",
  "max_tokens",
  "max_steps",
  "max_tool_calls",
  "max_input_tokens",
  "max_wake_ups",
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
/** The most wake-ups a run may fire, for every agent, coding or not. */
export const DEFAULT_MAX_WAKE_UPS = 10;
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

/** The settings a config payload may leave out, each with the value it then takes: every one but `model`. */
export type AgentConfigDefaults = Omit<AgentConfig, "model">;

/**
 * The value each setting takes when a payload leaves it out: no browser, the step-by-step browser
 * tools, no coding, no harness, the harness's default model and effort, no secret aliases, the
 * guild's tool-result turns, and the default limits. Only `model` has none.
 */
export const AGENT_CONFIG_DEFAULTS: AgentConfigDefaults = {
  temperature: DEFAULT_TEMPERATURE,
  max_tokens: DEFAULT_MAX_TOKENS,
  max_steps: DEFAULT_MAX_STEPS,
  max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
  max_input_tokens: DEFAULT_MAX_INPUT_TOKENS,
  max_wake_ups: DEFAULT_MAX_WAKE_UPS,
  keep_tool_result_generations: null,
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

/** The defaults of a new agent created with `coding` on: the coding budgets for its step and tool-call limits. */
export const CODING_AGENT_CONFIG_DEFAULTS: AgentConfigDefaults = {
  ...AGENT_CONFIG_DEFAULTS,
  max_steps: CODING_MAX_STEPS,
  max_tool_calls: CODING_MAX_TOOL_CALLS,
};

/** The settings the agent's runs take: its config, with its guild's tool-result turns when it sets none. */
export function resolveAgentConfig(
  config: AgentConfig,
  guildKeepToolResultGenerations: number,
): ResolvedAgentConfig {
  return {
    ...config,
    keep_tool_result_generations: config.keep_tool_result_generations ?? guildKeepToolResultGenerations,
  };
}

/**
 * Whether the agent's runs browse with the agent-optimized browser: its config turns it on and the
 * System One key is on. Without the key its runs offer the step-by-step browser tools.
 */
export function isOptimizedBrowserOn(config: Pick<AgentConfig, "browser_optimized">): boolean {
  return config.browser_optimized === true && integrationState(SYSTEM_ONE) === "on";
}
