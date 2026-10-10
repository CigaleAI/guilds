import { catalogModelId, type ProviderDef, type ProviderId, type ProviderKind } from "./providers.js";

/** USD per token. */
export type CatalogRates = {
  input: number;
  output: number;
  cacheRead: number;
};

/** A model as the catalog describes it: what it accepts, how large its window is, and what it costs. */
export type CatalogEntry = {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
  thinking: boolean;
  temperature: boolean;
  attachments: boolean;
  /** The context window in tokens; null when the catalog does not say. */
  context: number | null;
  /** Null for an unbilled provider, or a row without a price. */
  rates: CatalogRates | null;
  kind: ProviderKind;
  coding_only: boolean;
  /** Whether the catalog lists it; a well-formed id it does not list takes the default capacities. */
  listed: boolean;
};

/** What a model takes when the catalog does not say: thinking on, temperature on, attachments off. */
export const DEFAULT_CAPACITIES = { thinking: true, temperature: true, attachments: false } as const;

export function defaultEntry(provider: ProviderDef, model: string): CatalogEntry {
  return {
    id: catalogModelId(provider.id, model),
    provider: provider.id,
    model,
    label: model,
    ...DEFAULT_CAPACITIES,
    context: null,
    rates: null,
    kind: provider.kind,
    coding_only: provider.kind === "coding",
    listed: false,
  };
}

/** An entry as the API lists it: prices in USD per million tokens. */
export function entryPayload(entry: CatalogEntry): Record<string, unknown> {
  return {
    id: entry.id,
    model: entry.model,
    provider: entry.provider,
    label: entry.label,
    thinking: entry.thinking,
    temperature: entry.temperature,
    attachments: entry.attachments,
    context: entry.context,
    price: entry.rates
      ? {
          input: entry.rates.input * 1_000_000,
          output: entry.rates.output * 1_000_000,
          cache_read: entry.rates.cacheRead * 1_000_000,
        }
      : null,
    kind: entry.kind,
    coding_only: entry.coding_only,
  };
}
