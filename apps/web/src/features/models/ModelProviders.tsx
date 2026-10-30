import { useState } from "react";
import {
  useConnectModelProvider,
  useProviderCatalog,
  useRemoveModelProvider,
  useSetDefaultModel,
} from "../../api/queries/models";
import type {
  CatalogModel,
  ModelProvider,
  OrgModelProvider,
  OrgModels,
} from "../../api/types/models";
import { useIdentity } from "../../app/identity";
import {
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  SearchField,
  SkeletonRows,
  Tag,
  TextField,
  toast,
} from "@guildsrun/ui";
import { ProviderLogo } from "./ProviderLogo";
import { PROVIDER_META } from "./models";

const tokens = new Intl.NumberFormat("en", { notation: "compact" });

/** A model's capacities and price in a line: `thinking · images · 1M context · $0.15 / $0.50 per M`. */
export function modelFacts(model: CatalogModel): string {
  const facts: string[] = [];
  if (model.thinking) facts.push("thinking");
  if (model.attachments) facts.push("images");
  if (model.context) facts.push(`${tokens.format(model.context)} context`);
  if (model.price) facts.push(`$${model.price.input} in · $${model.price.output} out per M tokens`);
  return facts.join(" · ");
}

type ModelProvidersProps = { models: OrgModels; canManage: boolean };

/**
 * The models the platform provides, then every provider split into marketplace and coding APIs.
 * The organisation connects a provider with its own key, ticks the models it offers from the
 * provider's catalog, and marks one marketplace model, its own or the platform's, as its default.
 */
export function ModelProviders({ models, canManage }: ModelProvidersProps) {
  const { org } = useIdentity();
  const removeProvider = useRemoveModelProvider(org.id);
  const setDefault = useSetDefaultModel(org.id);
  const [removing, setRemoving] = useState<ModelProvider | null>(null);
  const platform = models.providers.filter(
    (item) => item.source === "platform" && models.models.some((model) => model.provider === item.id),
  );
  const marketplace = models.providers.filter((item) => item.kind === "marketplace");
  const coding = models.providers.filter((item) => item.kind === "coding");
  const removingMeta = models.providers.find((item) => item.id === removing);
  const onDefault = (model: string | null) =>
    setDefault.mutate(model, {
      onSuccess: () => toast({ kind: "success", title: model ? "Default model set" : "Default model cleared" }),
      onError: (error) => toast({ kind: "error", title: "Couldn't set the default", description: error.message }),
    });

  return (
    <>
      <p className="text-sm text-fg-2">
        <span className="font-semibold text-fg">Default model. </span>
        {models.default ? (
          <>
            New agents, Studio and the Builder start on{" "}
            <span className="font-mono text-xs">{models.default}</span>.
          </>
        ) : (
          "None yet: every picker starts empty until one is marked below."
        )}
      </p>
      {platform.length ? (
        <>
          <p className="text-sm text-fg-2">
            <span className="font-semibold text-fg">Provided by the platform. </span>
            These models run on the platform's keys, and the platform chooses them. Any of them can be the
            default. A provider connected below with the organisation's key runs on that key instead.
          </p>
          {platform.map((provider) => (
            <PlatformCard
              key={provider.id}
              provider={provider}
              models={models}
              canManage={canManage}
              onDefault={onDefault}
            />
          ))}
        </>
      ) : null}
      <ProviderSection
        title="Marketplace"
        intro="Agents, Studio and the Builder run on these. Connect a provider with the organisation's key, then choose the models to offer. Keys are encrypted at rest by the orchestrator; only their last characters are shown."
        providers={marketplace}
        models={models}
        canManage={canManage}
        onRemove={setRemoving}
        onDefault={onDefault}
      />
      <ProviderSection
        title="Coding APIs"
        intro="Coding agents can run on these instead of a marketplace model. Their models appear in a picker only for an agent with Coding on."
        providers={coding}
        models={models}
        canManage={canManage}
        onRemove={setRemoving}
        onDefault={null}
      />
      <ConfirmDialog
        kind="destructive"
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove the ${removingMeta?.label ?? ""} key?`}
        description="Its chosen models leave every picker, and agents on this provider cannot run until a key is connected again."
        confirmLabel="Remove key"
        onConfirm={() =>
          removing
            ? removeProvider.mutateAsync(removing).then(
                () => setRemoving(null),
                (error: Error) => {
                  toast({
                    kind: "error",
                    title: "Couldn't remove the key",
                    description: error.message,
                  });
                  throw error;
                },
              )
            : undefined
        }
      />
    </>
  );
}

type ProviderSectionProps = {
  title: string;
  intro: string;
  providers: OrgModelProvider[];
  models: OrgModels;
  canManage: boolean;
  onRemove: (provider: ModelProvider) => void;
  /** Marks a chosen model as the default, or clears it with null; absent for providers that cannot hold it. */
  onDefault: ((model: string | null) => void) | null;
};

function ProviderSection({
  title,
  intro,
  providers,
  models,
  canManage,
  onRemove,
  onDefault,
}: ProviderSectionProps) {
  return (
    <>
      <p className="text-sm text-fg-2">
        <span className="font-semibold text-fg">{title}. </span>
        {intro}
      </p>
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          models={models}
          canManage={canManage}
          onRemove={onRemove}
          onDefault={onDefault}
        />
      ))}
    </>
  );
}

type PlatformCardProps = {
  provider: OrgModelProvider;
  models: OrgModels;
  canManage: boolean;
  onDefault: (model: string | null) => void;
};

/** A provider the platform provides: the models it offers the organisation, each one a possible default. */
function PlatformCard({ provider, models, canManage, onDefault }: PlatformCardProps) {
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <ProviderLogo provider={provider.id} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-md font-semibold">{provider.label}</span>
          <span className="text-sm text-muted">Provided by the platform</span>
        </div>
      </div>
      <ChosenModels
        provider={provider}
        chosen={models.models.filter((model) => model.provider === provider.id)}
        defaultModel={models.default}
        canManage={canManage}
        onDefault={onDefault}
      />
    </section>
  );
}

type ProviderCardProps = {
  provider: OrgModelProvider;
  models: OrgModels;
  canManage: boolean;
  onRemove: (provider: ModelProvider) => void;
  onDefault: ((model: string | null) => void) | null;
};

/** One provider: its state, the connect form, and once connected the catalog to choose from. */
function ProviderCard({ provider, models, canManage, onRemove, onDefault }: ProviderCardProps) {
  const { org } = useIdentity();
  const connect = useConnectModelProvider(org.id);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.base_url ?? "");
  const [choosing, setChoosing] = useState(false);
  const local = provider.id === "local";
  const own = provider.source === "own";
  const chosen = models.models.filter((model) => model.provider === provider.id);
  const state = own
    ? local
      ? `Connected · ${provider.base_url ?? ""}${provider.key_hint ? ` · key ends in ${provider.key_hint}` : ""}`
      : `Connected · key ends in ${provider.key_hint ?? "…"}`
    : local
      ? "Not connected. Save the endpoint's URL, and a key when it needs one."
      : provider.source === "platform"
        ? "Provided by the platform. Paste the organisation's key to run on it instead."
        : "Not connected. Paste the organisation's key.";

  const save = () => {
    const body = {
      provider: provider.id,
      ...(key.trim() ? { api_key: key.trim() } : {}),
      ...(local ? { base_url: url.trim() } : {}),
    };
    connect.mutate(body, {
      onSuccess: () => {
        setKey("");
        toast({ kind: "success", title: `${provider.label} connected` });
        setChoosing(true);
      },
      onError: (error) =>
        toast({ kind: "error", title: `Couldn't connect ${provider.label}`, description: error.message }),
    });
  };
  const canSave = local ? Boolean(url.trim()) && (Boolean(key.trim()) || url.trim() !== (provider.base_url ?? "")) : Boolean(key.trim());

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <ProviderLogo provider={provider.id} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-md font-semibold">{provider.label}</span>
          <span className="text-sm text-muted">{state}</span>
          <span className="text-xs text-muted">{PROVIDER_META[provider.id].blurb}</span>
        </div>
        {own && canManage ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setChoosing((open) => !open)}>
              {choosing ? "Done choosing" : "Choose models"}
            </Button>
            <Button variant="danger" size="sm" onClick={() => onRemove(provider.id)}>
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save();
          }}
        >
          {local ? (
            <TextField
              tone="paper"
              label="Base URL"
              placeholder="http://127.0.0.1:11434/v1"
              className="min-w-60 flex-1"
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
            />
          ) : null}
          <TextField
            tone="paper"
            label={local ? "API key (optional)" : "API key"}
            type="password"
            autoComplete="off"
            className="min-w-60 flex-1"
            value={key}
            onChange={(event) => setKey(event.currentTarget.value)}
          />
          <Button type="submit" size="xl" disabled={!canSave || connect.isPending}>
            {own ? "Replace" : "Connect"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted">Owners and admins manage model keys.</p>
      )}
      {own ? (
        <ChosenModels
          provider={provider}
          chosen={chosen}
          defaultModel={models.default}
          canManage={canManage}
          onDefault={onDefault}
        />
      ) : null}
      {own && choosing && canManage ? (
        <CatalogPicker
          provider={provider}
          chosen={chosen.map((model) => model.id)}
          onSaved={() => setChoosing(false)}
        />
      ) : null}
    </section>
  );
}

type ChosenModelsProps = {
  provider: OrgModelProvider;
  chosen: CatalogModel[];
  defaultModel: string | null;
  canManage: boolean;
  onDefault: ((model: string | null) => void) | null;
};

/** The models a connected provider offers, with the default marked. */
function ChosenModels({ provider, chosen, defaultModel, canManage, onDefault }: ChosenModelsProps) {
  if (!chosen.length) {
    return (
      <p className="text-sm text-muted">
        No models chosen yet: nothing from {provider.label} is offered until some are.
      </p>
    );
  }
  return (
    <ul className="flex flex-col overflow-hidden rounded-lg bg-paper">
      {chosen.map((model) => {
        const isDefault = defaultModel === model.id;
        return (
          <li key={model.id} className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">
                {model.label}
                {isDefault ? (
                  <Tag tone="ink" font="sans" className="ml-2">
                    Default
                  </Tag>
                ) : null}
              </span>
              <span className="truncate font-mono text-xs text-muted">{model.id}</span>
              {modelFacts(model) ? <span className="text-xs text-muted">{modelFacts(model)}</span> : null}
            </span>
            {onDefault && canManage ? (
              <Button variant="ghost" size="sm" onClick={() => onDefault(isDefault ? null : model.id)}>
                {isDefault ? "Clear default" : "Make default"}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

type CatalogPickerProps = {
  provider: OrgModelProvider;
  chosen: string[];
  /** After the chosen models are saved, with what was saved. */
  onSaved: (models: string[]) => void;
  saveLabel?: string;
  /** Whether the save waits for at least one ticked row. */
  requireOne?: boolean;
};

/** The provider's catalog with a search over label and id; ticked rows become the chosen models. */
export function CatalogPicker({
  provider,
  chosen,
  onSaved,
  saveLabel = "Save models",
  requireOne = false,
}: CatalogPickerProps) {
  const { org } = useIdentity();
  const catalog = useProviderCatalog(org.id, provider.id, true);
  const connect = useConnectModelProvider(org.id);
  const [query, setQuery] = useState("");
  const [ticked, setTicked] = useState<string[]>(chosen);
  const needle = query.trim().toLowerCase();
  const rows = (catalog.data ?? []).filter(
    (model) => !needle || model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
  );
  const dirty = JSON.stringify([...ticked].sort()) !== JSON.stringify([...chosen].sort());

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-paper p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          tone="surface"
          label={`Search ${provider.label} models`}
          placeholder="Search by name or id"
          className="min-w-60 flex-1"
          value={query}
          onValueChange={setQuery}
        />
        <span className="text-xs text-muted">{ticked.length} chosen</span>
        <Button
          size="sm"
          disabled={(!dirty && !requireOne) || (requireOne && ticked.length === 0) || connect.isPending}
          onClick={() =>
            connect.mutate(
              { provider: provider.id, models: ticked },
              {
                onSuccess: () => {
                  toast({ kind: "success", title: `${provider.label} models saved` });
                  onSaved(ticked);
                },
                onError: (error) =>
                  toast({ kind: "error", title: "Couldn't save the models", description: error.message }),
              },
            )
          }
        >
          {saveLabel}
        </Button>
      </div>
      {catalog.isPending ? (
        <SkeletonRows rows={4} label="Loading the catalog" />
      ) : catalog.isError ? (
        <Banner tone="error" title="Couldn't load the catalog" meta={catalog.error.message} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No model matches.</p>
      ) : (
        <ul className="flex max-h-96 flex-col overflow-y-auto">
          {rows.map((model) => (
            <li key={model.id} className="border-b border-line py-1.5 last:border-b-0">
              <Checkbox
                checked={ticked.includes(model.id)}
                onCheckedChange={(checked) =>
                  setTicked((current) =>
                    checked === true
                      ? [...current, model.id]
                      : current.filter((id) => id !== model.id),
                  )
                }
                label={
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{model.label}</span>
                    <span className="truncate font-mono text-xs text-muted">{model.id}</span>
                    {modelFacts(model) ? <span className="text-xs text-muted">{modelFacts(model)}</span> : null}
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
