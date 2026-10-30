import type { ModelCredentials } from "../llm/credentials.js";
import { parseModelId, type ProviderId } from "../llm/providers.js";

/** A browser model fastbrowse has no route to: an id without a provider, or a coding-only provider. */
export class BrowseModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowseModelError";
  }
}

const LLM_PURPOSES = ["PLAN", "READ", "FIELD_TEXT", "SHORTCUT", "RECOVER", "COMPOSE", "VERIFY"] as const;

/**
 * Every variable fastbrowse reads a key, an endpoint, a model, a Jev source, or a browser choice
 * from, at the value it holds unless a run's route sets it. `Fastbrowse.start` adds a run's
 * environment to the orchestrator's own instead of replacing it, so each one is pinned: none of
 * the orchestrator's keys, endpoints, or settings reaches a run. A blank value reads as unset.
 * Jev's source is `typesafe`, the System One key's API, and Chrome is never headed, since the
 * run attaches to the agent's Chrome. The variables with no value that reads as unset are not
 * here, and none carries a key or an endpoint: `FASTBROWSE_PROFILE`, which fastbrowse refuses
 * beside an attached Chrome, and `FASTBROWSE_LLM_STRICT` and `FASTBROWSE_LLM_REASONING*`.
 */
export const FASTBROWSE_PINNED_ENV: Readonly<Record<string, string>> = {
  TYPESAFE_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  XAI_API_KEY: "",
  GEMINI_API_KEY: "",
  GROQ_API_KEY: "",
  TOGETHER_API_KEY: "",
  DEEPSEEK_API_KEY: "",
  MISTRAL_API_KEY: "",
  FIREWORKS_API_KEY: "",
  AZURE_OPENAI_API_KEY: "",
  AI_GATEWAY_API_KEY: "",
  BROWSER_USE_API_KEY: "",
  TELNYX_API_KEY: "",
  AIMLAPI_API_KEY: "",
  PERPLEXITY_API_KEY: "",
  FASTBROWSE_LLM_PROVIDER: "",
  FASTBROWSE_LLM_MODEL: "",
  ...Object.fromEntries(LLM_PURPOSES.map((purpose) => [`FASTBROWSE_LLM_MODEL_${purpose}`, ""])),
  FASTBROWSE_LLM_BASE_URL: "",
  FASTBROWSE_LLM_API_KEY: "",
  FASTBROWSE_LLM_EXTRA_BODY: "",
  FASTBROWSE_DECISION_SOURCE: "typesafe",
  FASTBROWSE_JEV_SOURCE: "typesafe",
  FASTBROWSE_DECISION_BASE_URL: "",
  FASTBROWSE_JEV_BASE_URL: "",
  FASTBROWSE_DECISION_MODEL: "",
  FASTBROWSE_JEV_MODEL: "",
  FASTBROWSE_DECISION_API_KEY: "",
  FASTBROWSE_MCP_TOKEN: "",
  FASTBROWSE_CHROME: "",
  FASTBROWSE_HEADED: "false",
  FASTBROWSE_BINARY: "",
};

/** The providers fastbrowse calls by name: its provider value and the variable it reads the key from. */
const NAMED_ROUTES: Partial<Record<ProviderId, [string, string]>> = {
  openrouter: ["openrouter", "OPENROUTER_API_KEY"],
  openai: ["openai", "OPENAI_API_KEY"],
  anthropic: ["anthropic", "ANTHROPIC_API_KEY"],
  xai: ["xai", "XAI_API_KEY"],
};

/**
 * The whole environment fastbrowse runs with: `FASTBROWSE_PINNED_ENV`, with the System One key
 * as its Jev key and the browser model on the credentials it resolved to. A provider fastbrowse
 * calls by name gets its own key variable while the credentials keep the provider's own address;
 * any other OpenAI-compatible endpoint, or a provider reached at another address, is fastbrowse's
 * `custom` provider at that address. The model is the id without its provider prefix.
 */
export function fastbrowseEnv(jevKey: string, model: string, credentials: ModelCredentials): Record<string, string> {
  const parsed = parseModelId(model);
  if (parsed === null) {
    throw new BrowseModelError("browser_model must be {provider}/{model}");
  }
  const { provider } = parsed;
  if (provider.kind === "coding") {
    throw new BrowseModelError(`${provider.label} models cannot run the agent-optimized browser`);
  }
  const env: Record<string, string> = {
    ...FASTBROWSE_PINNED_ENV,
    TYPESAFE_API_KEY: jevKey,
    FASTBROWSE_LLM_MODEL: parsed.model,
  };
  const baseURL = credentials.baseURL || provider.baseURL;
  const named = NAMED_ROUTES[provider.id];
  if (named !== undefined && baseURL === provider.baseURL) {
    const [route, keyVariable] = named;
    return { ...env, FASTBROWSE_LLM_PROVIDER: route, [keyVariable]: credentials.apiKey };
  }
  if (!baseURL) {
    throw new BrowseModelError(`${provider.label} has no endpoint address under Model keys`);
  }
  return {
    ...env,
    FASTBROWSE_LLM_PROVIDER: "custom",
    FASTBROWSE_LLM_BASE_URL: baseURL,
    FASTBROWSE_LLM_API_KEY: credentials.apiKey,
  };
}
