/**
 * Shapes of the orchestrator's JSON API for the organisation's models, as the app reads them.
 * Timestamps are ISO-8601 in UTC.
 */

/** A model the organisation offers, with what it takes and costs as the catalog says. */
export type CatalogModel = {
  id: string;
  model: string;
  provider: ModelProvider;
  label: string;
  thinking: boolean;
  temperature: boolean;
  attachments: boolean;
  /** The context window in tokens; null when the catalog does not say. */
  context: number | null;
  /** USD per million tokens; null for an unbilled provider or a row without a price. */
  price: { input: number; output: number; cache_read: number } | null;
  kind: "marketplace" | "coding";
  coding_only: boolean;
};

export type ModelProvider = "openai" | "anthropic" | "openrouter" | "xai" | "deepinfra" | "local" | "kimi";

/**
 * A provider as the organisation sees it: connected or not, whose key it runs on, and the last
 * characters of the organisation's key.
 */
export type OrgModelProvider = {
  id: ModelProvider;
  label: string;
  kind: "marketplace" | "coding";
  connected: boolean;
  /** The organisation's own key, or one the platform provides; null while not connected. */
  source: "own" | "platform" | null;
  key_hint: string | null;
  /** The local endpoint's URL once saved; null for every other provider. */
  base_url: string | null;
};

/** `GET /api/orgs/:id/models`: the default, each provider's state, and the chosen models every picker lists. */
export type OrgModels = {
  default: string | null;
  providers: OrgModelProvider[];
  models: CatalogModel[];
};

/**
 * A provider to connect, or what a connected one offers: its key (kept when left out), the local
 * endpoint's URL, and the chosen models.
 */
export type ModelProviderInput = {
  provider: ModelProvider;
  api_key?: string;
  base_url?: string;
  models?: string[];
};

export function marketplaceModels(models?: OrgModels): CatalogModel[] {
  return (models?.models ?? []).filter((item) => item.kind !== "coding");
}

export function isCodingOnlyModel(modelId: string, models?: OrgModels): boolean {
  const entry = models?.models.find((item) => item.id === modelId);
  if (entry) {
    return entry.coding_only;
  }
  return modelId.startsWith("kimi/");
}

/** Whether any provider is connected; null while the organisation's models are still loading. */
export function hasConnectedProvider(models?: OrgModels): boolean | null {
  if (!models) return null;
  return models.providers.some((item) => item.connected);
}
