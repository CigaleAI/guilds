import { encryptPayload } from "../credentials/crypto.js";
import { newId } from "../lib/ids.js";
import { PolicyError } from "../policy/index.js";
import { modelCatalog, type ModelCatalog } from "./catalog.js";
import { listProviderModels } from "./client.js";
import { LLMError } from "./completion.js";
import {
  coreModelCredentials,
  decryptProviderRow,
  keyHint,
  modelProviderStore,
  type ModelCredentialsProvider,
} from "./credentials.js";
import { defaultEntry, entryPayload, type CatalogEntry } from "./entries.js";
import {
  PROVIDERS,
  catalogModelId,
  parseModelId,
  providerById,
  providerLabel,
  type ProviderDef,
  type ProviderKind,
} from "./providers.js";
import {
  deleteOrgModelProvider,
  getOrgDefaultModel,
  getOrgModelProvider,
  listOrgModelProviders,
  setOrgDefaultModel,
  upsertOrgModelProvider,
} from "../db/orgs.js";
import { bindQuery, type Queryable } from "../db/pg.js";

// The organisation's model setup: the providers it has connected, the models it chose to offer
// from each, and its default. Every picker reads `read`; Model keys browses a provider's catalog
// and writes the row.

export class ModelsError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ModelsError";
    this.status = status;
  }
}

/** The db/ functions an organisation's providers and default model are read and written through, on `db`. */
function modelsDatabase(db: Queryable) {
  return {
    listOrgModelProviders: bindQuery(db, listOrgModelProviders),
    getOrgModelProvider: bindQuery(db, getOrgModelProvider),
    upsertOrgModelProvider: bindQuery(db, upsertOrgModelProvider),
    deleteOrgModelProvider: bindQuery(db, deleteOrgModelProvider),
    getOrgDefaultModel: bindQuery(db, getOrgDefaultModel),
    setOrgDefaultModel: bindQuery(db, setOrgDefaultModel),
  };
}

export type ModelsDatabase = ReturnType<typeof modelsDatabase>;

export type ModelsServiceDeps = {
  db: ModelsDatabase;
  credentials: ModelCredentialsProvider;
  catalog?: ModelCatalog;
  fetch?: typeof fetch;
  masterKey?: Buffer | undefined;
};

/** What `modelsService` runs with beside `db`; credentials are core's over its rows when absent. */
export type ModelsServices = {
  credentials?: ModelCredentialsProvider | undefined;
  catalog?: ModelCatalog;
  fetch?: typeof fetch;
  masterKey?: Buffer | undefined;
};

/** Whose key a connected provider runs on: the organisation's own, or one the platform provides. */
export type ProviderSource = "own" | "platform";

export type ProviderItem = {
  id: string;
  label: string;
  kind: ProviderKind;
  connected: boolean;
  /** Null while the provider is not connected. */
  source: ProviderSource | null;
  key_hint: string | null;
  base_url: string | null;
};

export type OrgModelsPayload = {
  default: string | null;
  providers: ProviderItem[];
  models: Array<Record<string, unknown>>;
};

const MAX_CHOSEN_MODELS = 500;

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ModelsError(422, `${field} must be a list of model ids`);
  }
  return value as string[];
}

/** The chosen ids of a provider: `{provider}/{model}`, trimmed, deduplicated, in the order given. */
export function validateChosenModels(provider: ProviderDef, value: unknown): string[] {
  const ids = stringList(value, "models");
  const chosen: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    const parsed = parseModelId(id);
    if (!parsed || parsed.provider.id !== provider.id) {
      throw new ModelsError(422, `models must be ${provider.id}/{model} ids`);
    }
    if (!chosen.includes(id)) {
      chosen.push(id);
    }
  }
  if (chosen.length > MAX_CHOSEN_MODELS) {
    throw new ModelsError(422, `at most ${MAX_CHOSEN_MODELS} models per provider`);
  }
  return chosen;
}

function localEntry(model: string): CatalogEntry {
  const local = providerById("local");
  if (!local) {
    throw new Error("local provider missing");
  }
  return { ...defaultEntry(local, model), thinking: true, temperature: true, attachments: false, listed: true };
}

function requireProvider(id: string): ProviderDef {
  const provider = providerById(id);
  if (!provider) {
    throw new ModelsError(422, "unknown model provider");
  }
  return provider;
}

export class ModelsService {
  private readonly catalog: ModelCatalog;

  constructor(private readonly deps: ModelsServiceDeps) {
    this.catalog = deps.catalog ?? modelCatalog;
  }

  /** The chosen models of a connected provider as catalog entries. */
  private chosenEntries(provider: ProviderDef, ids: readonly string[]): CatalogEntry[] {
    const entries = ids.map((id) => {
      const parsed = parseModelId(id);
      if (!parsed) {
        return null;
      }
      return provider.id === "local" ? localEntry(parsed.model) : (this.catalog.entry(id) ?? defaultEntry(provider, parsed.model));
    });
    return entries
      .filter((entry): entry is CatalogEntry => entry !== null)
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  private async connected(orgId: string, provider: ProviderDef): Promise<{ connected: boolean; baseURL: string | null }> {
    try {
      const credentials = await this.deps.credentials.modelCredentials(orgId, provider.id);
      return { connected: credentials !== null, baseURL: credentials?.baseURL ?? null };
    } catch (error) {
      if (error instanceof PolicyError) {
        return { connected: true, baseURL: null };
      }
      throw error;
    }
  }

  /** The providers whose credentials resolve for the organisation. */
  async connectedProviders(orgId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const provider of PROVIDERS) {
      if ((await this.connected(orgId, provider)).connected) {
        ids.add(provider.id);
      }
    }
    return ids;
  }

  async defaultModel(orgId: string): Promise<string | null> {
    return this.deps.db.getOrgDefaultModel(orgId);
  }

  /** What every picker reads: the default, each provider's state, and the chosen models with their capacities. */
  async read(orgId: string): Promise<OrgModelsPayload> {
    await this.catalog.ensureFresh();
    const rows = new Map(
      (await this.deps.db.listOrgModelProviders(orgId)).map((row) => [row.provider, row]),
    );
    const providers: ProviderItem[] = [];
    const models: Array<Record<string, unknown>> = [];
    for (const provider of PROVIDERS) {
      const row = rows.get(provider.id);
      const state = await this.connected(orgId, provider);
      providers.push({
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        connected: state.connected,
        source: state.connected ? (row?.own_key === true ? "own" : "platform") : null,
        key_hint: row?.key_hint || null,
        base_url: provider.id === "local" ? state.baseURL : null,
      });
      if (row && state.connected) {
        models.push(...this.chosenEntries(provider, row.models).map(entryPayload));
      }
    }
    return { default: await this.deps.db.getOrgDefaultModel(orgId), providers, models };
  }

  /** A provider's full catalog, or the local endpoint's live list once its URL is saved. */
  async providerCatalog(orgId: string, providerId: string): Promise<Array<Record<string, unknown>>> {
    const provider = requireProvider(providerId);
    if (provider.modelsDev) {
      await this.catalog.ensureFresh();
      return this.catalog.listed(provider.id).map(entryPayload);
    }
    const row = await this.deps.db.getOrgModelProvider(orgId, provider.id);
    const secret = row ? decryptProviderRow(row, this.deps.masterKey) : null;
    if (!secret?.baseURL) {
      throw new ModelsError(422, "save the local endpoint's URL first");
    }
    const ids = await this.listModels(provider, secret.apiKey, secret.baseURL);
    return ids.map((id) => entryPayload(localEntry(id)));
  }

  private async listModels(provider: ProviderDef, apiKey: string, baseURL: string | null): Promise<string[]> {
    try {
      return await listProviderModels(provider, {
        apiKey,
        baseURL,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
    } catch (error) {
      throw new ModelsError(422, error instanceof LLMError ? error.message : "couldn't reach the provider");
    }
  }

  /**
   * Connects a provider, or changes what it offers: the key (kept when absent on a connected
   * provider), the base URL of a local endpoint, and the chosen models. The key is probed before
   * the row is written.
   */
  async connect(
    orgId: string,
    providerId: string,
    input: { api_key?: unknown; base_url?: unknown; models?: unknown },
  ): Promise<ProviderItem> {
    const provider = requireProvider(providerId);
    const existing = await this.deps.db.getOrgModelProvider(orgId, provider.id);
    const stored = existing ? decryptProviderRow(existing, this.deps.masterKey) : null;
    const givenKey = typeof input.api_key === "string" ? input.api_key.trim() : "";
    const apiKey = givenKey || stored?.apiKey || "";
    const givenURL = typeof input.base_url === "string" ? input.base_url.trim() : "";
    const baseURL = provider.id === "local" ? givenURL || stored?.baseURL || "" : null;
    if (provider.id === "local") {
      if (!baseURL) {
        throw new ModelsError(422, "base_url is required");
      }
      if (!/^https?:\/\//.test(baseURL)) {
        throw new ModelsError(422, "base_url must start with http:// or https://");
      }
    } else if (!apiKey) {
      throw new ModelsError(422, "api_key is required");
    }
    const models =
      input.models === undefined && existing
        ? validateChosenModels(provider, existing.models)
        : validateChosenModels(provider, input.models);
    await this.listModels(provider, apiKey, baseURL);
    const payload: Record<string, unknown> = { api_key: apiKey };
    if (baseURL) {
      payload.base_url = baseURL;
    }
    const [ciphertext, nonce] = encryptPayload(payload, this.deps.masterKey);
    const now = new Date();
    const row = await this.deps.db.upsertOrgModelProvider(
      {
        providerId: newId("mp"),
        orgId,
        provider: provider.id,
        ciphertext,
        nonce,
        keyHint: apiKey ? keyHint(apiKey) : null,
        models,
      },
      now,
    );
    const current = await this.deps.db.getOrgDefaultModel(orgId);
    if (current && parseModelId(current)?.provider.id === provider.id && !models.includes(current)) {
      await this.deps.db.setOrgDefaultModel(orgId, null, now);
    }
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      connected: true,
      source: "own",
      key_hint: row.key_hint || null,
      base_url: baseURL,
    };
  }

  /** Names the organisation's default: one of its chosen models on a connected marketplace provider, or none. */
  async setDefault(orgId: string, model: unknown): Promise<{ default: string | null }> {
    const now = new Date();
    if (model === null || model === undefined || model === "") {
      await this.deps.db.setOrgDefaultModel(orgId, null, now);
      return { default: null };
    }
    if (typeof model !== "string") {
      throw new ModelsError(422, "model must be a string or null");
    }
    const id = model.trim();
    const parsed = parseModelId(id);
    if (!parsed) {
      throw new ModelsError(422, "model must be {provider}/{model}");
    }
    if (parsed.provider.kind !== "marketplace") {
      throw new ModelsError(422, "the default must be a marketplace model");
    }
    const row = await this.deps.db.getOrgModelProvider(orgId, parsed.provider.id);
    const chosen = row?.models ?? [];
    if (!row || !chosen.includes(id)) {
      throw new ModelsError(422, `choose ${id} under ${providerLabel(parsed.provider.id)} on Model keys first`);
    }
    await this.deps.db.setOrgDefaultModel(orgId, id, now);
    return { default: id };
  }

  /**
   * Removes the organisation's key for the provider and its chosen models; a default among them
   * clears. A provider the platform provides is not the organisation's to remove.
   */
  async remove(orgId: string, providerId: string): Promise<boolean> {
    const provider = requireProvider(providerId);
    const existing = await this.deps.db.getOrgModelProvider(orgId, provider.id);
    if (!existing) {
      return false;
    }
    if (!existing.ciphertext) {
      throw new ModelsError(409, `${provider.label} is provided by the platform`);
    }
    const deleted = await this.deps.db.deleteOrgModelProvider(orgId, provider.id);
    if (!deleted) {
      return false;
    }
    const current = await this.deps.db.getOrgDefaultModel(orgId);
    if (current && current.startsWith(`${provider.id}/`)) {
      await this.deps.db.setOrgDefaultModel(orgId, null, new Date());
    }
    return true;
  }
}

/** The organisation's model setup, read and written on `db` and run with `services`. */
export function modelsService(db: Queryable, services: ModelsServices = {}): ModelsService {
  const credentials =
    services.credentials ?? coreModelCredentials(modelProviderStore(db), services.masterKey);
  return new ModelsService({ ...services, db: modelsDatabase(db), credentials });
}

export { catalogModelId };
