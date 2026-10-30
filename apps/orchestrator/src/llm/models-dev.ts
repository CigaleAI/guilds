import { readFileSync } from "node:fs";
import path from "node:path";
import { hereDir } from "../lib/paths.js";
import { isPlainObject } from "./payload.js";
import { catalogModelId, type ProviderDef } from "./providers.js";
import type { CatalogEntry, CatalogRates } from "./entries.js";

// models.dev is the catalog. The feed's providers are keyed by id, each with its models keyed by
// id. Core keeps the fields the catalog reads; a snapshot of the hosted providers ships in the
// source tree for a box with no cache and no network.

export const MODELS_DEV_URL = "https://models.dev/api.json";
/** The cache is refreshed on a read after this long. */
export const MODELS_DEV_TTL_MS = 60 * 60 * 1000;
/** A failed refresh is retried on a read after this long. */
export const MODELS_DEV_RETRY_MS = 5 * 60 * 1000;

export type ModelsDevModel = {
  id: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  status?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  /** USD per million tokens. */
  cost?: { input?: number; output?: number; cache_read?: number };
};

export type ModelsDevProvider = { id: string; models: Record<string, ModelsDevModel> };
export type ModelsDevFeed = Record<string, ModelsDevProvider>;
export type ModelsDevSnapshot = { fetched_at: string; providers: ModelsDevFeed };

const SNAPSHOT_FILE = "models-dev.snapshot.json";

function asStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const TEXT_FIELDS = ["name", "status"] as const;
const FLAG_FIELDS = ["attachment", "reasoning", "temperature", "tool_call"] as const;

/** A feed row's names and flags, each kept when it has the type the catalog reads. */
function scalarFieldsOf(row: Record<string, unknown>): Partial<ModelsDevModel> {
  const fields: Partial<ModelsDevModel> = {};
  for (const key of TEXT_FIELDS) {
    const value = row[key];
    if (typeof value === "string") fields[key] = value;
  }
  for (const key of FLAG_FIELDS) {
    const value = row[key];
    if (typeof value === "boolean") fields[key] = value;
  }
  return fields;
}

/** A feed row's modalities, each a list of the strings it holds. */
function modalitiesOf(modalities: Record<string, unknown>): NonNullable<ModelsDevModel["modalities"]> {
  const input = asStringList(modalities.input);
  const output = asStringList(modalities.output);
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
}

/** A feed row's prices per million tokens, each kept when it is a finite number. */
function costOf(cost: Record<string, unknown>): NonNullable<ModelsDevModel["cost"]> {
  const input = asNumber(cost.input);
  const output = asNumber(cost.output);
  const cacheRead = asNumber(cost.cache_read);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
  };
}

/** One feed row reduced to the fields the catalog reads; null when it has no id. */
export function projectModelsDevRow(raw: unknown): ModelsDevModel | null {
  const row = isPlainObject(raw) ? raw : null;
  if (!row || typeof row.id !== "string" || !row.id) {
    return null;
  }
  const projected: ModelsDevModel = { id: row.id, ...scalarFieldsOf(row) };
  if (isPlainObject(row.modalities)) {
    projected.modalities = modalitiesOf(row.modalities);
  }
  const context = isPlainObject(row.limit) ? asNumber(row.limit.context) : undefined;
  if (context !== undefined) {
    projected.limit = { context };
  }
  if (isPlainObject(row.cost)) {
    projected.cost = costOf(row.cost);
  }
  return projected;
}

/** The feed reduced to the given providers and the fields the catalog reads. */
export function projectModelsDevFeed(feed: unknown, providerIds: readonly string[]): ModelsDevFeed {
  const root = isPlainObject(feed) ? feed : {};
  const projected: ModelsDevFeed = {};
  for (const id of providerIds) {
    const provider = root[id];
    const models = isPlainObject(provider) && isPlainObject(provider.models) ? provider.models : {};
    const rows: Record<string, ModelsDevModel> = {};
    for (const [key, raw] of Object.entries(models)) {
      const row = projectModelsDevRow(raw);
      if (row) {
        rows[key] = row;
      }
    }
    projected[id] = { id, models: rows };
  }
  return projected;
}

/** A row is kept when it calls tools, is not deprecated, and takes text in and out. */
export function keepModelsDevRow(row: ModelsDevModel): boolean {
  const input = row.modalities?.input ?? [];
  const output = row.modalities?.output ?? [];
  return row.tool_call === true && row.status !== "deprecated" && input.includes("text") && output.includes("text");
}

/**
 * A row's prices as rates per token, for a billed provider whose row prices input and output; a
 * cache read without a price of its own costs as input.
 */
function ratesOf(provider: ProviderDef, cost: ModelsDevModel["cost"]): CatalogRates | null {
  if (!provider.billed || typeof cost?.input !== "number" || typeof cost.output !== "number") {
    return null;
  }
  return {
    input: cost.input / 1_000_000,
    output: cost.output / 1_000_000,
    cacheRead: (cost.cache_read ?? cost.input) / 1_000_000,
  };
}

export function entryFromModelsDev(provider: ProviderDef, row: ModelsDevModel): CatalogEntry {
  const rates = ratesOf(provider, row.cost);
  const context = row.limit?.context;
  return {
    id: catalogModelId(provider.id, row.id),
    provider: provider.id,
    model: row.id,
    label: (row.name ?? "").trim() || row.id,
    thinking: row.reasoning === true,
    temperature: row.temperature !== false,
    attachments: row.attachment === true || (row.modalities?.input ?? []).includes("image"),
    context: typeof context === "number" && context > 0 ? context : null,
    rates,
    kind: provider.kind,
    coding_only: provider.kind === "coding",
    listed: true,
  };
}

/** The snapshot shipped beside this module. */
export function readBundledSnapshot(): ModelsDevSnapshot {
  const raw: unknown = JSON.parse(readFileSync(path.join(hereDir(import.meta.url), SNAPSHOT_FILE), "utf8"));
  const root = isPlainObject(raw) ? raw : {};
  const fetchedAt = typeof root.fetched_at === "string" ? root.fetched_at : "unknown";
  const providers = isPlainObject(root.providers) ? root.providers : {};
  return { fetched_at: fetchedAt, providers: projectModelsDevFeed(providers, Object.keys(providers)) };
}

export function snapshotFileName(): string {
  return SNAPSHOT_FILE;
}
