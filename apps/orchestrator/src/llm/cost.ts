import { modelCatalog, type ModelCatalog } from "./catalog.js";

export type CostSource = "provider" | "catalog" | "unavailable";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
};

/**
 * The cost of a call from the catalog's rates, for a billed provider whose row has a price.
 * Cached input is priced at the cache-read rate; `cache_read_tokens` is a subset of `input_tokens`.
 */
export function catalogCostUsd(
  model: string,
  usage: TokenUsage,
  catalog: ModelCatalog = modelCatalog,
): {
  cost_usd: number;
  cost_source: CostSource;
  pricing_version: string;
} {
  const pricingVersion = catalog.pricingVersion();
  const rates = catalog.entry(model)?.rates;
  if (!rates) {
    return { cost_usd: 0, cost_source: "unavailable", pricing_version: pricingVersion };
  }
  const input = Math.max(0, usage.input_tokens);
  const cached = Math.min(Math.max(0, usage.cache_read_tokens), input);
  const cost = (input - cached) * rates.input + usage.output_tokens * rates.output + cached * rates.cacheRead;
  return { cost_usd: cost, cost_source: "catalog", pricing_version: pricingVersion };
}
