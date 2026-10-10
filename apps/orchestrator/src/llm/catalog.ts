import { writeLog } from "../observability/log.js";
import { defaultEntry, type CatalogEntry } from "./entries.js";
import {
  MODELS_DEV_RETRY_MS,
  MODELS_DEV_TTL_MS,
  MODELS_DEV_URL,
  entryFromModelsDev,
  keepModelsDevRow,
  projectModelsDevFeed,
  readBundledSnapshot,
  type ModelsDevFeed,
  type ModelsDevSnapshot,
} from "./models-dev.js";
import { PROVIDERS, parseModelId, providerById, type ProviderId } from "./providers.js";

export type ModelCatalogOptions = {
  fetch?: typeof fetch;
  /** Where the feed is fetched from; empty keeps the catalog on its snapshot. */
  url?: string;
  ttlMs?: number;
  retryMs?: number;
  timeoutMs?: number;
  /** The catalog to start from; the bundled snapshot when absent. */
  snapshot?: ModelsDevSnapshot;
  now?: () => number;
};

const MODELS_DEV_PROVIDER_IDS = PROVIDERS.flatMap((provider) => (provider.modelsDev ? [provider.modelsDev] : []));

/**
 * The model catalog: models.dev, fetched on the first read and again on a read once the cache is
 * older than an hour. A failed refresh keeps the last good cache and is retried after a while. With
 * no fetch yet, the bundled snapshot serves it.
 */
export class ModelCatalog {
  private entries = new Map<string, CatalogEntry>();
  private byProvider = new Map<ProviderId, CatalogEntry[]>();
  private feedDate: string;
  private fetchedAtMs: number | null = null;
  private failedAtMs: number | null = null;
  private inflight: Promise<void> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: ModelCatalogOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.url = options.url ?? MODELS_DEV_URL;
    this.ttlMs = options.ttlMs ?? MODELS_DEV_TTL_MS;
    this.retryMs = options.retryMs ?? MODELS_DEV_RETRY_MS;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    const snapshot = options.snapshot ?? readBundledSnapshot();
    this.feedDate = snapshot.fetched_at;
    this.load(snapshot.providers);
  }

  private load(feed: ModelsDevFeed): void {
    const entries = new Map<string, CatalogEntry>();
    const byProvider = new Map<ProviderId, CatalogEntry[]>();
    for (const provider of PROVIDERS) {
      if (!provider.modelsDev) {
        continue;
      }
      const rows = Object.values(feed[provider.modelsDev]?.models ?? {}).filter(keepModelsDevRow);
      const listed = rows.map((row) => entryFromModelsDev(provider, row));
      listed.sort((left, right) => left.label.localeCompare(right.label));
      byProvider.set(provider.id, listed);
      for (const entry of listed) {
        entries.set(entry.id, entry);
      }
    }
    this.entries = entries;
    this.byProvider = byProvider;
  }

  /** The feed's fetch date, or the snapshot's: the `pricing_version` a message records. */
  pricingVersion(): string {
    return `models.dev ${this.feedDate}`;
  }

  /** Whether the last fetch is older than the TTL, counting a failed one as due for retry later. */
  stale(): boolean {
    if (!this.url) {
      return false;
    }
    const now = this.now();
    if (this.failedAtMs !== null && now - this.failedAtMs < this.retryMs) {
      return false;
    }
    return this.fetchedAtMs === null || now - this.fetchedAtMs >= this.ttlMs;
  }

  /**
   * The entry for a stored model id. A well-formed id the catalog does not list stays valid with
   * the default capacities; an id without a provider prefix is null.
   */
  entry(id: string): CatalogEntry | null {
    const parsed = parseModelId(id);
    if (!parsed) {
      return null;
    }
    return this.entries.get(id) ?? defaultEntry(parsed.provider, parsed.model);
  }

  /** The catalog's rows for a models.dev provider, by label. */
  listed(provider: ProviderId): CatalogEntry[] {
    return [...(this.byProvider.get(provider) ?? [])];
  }

  /** Fetches the feed when the cache is stale; a failure keeps the cache. */
  async ensureFresh(): Promise<void> {
    if (!this.stale()) {
      return;
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    await this.inflight;
  }

  async refresh(): Promise<void> {
    try {
      const response = await this.fetchFn(this.url, {
        headers: { Accept: "application/json", "User-Agent": "guilds.run" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`models.dev answered ${response.status}`);
      }
      const feed = projectModelsDevFeed(await response.json(), MODELS_DEV_PROVIDER_IDS);
      this.load(feed);
      this.feedDate = new Date(this.now()).toISOString().slice(0, 10);
      this.fetchedAtMs = this.now();
      this.failedAtMs = null;
    } catch (error) {
      this.failedAtMs = this.now();
      writeLog(
        "warn",
        "model catalog refresh failed; keeping the last catalog",
        { source: "backend", operation: "models.catalog_refresh" },
        error,
      );
    }
  }
}

/** The catalog the process reads: models.dev, or the bundled snapshot alone when `MODELS_DEV_URL` is set empty. */
export const modelCatalog = new ModelCatalog({
  ...(process.env.MODELS_DEV_URL !== undefined ? { url: process.env.MODELS_DEV_URL.trim() } : {}),
});

export function catalogById(id: string): CatalogEntry | null {
  return modelCatalog.entry(id);
}

export function modelAcceptsAttachments(id: string): boolean {
  return modelCatalog.entry(id)?.attachments === true;
}

/** The providers a well-formed id may name, for a message. */
export function providerPrefixes(): string {
  return PROVIDERS.map((provider) => `${provider.id}/`).join(", ");
}

export { providerById };
