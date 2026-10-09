export const PROVIDER_KINDS = ["marketplace", "coding"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const MARKETPLACE_PROVIDERS = ["openrouter", "deepinfra"] as const;
export const CODING_PROVIDERS = ["kimi"] as const;
export const PROVIDERS = [...MARKETPLACE_PROVIDERS, ...CODING_PROVIDERS] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_KIND: Record<Provider, ProviderKind> = {
  openrouter: "marketplace",
  deepinfra: "marketplace",
  kimi: "coding",
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: "OpenRouter",
  deepinfra: "DeepInfra",
  kimi: "Kimi Code",
};

export const PROVIDER_BASE_URLS: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  kimi: "https://api.kimi.ai/coding/v1",
};

// Each entry's `thinking`, `temperature`, and `attachments` flags are set by
// hand; the app never asks a provider what a model accepts. Before adding or
// changing an entry, confirm which parameters the model takes on that provider
// (OpenRouter lists them under `supported_parameters` at
// https://openrouter.ai/api/v1/models and `architecture.input_modalities` for
// images; DeepInfra documents `reasoning_effort` at
// https://docs.deepinfra.com/chat/reasoning; Kimi Code documents thinking
// effort at https://www.kimi.com/code/docs/en/) and send it a request that
// varies the parameter. Both marketplace providers accept and silently drop a
// parameter the model does not take, so a 200 proves nothing.
export const MODELS = [
  {
    model: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    providers: ["openrouter"] as const,
    // Verified 2026-09-22: reasoning tokens appear only when an effort is sent.
    thinking: true,
    // Verified 2026-09-22: OpenRouter does not list `temperature` for it and drops it.
    temperature: false,
    // OpenRouter lists `image` in `architecture.input_modalities` (2026-10-03).
    attachments: true,
  },
  {
    model: "openai/gpt-6-luna",
    label: "GPT-6 Luna",
    providers: ["openrouter"] as const,
    // OpenRouter lists `reasoning` and `reasoning_effort` (2026-10-02). It does not list `temperature`.
    thinking: true,
    temperature: false,
    // OpenRouter lists `image` in `architecture.input_modalities` (2026-10-03).
    attachments: true,
  },
  {
    model: "openai/gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    providers: ["openrouter"] as const,
    // OpenRouter lists `reasoning` and `reasoning_effort` (2026-10-02). It does not list `temperature`.
    thinking: true,
    temperature: false,
    // OpenRouter lists `image` in `architecture.input_modalities` (2026-10-03).
    attachments: true,
  },
  {
    model: "openai/gpt-6-luna-pro",
    label: "GPT-6 Luna Pro",
    providers: ["openrouter"] as const,
    // OpenRouter lists `reasoning` and `reasoning_effort` (2026-09-26). It does not list `temperature`.
    thinking: true,
    temperature: false,
    // OpenRouter lists `image` in `architecture.input_modalities` (2026-10-03).
    attachments: true,
  },
  {
    model: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    providers: ["openrouter"] as const,
    // Verified 2026-09-22: reasons by default when no effort is sent; `none` turns it off.
    thinking: true,
    temperature: true,
    // OpenRouter lists `image` in `architecture.input_modalities` (2026-10-03).
    attachments: true,
  },
  {
    model: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    providers: ["openrouter"] as const,
    // OpenRouter lists `reasoning`, `reasoning_effort`, and `temperature` (2026-10-02).
    thinking: true,
    temperature: true,
    // OpenRouter lists `image` in `architecture.input_modalities` (2026-10-03).
    attachments: true,
  },
  {
    model: "qwen/qwen3.8-flash",
    label: "Qwen3.8 Flash",
    providers: ["openrouter"] as const,
    // OpenRouter lists `reasoning` and `temperature` (2026-09-26). It does not list `reasoning_effort`.
    thinking: true,
    temperature: true,
    // OpenRouter lists `image` in `architecture.input_modalities` (2026-10-03).
    attachments: true,
  },
  {
    model: "Qwen/Qwen3.8-2.4T-A95B",
    label: "Qwen3.8",
    providers: ["deepinfra"] as const,
    // Verified 2026-09-22: always reasons; `reasoning_effort`, including `none`, has no effect.
    thinking: false,
    temperature: true,
    // Open-weight Qwen3.8-2.4T is text-only; hosted Max adds vision (2026-10-03).
    attachments: false,
  },
  {
    model: "zai-org/GLM-5.3",
    label: "GLM-5.3",
    providers: ["deepinfra"] as const,
    // Verified 2026-09-22: reasons by default when no effort is sent; `none` turns it off.
    thinking: true,
    temperature: true,
    // DeepInfra documents image_url parts for GLM-5 (2026-10-03).
    attachments: true,
  },
  {
    model: "zai-org/GLM-5.3-Flash",
    label: "GLM-5.3-Flash",
    providers: ["deepinfra"] as const,
    // Reasons by default at effort `max`; listed efforts are `low`, `high`, `max`.
    thinking: true,
    temperature: true,
    // DeepInfra documents image_url parts for GLM-5 (2026-10-03).
    attachments: true,
  },
  {
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    label: "DeepSeek-V4.1-Flash",
    providers: ["deepinfra"] as const,
    // Verified 2026-09-22: does not reason unless an effort is sent.
    thinking: true,
    temperature: true,
    // DeepInfra marks this id Multimodal and documents interleaved image content (2026-10-03).
    attachments: true,
  },
  {
    model: "k3",
    label: "Kimi K3",
    providers: ["kimi"] as const,
    // Kimi Code documents `low` / `high` / `max` thinking effort (2026-10-02).
    thinking: true,
    // OpenAI-compatible Chat Completions; not request-verified on the coding endpoint.
    temperature: true,
    // Kimi vision docs list image_url for K3; public URLs are refused (2026-10-03).
    attachments: true,
  },
  {
    model: "k3-256k",
    label: "Kimi K3 256K",
    providers: ["kimi"] as const,
    // Kimi Code documents `low` / `high` / `max` thinking effort (2026-10-02).
    thinking: true,
    temperature: true,
    // Same K3 vision path as `k3`; k3-256k does not take video (2026-10-03).
    attachments: true,
  },
  {
    model: "kimi-for-coding",
    label: "Kimi K2.8 Preview",
    providers: ["kimi"] as const,
    // Kimi Code documents `low` / `high` / `max` reasoning effort (2026-10-02).
    thinking: true,
    temperature: true,
    // Kimi vision docs list image_url for kimi-k2.7-code-class ids (2026-10-03).
    attachments: true,
  },
  {
    model: "kimi-for-coding-highspeed",
    label: "Kimi K2.7 Code HighSpeed",
    providers: ["kimi"] as const,
    // Kimi Code does not document thinking effort for HighSpeed (2026-10-02).
    thinking: false,
    temperature: true,
    // Kimi vision docs list image_url for kimi-k2.7-code-highspeed (2026-10-03).
    attachments: true,
  },
] as const;

export const DEFAULT_MODEL = "deepinfra/zai-org/GLM-5.3-Flash";

export function catalogModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function providerNameForModel(model: string): Provider | null {
  for (const provider of PROVIDERS) {
    if (model.startsWith(`${provider}/`)) {
      return provider;
    }
  }
  return null;
}

export function providerKindOf(provider: string): ProviderKind | null {
  if (!isProvider(provider)) {
    return null;
  }
  return PROVIDER_KIND[provider];
}

export function providerRequiresOrgKey(provider: string): boolean {
  return providerKindOf(provider) === "coding";
}

export function missingOrgKeyMessage(provider: string): string {
  const label = isProvider(provider) ? PROVIDER_LABELS[provider] : provider;
  return `a ${label} key is not connected`;
}

export type CatalogEntry = {
  id: string;
  model: string;
  provider: string;
  label: string;
  thinking: boolean;
  temperature: boolean;
  attachments: boolean;
  kind: ProviderKind;
  coding_only: boolean;
  requires_org_key: boolean;
};

function entries(): CatalogEntry[] {
  const items: CatalogEntry[] = [];
  const seen = new Set<string>();
  if ((MODELS as readonly unknown[]).length === 0) {
    throw new Error("MODELS must not be empty");
  }
  for (const entry of MODELS) {
    const model = entry.model.trim();
    const label = entry.label.trim();
    const thinking = entry.thinking;
    const temperature = entry.temperature;
    const attachments = entry.attachments;
    for (const provider of entry.providers) {
      if (!isProvider(provider)) {
        throw new Error(`unknown provider ${provider} for ${model}`);
      }
      const id = catalogModelId(provider, model);
      if (seen.has(id)) {
        throw new Error(`duplicate catalog id: ${id}`);
      }
      seen.add(id);
      const kind = PROVIDER_KIND[provider];
      const codingOnly = kind === "coding";
      items.push({
        id,
        model,
        provider,
        label,
        thinking,
        temperature,
        attachments,
        kind,
        coding_only: codingOnly,
        requires_org_key: codingOnly,
      });
    }
  }
  return items;
}

export const CATALOG = entries();
export const CATALOG_IDS = new Set(CATALOG.map((item) => item.id));
export const MARKETPLACE_CATALOG_IDS = new Set(
  CATALOG.filter((item) => item.kind === "marketplace").map((item) => item.id),
);

if (!CATALOG_IDS.has(DEFAULT_MODEL)) {
  throw new Error(`DEFAULT_MODEL is not in the catalog: ${DEFAULT_MODEL}`);
}
if (!MARKETPLACE_CATALOG_IDS.has(DEFAULT_MODEL)) {
  throw new Error(`DEFAULT_MODEL must be a marketplace model: ${DEFAULT_MODEL}`);
}

export function catalogById(id: string): CatalogEntry | undefined {
  return CATALOG.find((item) => item.id === id);
}

export function isCodingOnlyModel(id: string): boolean {
  return catalogById(id)?.coding_only === true;
}

export function isMarketplaceModel(id: string): boolean {
  return MARKETPLACE_CATALOG_IDS.has(id);
}

export function modelAcceptsAttachments(id: string): boolean {
  return catalogById(id)?.attachments === true;
}

/** Kimi refuses public image URLs; hydrate those parts as data URLs. */
export function modelNeedsInlineImages(id: string): boolean {
  return providerNameForModel(id) === "kimi";
}

export function catalogPayload(): {
  default: string;
  providers: Array<{ id: string; label: string; kind: ProviderKind }>;
  models: CatalogEntry[];
} {
  return {
    default: DEFAULT_MODEL,
    providers: PROVIDERS.map((provider) => ({
      id: provider,
      label: PROVIDER_LABELS[provider],
      kind: PROVIDER_KIND[provider],
    })),
    models: CATALOG.map((item) => ({ ...item })),
  };
}
