// The model providers core speaks to. One row is the whole definition of a provider: its id is
// the prefix of every stored model id (`{provider}/{model}`), and the row says whether a cost is
// computed for its calls, which API it speaks and where, and which models.dev provider lists its
// catalog.

export const PROVIDER_IDS = ["openai", "anthropic", "openrouter", "xai", "deepinfra", "local"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The wire API of a provider: OpenAI Chat Completions, or Anthropic's Messages API. */
export const PROVIDER_APIS = ["chat-completions", "messages"] as const;
export type ProviderApi = (typeof PROVIDER_APIS)[number];

export type ProviderDef = {
  id: ProviderId;
  label: string;
  /** Whether a cost is computed for a call; an unbilled provider's calls record `cost_source: unavailable`. */
  billed: boolean;
  api: ProviderApi;
  /** The API base URL; null for `local`, whose URL the organisation saves. */
  baseURL: string | null;
  /** The models.dev provider the catalog is read from; null for `local`, which lists its endpoint. */
  modelsDev: string | null;
};

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    billed: true,
    api: "chat-completions",
    baseURL: "https://api.openai.com/v1",
    modelsDev: "openai",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    billed: true,
    api: "messages",
    baseURL: "https://api.anthropic.com",
    modelsDev: "anthropic",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    billed: true,
    api: "chat-completions",
    baseURL: "https://openrouter.ai/api/v1",
    modelsDev: "openrouter",
  },
  {
    id: "xai",
    label: "xAI",
    billed: true,
    api: "chat-completions",
    baseURL: "https://api.x.ai/v1",
    modelsDev: "xai",
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    billed: true,
    api: "chat-completions",
    baseURL: "https://api.deepinfra.com/v1/openai",
    modelsDev: "deepinfra",
  },
  {
    id: "local",
    label: "Local endpoint",
    billed: false,
    api: "chat-completions",
    baseURL: null,
    modelsDev: null,
  },
];

const BY_ID = new Map<string, ProviderDef>(PROVIDERS.map((provider) => [provider.id, provider]));

export function isProvider(value: string): value is ProviderId {
  return BY_ID.has(value);
}

export function providerById(id: string): ProviderDef | null {
  return BY_ID.get(id) ?? null;
}

export function providerLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export function catalogModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** A stored model id split at its provider prefix: the provider, and the id the provider knows the model by. */
export type ProviderModel = { provider: ProviderDef; model: string };

/** A stored model id split at its provider prefix; null unless the prefix is a provider and a model follows. */
export function parseModelId(model: string): ProviderModel | null {
  const slash = model.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const provider = BY_ID.get(model.slice(0, slash));
  const rest = model.slice(slash + 1);
  if (!provider || !rest.trim()) {
    return null;
  }
  return { provider, model: rest };
}

export function providerOf(model: string): ProviderDef | null {
  return parseModelId(model)?.provider ?? null;
}

