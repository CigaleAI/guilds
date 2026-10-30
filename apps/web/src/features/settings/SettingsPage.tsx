import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { useOrgModels } from "../../api/queries/models";
import { useOrgUsage, useUpdateProfile, useUpdateOrg } from "../../api/queries/org";
import { switchOrg } from "../../api/identity";
import type { UsageTotals } from "../../api/types";
import { agentLook } from "../../app/agents";
import { useIdentity } from "../../app/identity";
import type { TabSearch } from "../../app/router";
import { chosenTab, placeTabs, useSlots } from "../../app/slots";
import {
  Button,
  StatBand,
  FormField,
  Segmented,
  Select,
  TextField,
  ToneSwatches,
  Banner,
  SkeletonRows,
  Avatar,
  toast,
  identityHex,
  personTone,
} from "@guildsrun/ui";
import { AccessSecrets } from "../access/AccessSecrets";
import { AccessTools } from "../access/AccessTools";
import { formatCost } from "../agent/runs/toolFormat";
import { ModelProviders } from "../models/ModelProviders";
import { handlePattern } from "../names";
import { MachinesTab } from "../machines/MachinesTab";
import { MembersTab } from "./MembersTab";
import { canManageMembers } from "./members";

const coreTabs = [
  { value: "general", label: "General" },
  { value: "members", label: "Members" },
  { value: "machines", label: "Machines" },
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
 * members, its machines, its model keys, the secrets and tools every guild inherits, its usage, and
 * the tabs an extension adds.
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
      ) : tab === "machines" ? (
        <MachinesTab />
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

/** Model keys: the organisation's providers, their chosen models, and the default. */
function ModelKeys() {
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
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
      <ModelProviders models={models.data} canManage={org.role === "owner" || org.role === "admin"} />
    </Scroll>
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
    ...(totals.browser_calls > 0
      ? [
          {
            label: `Browser, ${count.format(totals.browser_calls)} calls`,
            value: formatCost(totals.browser_cost_usd),
          },
        ]
      : []),
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
      {totals.browser_calls > 0 ? (
        <span className="font-mono text-xs text-muted">
          Browser {count.format(totals.browser_calls)} calls, {formatCost(totals.browser_cost_usd)}
        </span>
      ) : null}
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
          {organisation.builder ? (
            <UsageLine name="Builder" totals={organisation.builder} />
          ) : null}
          {organisation.archived ? (
            <UsageLine name="Deleted guilds and agents" totals={organisation.archived} />
          ) : null}
        </div>
      </Group>
    </Scroll>
  );
}
