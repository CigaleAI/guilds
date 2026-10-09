import { CATALOG, catalogModelId } from "./catalog.js";

export const PRICING_VERSION = "litellm-1.100.0";

export type CatalogRates = {
  input: number;
  output: number;
  cacheRead: number;
};

export const CATALOG_RATES: Record<string, CatalogRates> = {
  "openrouter/openai/gpt-5.6-luna": { input: 2e-7, output: 1.2e-6, cacheRead: 2e-8 },
  "openrouter/openai/gpt-6-luna": { input: 1e-7, output: 5e-7, cacheRead: 1e-8 },
  "openrouter/openai/gpt-6.1-sol": { input: 2e-6, output: 1e-5, cacheRead: 1e-7 },
  "openrouter/openai/gpt-6-luna-pro": { input: 1e-7, output: 5e-7, cacheRead: 1e-8 },
  "openrouter/anthropic/claude-opus-5": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7 },
  "openrouter/google/gemini-3.8-flash": { input: 7.5e-7, output: 3.75e-6, cacheRead: 7.5e-8 },
  "openrouter/qwen/qwen3.8-flash": { input: 1.5e-7, output: 4.7e-7, cacheRead: 1.6e-8 },
  "deepinfra/Qwen/Qwen3.8-2.4T-A95B": { input: 2e-6, output: 6e-6, cacheRead: 2e-7 },
  "deepinfra/zai-org/GLM-5.3": { input: 1.2e-6, output: 4e-6, cacheRead: 2e-7 },
  "deepinfra/zai-org/GLM-5.3-Flash": { input: 1.5e-7, output: 5e-7, cacheRead: 3e-8 },
  "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash": { input: 2e-7, output: 6e-7, cacheRead: 6e-9 },
};

for (const item of CATALOG) {
  if (item.kind === "marketplace" && !CATALOG_RATES[item.id]) {
    throw new Error(`catalog model has no price: ${item.id}`);
  }
  if (item.kind === "coding" && CATALOG_RATES[item.id]) {
    throw new Error(`coding model must not have a catalog price: ${item.id}`);
  }
}

export type CostSource = "provider" | "catalog" | "unavailable";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
};

export function catalogCostUsd(model: string, usage: TokenUsage): {
  cost_usd: number;
  cost_source: CostSource;
  pricing_version: string;
} {
  const rates = CATALOG_RATES[model];
  if (!rates) {
    return { cost_usd: 0, cost_source: "unavailable", pricing_version: PRICING_VERSION };
  }
  const input = Math.max(0, usage.input_tokens);
  const cached = Math.min(Math.max(0, usage.cache_read_tokens), input);
  const cost =
    (input - cached) * rates.input
    + usage.output_tokens * rates.output
    + cached * rates.cacheRead;
  return { cost_usd: cost, cost_source: "catalog", pricing_version: PRICING_VERSION };
}

export function catalogRateTable(): Array<{ id: string; rates: CatalogRates }> {
  return CATALOG.filter((item) => item.kind === "marketplace").map((item) => {
    const id = catalogModelId(item.provider, item.model);
    const rates = CATALOG_RATES[id];
    if (!rates) {
      throw new Error(`catalog model has no price: ${id}`);
    }
    return { id, rates };
  });
}
