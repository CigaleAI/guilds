import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  useConnectModelProvider,
  useOrgModels,
  useOrgUsage,
  useProviderCatalog,
  useRemoveModelProvider,
  useSetDefaultModel,
  useUpdateProfile,
  useUpdateOrg,
} from "../../api/queries";
import { switchOrg } from "../../api/identity";
import type { CatalogModel, ModelProvider, OrgModelProvider, OrgModels, UsageTotals } from "../../api/types";
import { agentLook } from "../../app/agents";
import { useIdentity } from "../../app/identity";
import type { TabSearch } from "../../app/router";
import { chosenTab, placeTabs, useSlots } from "../../app/slots";
import {
  Button,
  Checkbox,
  StatBand,
  FormField,
  SearchField,
  Segmented,
  Select,
  Tag,
  TextField,
  ToneSwatches,
  Banner,
  SkeletonRows,
  Avatar,
  ConfirmDialog,
  toast,
  identityHex,
  personTone,
} from "@guildsrun/ui";
import { AccessSecrets } from "../access/AccessSecrets";
import { AccessTools } from "../access/AccessTools";
import { formatCost } from "../agent/runs/toolFormat";
import { handlePattern } from "../names";
import { MembersTab } from "./MembersTab";
import { canManageMembers } from "./members";

const coreTabs = [
  { value: "general", label: "General" },
  { value: "members", label: "Members" },
  { value: "keys", label: "Model keys" },
  { value: "secrets", label: "Secrets" },
  { value: "tools", label: "Tools" },
  { value: "usage", label: "Usage" },
];

const count = new Intl.NumberFormat();
const timezones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];

function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-7">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="type-label text-muted">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The organisation's settings: the operator's own profile and the organisation's name, its
 * members, its model keys, the secrets and tools every guild inherits, its usage, and the tabs an
 * edition adds.
 */
export function SettingsPage() {
  const { org } = useIdentity();
  const search = useSearch({ strict: false }) as TabSearch;
  const navigate = useNavigate();
  const { settingsTabs = [] } = useSlots();
  const tabs = placeTabs(coreTabs, settingsTabs);
  const tab = chosenTab(tabs, search.tab);
  const added = settingsTabs.find((item) => item.id === tab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-line px-6 pt-8 pb-4 md:px-10">
        <div className="flex flex-col gap-1">
          <span className="type-label text-muted">Settings</span>
          <h1 className="type-h1">{org.name}</h1>
        </div>
        <Segmented
          size="sm"
          label="Settings section"
          value={tab}
          onValueChange={(next) =>
            void navigate({ to: "/settings", search: next === "general" ? {} : { tab: next } })
          }
          options={tabs}
        />
      </header>
      {added ? (
        added.render()
      ) : tab === "general" ? (
        <General />
      ) : tab === "members" ? (
        <MembersTab />
      ) : tab === "keys" ? (
        <ModelKeys />
      ) : tab === "secrets" ? (
        <AccessSecrets owner={{ scope: "org", id: org.id }} />
      ) : tab === "tools" ? (
        <AccessTools
          owner={{ scope: "org", id: org.id }}
          serverManager={canManageMembers(org.role)}
        />
      ) : (
        <Usage />
      )}
    </div>
  );
}

function General() {
  const { user, org, orgs } = useIdentity();
  const update = useUpdateOrg(org.id);
  const profile = useUpdateProfile();
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [handle, setHandle] = useState(user.name);
  const [timezone, setTimezoneText] = useState(user.timezone ?? "");
  const canManage = org.role === "owner" || org.role === "admin";
  const slugError = handlePattern.test(slug.trim())
    ? undefined
    : "Lowercase letters, digits and hyphens, starting with a letter.";
  const handleError =
    handlePattern.test(handle.trim()) && handle.trim() !== "user"
      ? undefined
      : "Lowercase letters, digits and hyphens, starting with a letter; not “user”.";

  const saveOrg = (event: FormEvent) => {
    event.preventDefault();
    if (slugError || !name.trim()) return;
    update.mutate(
      { name: name.trim(), slug: slug.trim() },
      { onSuccess: () => toast({ kind: "success", title: "Organisation saved" }) },
    );
  };

  const failed = (title: string) => (error: Error) =>
    toast({ kind: "error", title, description: error.message });

  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Scroll>
      <Group title="You">
        <p className="text-sm text-fg-2">
          {user.email ?? user.name} belongs to {org.name} as {org.role}.
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (handleError || handle.trim() === user.name) return;
            profile.mutate(
              { name: handle.trim() },
              {
                onSuccess: () => toast({ kind: "success", title: "Name saved" }),
                onError: failed("Couldn't save your name"),
              },
            );
          }}
        >
          <TextField
            tone="surface"
            label="Name"
            mono
            required
            maxLength={63}
            className="min-w-60 flex-1"
            hint="Agents and other operators tag you as @name; group chat shows it on your messages."
            value={handle}
            onChange={(event) => setHandle(event.currentTarget.value)}
            {...(handleError ? { error: handleError } : {})}
          />
          <Button
            type="submit"
            variant="outline"
            size="xl"
            disabled={profile.isPending || Boolean(handleError) || handle.trim() === user.name}
          >
            Save
          </Button>
        </form>
        <FormField
          controlId="settings-colour"
          label="Your colour"
          labelFor={false}
          hint="Your messages and avatar take this colour. With none, your messages are plum."
        >
          <ToneSwatches
            label="Your colour"
            none="No colour: plum"
            value={personTone(user.color)}
            disabled={profile.isPending}
            onValueChange={(tone) =>
              profile.mutate(
                { color: tone ? identityHex[tone] : null },
                { onError: failed("Couldn't save your colour") },
              )
            }
          />
        </FormField>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            profile.mutate(
              { timezone: timezone.trim() || null },
              {
                onSuccess: () => toast({ kind: "success", title: "Timezone saved" }),
                onError: failed("Couldn't save the timezone"),
              },
            );
          }}
        >
          <TextField
            tone="surface"
            label="Timezone"
            className="min-w-60 flex-1"
            list="settings-timezones"
            placeholder={browserZone}
            value={timezone}
            onChange={(event) => setTimezoneText(event.currentTarget.value)}
          />
          <datalist id="settings-timezones">
            {timezones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <Button type="submit" variant="outline" size="xl" disabled={profile.isPending}>
            Save
          </Button>
        </form>
        <p className="-mt-1 text-sm text-muted">
          {user.timezone
            ? "New random-window routines start in this timezone."
            : `Not set: new routines use this browser's timezone (${browserZone}).`}
        </p>
      </Group>

      <Group title="Organisation">
        {orgs.length > 1 ? (
          <Select
            tone="surface"
            label="Working in"
            className="max-w-sm"
            value={org.id}
            onValueChange={switchOrg}
            options={orgs.map((item) => ({ value: item.id, label: item.name }))}
          />
        ) : null}
        <form onSubmit={saveOrg} className="flex flex-col gap-3">
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              tone="surface"
              label="Name"
              required
              maxLength={80}
              disabled={!canManage}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <TextField
              tone="surface"
              label="Slug"
              mono
              required
              disabled={!canManage}
              value={slug}
              onChange={(event) => setSlug(event.currentTarget.value)}
              {...(slugError ? { error: slugError } : {})}
            />
          </div>
          {update.isError ? (
            <Banner tone="error" title="Couldn't save the organisation">
              {update.error.message}
            </Banner>
          ) : null}
          {canManage ? (
            <Button
              type="submit"
              className="self-start"
              disabled={update.isPending || (name.trim() === org.name && slug.trim() === org.slug)}
            >
              Save
            </Button>
          ) : (
            <p className="text-sm text-muted">
              Owners and admins change the organisation's name and slug.
            </p>
          )}
        </form>
        <p className="text-sm text-muted">
          Members are under{" "}
          <Link to="/settings" search={{ tab: "members" }} className="underline">
            Members
          </Link>
          .
        </p>
      </Group>
    </Scroll>
  );
}

const tokens = new Intl.NumberFormat("en", { notation: "compact" });

/** A model's capacities and price in a line: `thinking · images · 1M context · $0.15 / $0.50 per M`. */
function modelFacts(model: CatalogModel): string {
  const facts: string[] = [];
  if (model.thinking) facts.push("thinking");
  if (model.attachments) facts.push("images");
  if (model.context) facts.push(`${tokens.format(model.context)} context`);
  if (model.price) facts.push(`$${model.price.input} in · $${model.price.output} out per M tokens`);
  return facts.join(" · ");
}

/**
 * Model keys: every provider, split into marketplace and coding APIs. The organisation connects a
 * provider with its own key, ticks the models it offers from the provider's catalog, and marks one
 * marketplace model as its default.
 */
function ModelKeys() {
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const removeProvider = useRemoveModelProvider(org.id);
  const setDefault = useSetDefaultModel(org.id);
  const [removing, setRemoving] = useState<ModelProvider | null>(null);
  const canManage = org.role === "owner" || org.role === "admin";
  const providers = models.data?.providers ?? [];
  const marketplace = providers.filter((item) => item.kind === "marketplace");
  const coding = providers.filter((item) => item.kind === "coding");
  const removingMeta = providers.find((item) => item.id === removing);

  if (models.isPending) {
    return (
      <Scroll>
        <SkeletonRows rows={3} label="Loading model keys" />
      </Scroll>
    );
  }
  if (models.isError || !models.data) {
    return (
      <Scroll>
        <Banner tone="error" title="Couldn't load model keys" meta={models.error?.message} />
      </Scroll>
    );
  }

  return (
    <Scroll>
      <p className="text-sm text-fg-2">
        <span className="font-semibold text-fg">Default model. </span>
        {models.data.default ? (
          <>
            New agents, Studio and the Builder start on{" "}
            <span className="font-mono text-xs">{models.data.default}</span>.
          </>
        ) : (
          "None yet: every picker starts empty until one is marked below."
        )}
      </p>
      <ProviderSection
        title="Marketplace"
        intro="Agents, Studio and the Builder run on these. Connect a provider with the organisation's key, then choose the models to offer. Keys are stored by the orchestrator; only their last characters are shown."
        providers={marketplace}
        models={models.data}
        canManage={canManage}
        onRemove={setRemoving}
        onDefault={(model) =>
          setDefault.mutate(model, {
            onSuccess: () =>
              toast({ kind: "success", title: model ? "Default model set" : "Default model cleared" }),
            onError: (error) =>
              toast({ kind: "error", title: "Couldn't set the default", description: error.message }),
          })
        }
      />
      <ProviderSection
        title="Coding APIs"
        intro="Coding agents can run on these instead of a marketplace model. Their models appear in a picker only for an agent with Coding on."
        providers={coding}
        models={models.data}
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
    </Scroll>
  );
}

function ProviderSection({
  title,
  intro,
  providers,
  models,
  canManage,
  onRemove,
  onDefault,
}: {
  title: string;
  intro: string;
  providers: OrgModelProvider[];
  models: OrgModels;
  canManage: boolean;
  onRemove: (provider: ModelProvider) => void;
  /** Marks a chosen model as the default, or clears it with null; absent for providers that cannot hold it. */
  onDefault: ((model: string | null) => void) | null;
}) {
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

/** One provider: its state, the connect form, and once connected the catalog to choose from. */
function ProviderCard({
  provider,
  models,
  canManage,
  onRemove,
  onDefault,
}: {
  provider: OrgModelProvider;
  models: OrgModels;
  canManage: boolean;
  onRemove: (provider: ModelProvider) => void;
  onDefault: ((model: string | null) => void) | null;
}) {
  const { org } = useIdentity();
  const connect = useConnectModelProvider(org.id);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.base_url ?? "");
  const [choosing, setChoosing] = useState(false);
  const local = provider.id === "local";
  const chosen = models.models.filter((model) => model.provider === provider.id);
  const state = provider.connected
    ? local
      ? `Connected · ${provider.base_url ?? ""}${provider.key_hint ? ` · key ends in ${provider.key_hint}` : ""}`
      : `Connected · key ends in ${provider.key_hint ?? "…"}`
    : local
      ? "Not connected. Save the endpoint's URL, and a key when it needs one."
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
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-md font-semibold">{provider.label}</span>
          <span className="text-sm text-muted">{state}</span>
        </div>
        {provider.connected && canManage ? (
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
            {provider.connected ? "Replace" : "Connect"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted">Owners and admins manage model keys.</p>
      )}
      {provider.connected ? (
        <ChosenModels
          provider={provider}
          chosen={chosen}
          defaultModel={models.default}
          canManage={canManage}
          onDefault={onDefault}
        />
      ) : null}
      {provider.connected && choosing && canManage ? (
        <CatalogPicker provider={provider} chosen={chosen.map((model) => model.id)} onClose={() => setChoosing(false)} />
      ) : null}
    </section>
  );
}

/** The models a connected provider offers, with the default marked. */
function ChosenModels({
  provider,
  chosen,
  defaultModel,
  canManage,
  onDefault,
}: {
  provider: OrgModelProvider;
  chosen: CatalogModel[];
  defaultModel: string | null;
  canManage: boolean;
  onDefault: ((model: string | null) => void) | null;
}) {
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

/** The provider's catalog with a search over label and id; ticked rows become the chosen models. */
function CatalogPicker({
  provider,
  chosen,
  onClose,
}: {
  provider: OrgModelProvider;
  chosen: string[];
  onClose: () => void;
}) {
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
          disabled={!dirty || connect.isPending}
          onClick={() =>
            connect.mutate(
              { provider: provider.id, models: ticked },
              {
                onSuccess: () => {
                  toast({ kind: "success", title: `${provider.label} models saved` });
                  onClose();
                },
                onError: (error) =>
                  toast({ kind: "error", title: "Couldn't save the models", description: error.message }),
              },
            )
          }
        >
          Save models
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

function usageStats(totals: UsageTotals) {
  return [
    { label: "Cost", value: formatCost(totals.cost_usd) },
    { label: "Model calls", value: count.format(totals.calls) },
    { label: "Input tokens", value: count.format(totals.input_tokens) },
    { label: "Output tokens", value: count.format(totals.output_tokens) },
    { label: "Total tokens", value: count.format(totals.total_tokens) },
    { label: "Cache reads", value: count.format(totals.cache_read_tokens) },
  ];
}

function UsageLine({
  name,
  totals,
  lead,
}: {
  name: ReactNode;
  totals: UsageTotals;
  lead?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
      {lead}
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      <span className="font-mono text-xs text-muted">{count.format(totals.calls)} calls</span>
      <span className="w-20 text-right font-mono text-sm font-semibold">
        {formatCost(totals.cost_usd)}
      </span>
    </div>
  );
}

function Usage() {
  const usage = useOrgUsage();
  if (usage.isPending) {
    return (
      <Scroll>
        <SkeletonRows rows={6} label="Loading usage" />
      </Scroll>
    );
  }
  if (usage.isError) {
    return (
      <Scroll>
        <Banner tone="error" title="Couldn't load usage" meta={usage.error.message} />
      </Scroll>
    );
  }
  const organisation = usage.data;
  return (
    <Scroll>
      <Group title={`All of ${organisation.name}`}>
        <StatBand stats={usageStats(organisation)} />
      </Group>
      <Group title="By guild and agent">
        <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
          {organisation.guilds.length === 0 ? (
            <p className="px-4 py-2.5 text-sm text-muted">No guilds yet.</p>
          ) : null}
          {organisation.guilds.map((guild) => (
            <div key={guild.id}>
              <UsageLine
                name={
                  <Link
                    to="/guilds/$guildId/usage"
                    params={{ guildId: guild.id }}
                    className="font-semibold hover:underline"
                  >
                    {guild.name}
                  </Link>
                }
                totals={guild}
              />
              {guild.agents.map((agent) => (
                <UsageLine
                  key={agent.id}
                  lead={
                    <Avatar name={agent.name} size={24} className="ml-4" {...agentLook(agent)} />
                  }
                  name={
                    <Link
                      to="/guilds/$guildId/agents/$agentId/usage"
                      params={{ guildId: guild.id, agentId: agent.id }}
                      className="font-mono hover:underline"
                    >
                      {agent.name}
                    </Link>
                  }
                  totals={agent}
                />
              ))}
            </div>
          ))}
          {organisation.studio ? (
            <UsageLine name="Studio coach" totals={organisation.studio} />
          ) : null}
          {organisation.archived ? (
            <UsageLine name="Deleted guilds and agents" totals={organisation.archived} />
          ) : null}
        </div>
      </Group>
    </Scroll>
  );
}
