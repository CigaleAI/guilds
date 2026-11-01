import { readFileSync } from "node:fs";
import path from "node:path";
import { Type, type Static, type TObject } from "@sinclair/typebox";
import { keepMatching } from "../lib/decode.js";
import { isObjectNode, type JsonValue } from "../lib/json.js";
import { hereDir } from "../lib/paths.js";
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

/** A model's input and output modalities, as models.dev names them (`text`, `image`, `audio`...). */
const ModelsDevModalities = Type.Object({
  input: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.Array(Type.String())),
});

/** A model's limits: its context window in tokens. */
const ModelsDevLimit = Type.Object({ context: Type.Optional(Type.Number()) });

/** A model's prices, in USD per million tokens. */
const ModelsDevCost = Type.Object({
  input: Type.Optional(Type.Number()),
  output: Type.Optional(Type.Number()),
  cache_read: Type.Optional(Type.Number()),
});

/** A models.dev model's id, its name and status, and the flags the catalog reads. */
const ModelsDevRow = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String()),
  attachment: Type.Optional(Type.Boolean()),
  reasoning: Type.Optional(Type.Boolean()),
  temperature: Type.Optional(Type.Boolean()),
  tool_call: Type.Optional(Type.Boolean()),
  status: Type.Optional(Type.String()),
});

/** A model as models.dev lists it, reduced to the fields the catalog reads. */
export type ModelsDevModel = Static<typeof ModelsDevRow> & {
  modalities?: Static<typeof ModelsDevModalities>;
  limit?: Static<typeof ModelsDevLimit>;
  cost?: Static<typeof ModelsDevCost>;
};

export type ModelsDevProvider = { id: string; models: Record<string, ModelsDevModel> };
export type ModelsDevFeed = Record<string, ModelsDevProvider>;
export type ModelsDevSnapshot = { fetched_at: string; providers: ModelsDevFeed };

/** What the shipped snapshot names of itself: the day its feed was fetched. */
const SnapshotHeader = Type.Object({ fetched_at: Type.String() });

const SNAPSHOT_FILE = "models-dev.snapshot.json";

/** The fields of a feed object that `schema` describes, each one of another type left out; null when `value` is not an object. */
function fieldsOf<T extends TObject>(schema: T, value: JsonValue | undefined): Static<T> | null {
  return value !== undefined && isObjectNode(value) ? keepMatching(schema, value) : null;
}

/** One feed row reduced to the fields the catalog reads, each one of another type left out; null when it has no id. */
export function projectModelsDevRow(raw: JsonValue): ModelsDevModel | null {
  if (!isObjectNode(raw)) {
    return null;
  }
  const projected: ModelsDevModel | null = keepMatching(ModelsDevRow, raw);
  if (!projected) {
    return null;
  }
  const modalities = fieldsOf(ModelsDevModalities, raw.modalities);
  if (modalities) {
    projected.modalities = modalities;
  }
  const limit = fieldsOf(ModelsDevLimit, raw.limit);
  if (limit?.context !== undefined) {
    projected.limit = { context: limit.context };
  }
  const cost = fieldsOf(ModelsDevCost, raw.cost);
  if (cost) {
    projected.cost = cost;
  }
  return projected;
}

/** A feed provider's models reduced to the fields the catalog reads; a row with no id is dropped. */
function projectModelsDevModels(provider: JsonValue | undefined): Record<string, ModelsDevModel> {
  const models = provider !== undefined && isObjectNode(provider) ? provider.models : undefined;
  const rows = models !== undefined && isObjectNode(models) ? Object.entries(models) : [];
  return Object.fromEntries(
    rows.flatMap(([key, raw]) => {
      const row = raw === undefined ? null : projectModelsDevRow(raw);
      return row ? [[key, row]] : [];
    }),
  );
}

/** The feed reduced to the given providers and the fields the catalog reads. */
export function projectModelsDevFeed(feed: JsonValue, providerIds: readonly string[]): ModelsDevFeed {
  const root = isObjectNode(feed) ? feed : {};
  return Object.fromEntries(providerIds.map((id) => [id, { id, models: projectModelsDevModels(root[id]) }]));
}

/** The feed a models.dev response carries, reduced to the given providers and the fields the catalog reads. */
export async function readModelsDevFeed(response: Response, providerIds: readonly string[]): Promise<ModelsDevFeed> {
  const feed: JsonValue = JSON.parse(await response.text());
  return projectModelsDevFeed(feed, providerIds);
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
  if (!provider.billed || cost?.input === undefined || cost.output === undefined) {
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
    context: context !== undefined && context > 0 ? context : null,
    rates,
    kind: provider.kind,
    coding_only: provider.kind === "coding",
    listed: true,
  };
}

/** The snapshot shipped beside this module. */
export function readBundledSnapshot(): ModelsDevSnapshot {
  const raw: JsonValue = JSON.parse(readFileSync(path.join(hereDir(import.meta.url), SNAPSHOT_FILE), "utf8"));
  const root = isObjectNode(raw) ? raw : {};
  const providers = root.providers !== undefined && isObjectNode(root.providers) ? root.providers : {};
  return {
    fetched_at: fieldsOf(SnapshotHeader, raw)?.fetched_at ?? "unknown",
    providers: projectModelsDevFeed(providers, Object.keys(providers)),
  };
}

export function snapshotFileName(): string {
  return SNAPSHOT_FILE;
}
