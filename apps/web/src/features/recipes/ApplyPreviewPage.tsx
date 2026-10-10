import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck, Rocket } from "lucide-react";
import { useState } from "react";
import {
  useAddOrgServer,
  useApplyRecipe,
  useInstallRegistryConnector,
  useOrgModels,
  useRecipe,
  useRecipePreview,
} from "../../api/queries";
import type {
  ApplyConnectionChoice,
  ApplyInstall,
  ApplySetup,
  PlannedConnection,
} from "../../api/types";
import { hasConnectedProvider } from "../../api/types";
import { useIdentity } from "../../app/identity";
import { setupSearch } from "../instance/instance";
import { ConnectProviderGuide } from "../models/ConnectProviderGuide";
import { modelOptions } from "../models/models";
import {
  Button,
  ConfirmDialog,
  Select,
  TextField,
  Banner,
  PageError,
  SkeletonRows,
  toast,
  Icon,
  Tag,
} from "@guildsrun/ui";
import { isRecipeApproved, planFromRecipe } from "./plan/planModel";
import { PlanView } from "./plan/PlanView";

const connectLater = "create";

/** The login apply starts a connector with, unless the operator picks another. */
function defaultLogin(connection: PlannedConnection): string {
  return connection.action === "reuse" && connection.connection_id
    ? connection.connection_id
    : connectLater;
}

function choiceOf(connection: PlannedConnection, login: string): ApplyConnectionChoice {
  return {
    server: connection.server,
    action: login === connectLater ? "create" : "reuse",
    scope: connection.recommended_scope,
    ...(login === connectLater ? {} : { connection_id: login }),
  };
}

/**
 * What applying an approved recipe creates, before anything is written: the new guild's name, each
 * agent's name and model, and for each connector a live login to reuse or one to connect
 * afterwards.
 */
export function ApplyPreviewPage() {
  const { recipeId } = useParams({ from: "/recipes/$recipeId/apply" });
  const navigate = useNavigate();
  const { org } = useIdentity();
  const recipe = useRecipe(recipeId);
  const preview = useRecipePreview(recipeId, recipe.data?.body_version);
  const orgModels = useOrgModels(org.id);
  const applyRecipe = useApplyRecipe(recipeId);
  const [guildName, setGuildName] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [logins, setLogins] = useState<Record<string, string>>({});

  const failed = recipe.error ?? preview.error;
  if (failed) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <PageError title="Couldn't prepare this apply" description={failed.message} />
      </div>
    );
  }
  if (!recipe.data || !preview.data) {
    return (
      <div className="p-8">
        <SkeletonRows rows={8} label="Preparing the apply" />
      </div>
    );
  }

  const data = preview.data;
  const creates = data.creates;
  const planned = creates.connections.length ? creates.connections : data.connections;
  const approved = isRecipeApproved(recipe.data.status);
  const modelOf = (role: string) =>
    models[role] ?? data.models.find((item) => item.role === role)?.model ?? "";
  const noProvider = hasConnectedProvider(orgModels.data) === false;
  const missingModel = creates.agents.some((agent) => !modelOf(agent.role));
  const blockedBy = !approved
    ? "Approve this recipe before applying it."
    : noProvider
      ? "Connect a model provider on Model keys before applying."
      : missingModel
        ? "Choose a model for each agent."
        : (data.errors[0]?.message ?? null);
  const plan = planFromRecipe(recipe.data.body, {
    creates,
    connections: planned,
    secrets: creates.secrets.length ? creates.secrets : data.secrets,
  });
  const nameOf = (role: string, fallback: string) => names[role] ?? fallback;
  const loginOf = (connection: PlannedConnection) =>
    logins[connection.server] ?? defaultLogin(connection);

  const create = () =>
    applyRecipe.mutate(
      {
        guild_name: (guildName ?? data.guild_name).trim() || data.guild_name,
        names: creates.agents.map((agent) => ({
          role: agent.role,
          name: nameOf(agent.role, agent.name).trim() || agent.name,
        })),
        models: creates.agents.map((agent) => ({ role: agent.role, model: modelOf(agent.role) })),
        connections: planned.map((connection) => choiceOf(connection, loginOf(connection))),
      },
      {
        onSuccess: (row) => {
          toast({ kind: "success", title: "Guild created", description: "Next: its checklist." });
          void navigate({ to: "/applies/$applyId", params: { applyId: row.id } });
        },
        onError: (error) =>
          toast({ kind: "error", title: "Couldn't create the guild", description: error.message }),
      },
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
      <div className="mx-auto flex max-w-240 flex-col gap-6">
        <header className="flex flex-col gap-3">
          <Button asChild variant="ghost" size="sm" className="self-start">
            <Link to="/recipes/$recipeId" params={{ recipeId }}>
              <Icon icon={ArrowLeft} size={14} />
              {data.recipe_name}
            </Link>
          </Button>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-60 flex-1 flex-col gap-1">
              <span className="type-label text-muted">Apply</span>
              <h1 className="type-h1">{data.recipe_name}</h1>
              <p className="text-sm text-fg-2">
                Review what this creates, then create the guild. Its routines stay paused until its
                checklist is done.
              </p>
            </div>
            <Button
              size="md"
              disabled={blockedBy !== null || applyRecipe.isPending}
              onClick={create}
            >
              <Icon icon={Rocket} size={14} />
              {applyRecipe.isPending ? "Creating…" : "Create guild"}
            </Button>
          </div>
        </header>

        {blockedBy ? (
          <Banner tone="error" title="Not ready to apply">
            {blockedBy}
          </Banner>
        ) : (
          <div className="flex items-center gap-3 rounded-xl bg-t-tide px-4 py-3 text-t-tide-fg">
            <Icon icon={CircleCheck} size={18} />
            <span className="text-sm">
              The recipe is approved and checks out. Create the guild, then connect any remaining
              logins.
            </span>
          </div>
        )}

        {data.installs.length ? (
          <Installs installs={data.installs} onInstalled={() => void preview.refetch()} />
        ) : null}

        {data.setups.length ? <Setups setups={data.setups} /> : null}

        {noProvider ? <ConnectProviderGuide what="this guild's agents" /> : null}

        <TextField
          tone="surface"
          label="Guild name"
          className="max-w-md"
          value={guildName ?? data.guild_name}
          onChange={(event) => setGuildName(event.currentTarget.value)}
        />

        <PlanView
          plan={plan}
          findings={data.findings}
          hideEmpty
          agentExtras={(agent) => {
            const name = nameOf(agent.role, agent.name);
            const recommended = data.models.find((item) => item.role === agent.role)?.recommended;
            return (
              <div className="grid gap-3 md:grid-cols-2">
                <TextField
                  tone="paper"
                  label="Agent name"
                  value={name}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setNames((current) => ({ ...current, [agent.role]: value }));
                  }}
                  {...(data.collisions.includes(name.trim())
                    ? { error: "An agent already has this name. Rename it before creating." }
                    : {})}
                />
                {noProvider ? null : (
                  <Select
                    tone="paper"
                    label="Model"
                    placeholder="Choose a model"
                    value={modelOf(agent.role)}
                    onValueChange={(value) =>
                      setModels((current) => ({ ...current, [agent.role]: value }))
                    }
                    options={modelOptions(orgModels.data, {
                      current: modelOf(agent.role),
                      coding: agent.coding,
                    })}
                    hint={recommended ? `The recipe recommends ${recommended}.` : undefined}
                    {...(modelOf(agent.role) ? {} : { error: "Choose a model." })}
                  />
                )}
              </div>
            );
          }}
          connectionExtras={(server) => {
            const connection = planned.find((item) => item.server === server);
            if (!connection) return null;
            return (
              <Select
                tone="paper"
                label="Login"
                value={loginOf(connection)}
                onValueChange={(value) =>
                  setLogins((current) => ({ ...current, [connection.server]: value }))
                }
                options={[
                  ...connection.reusable.map((login) => ({
                    value: login.id,
                    label: `Reuse the ${login.owner_scope} login`,
                  })),
                  { value: connectLater, label: "Connect after the guild exists" },
                ]}
              />
            );
          }}
        />
      </div>
    </div>
  );
}

/**
 * The connectors the recipe names that the box lacks. An instance admin installs a registry one;
 * an owner or admin adds the recipe's own remote server as the organisation's server.
 */
function Installs({
  installs,
  onInstalled,
}: {
  installs: ApplyInstall[];
  onInstalled: () => void;
}) {
  const { user, org } = useIdentity();
  const install = useInstallRegistryConnector();
  const addServer = useAddOrgServer(org.id);
  const [confirming, setConfirming] = useState<string | null>(null);
  const canAdd = org.role === "owner" || org.role === "admin";
  const busy = install.isPending || addServer.isPending;

  const fromRegistry = (server: string, verified: boolean) =>
    install.mutateAsync({ slug: server, unverified: !verified }).then(
      () => {
        toast({ kind: "success", title: `${server} installed` });
        onInstalled();
      },
      (error: Error) => {
        toast({ kind: "error", title: `Couldn't install ${server}`, description: error.message });
        throw error;
      },
    );

  const fromRecipe = (item: Extract<ApplyInstall, { from: "recipe" }>) =>
    addServer.mutate(
      {
        slug: item.server,
        url: item.url,
        display_name: item.display_name,
        description: item.description,
        auth: item.auth,
        ...(item.auth === "oauth" ? { oauth_strategy: "dynamic" as const } : {}),
      },
      {
        onSuccess: () => {
          toast({ kind: "success", title: `${item.display_name} added` });
          onInstalled();
        },
        onError: (error) =>
          toast({
            kind: "error",
            title: `Couldn't add ${item.display_name}`,
            description: error.message,
          }),
      },
    );

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-surface p-4">
      <h3 className="type-label text-muted">Connectors to install · {installs.length}</h3>
      <ul className="flex flex-col gap-2">
        {installs.map((item) => (
          <li key={item.server} className="flex flex-wrap items-center gap-2 text-sm">
            {item.from === "registry" ? (
              <>
                <span className="min-w-0 flex-1 text-fg-2">
                  Install <span className="font-mono">{item.server}</span> v{item.version} from the
                  registry{" "}
                  {!item.verified ? (
                    <Tag tone="ochre" font="sans">
                      unverified
                    </Tag>
                  ) : null}
                </span>
                {user.platform_admin ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      item.verified
                        ? void fromRegistry(item.server, true).catch(() => undefined)
                        : setConfirming(item.server)
                    }
                  >
                    Install
                  </Button>
                ) : (
                  <span className="text-xs text-muted">
                    An instance admin installs it under Admin → Connector catalog.
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-fg-2">
                    Add {item.display_name} (<span className="font-mono">{item.server}</span>) as
                    this organisation's server
                  </span>
                  <span className="truncate font-mono text-xs text-muted">{item.url}</span>
                </span>
                {canAdd ? (
                  <Button size="sm" disabled={busy} onClick={() => fromRecipe(item)}>
                    Add server
                  </Button>
                ) : (
                  <span className="text-xs text-muted">An owner or admin adds it.</span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => !next && setConfirming(null)}
        title={`Install ${confirming ?? ""} unverified?`}
        description="The registry hasn't verified its publisher. Its tools reach whatever its logins grant."
        confirmLabel="Install unverified"
        onConfirm={() => (confirming ? fromRegistry(confirming, false) : undefined)}
      />
    </section>
  );
}

/**
 * The connectors the recipe needs that the box has but no platform admin has set up. The guild
 * cannot connect them until one enters the platform key under Admin → Platform keys.
 */
function Setups({ setups }: { setups: ApplySetup[] }) {
  const { user } = useIdentity();
  const location = useLocation();
  return (
    <section className="flex flex-col gap-2 rounded-xl bg-surface p-4">
      <h3 className="type-label text-muted">Connectors to set up · {setups.length}</h3>
      <ul className="flex flex-col gap-2">
        {setups.map((item) => (
          <li key={item.server} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-fg-2">
              {item.label} is not set up on this server, so{" "}
              <span className="font-mono">{item.server}</span> can't be connected.
            </span>
            {user.platform_admin && item.integration ? (
              <Button asChild size="sm">
                <Link to="/admin" search={setupSearch(item.integration, location.href)}>
                  Set up
                </Link>
              </Button>
            ) : (
              <span className="text-xs text-muted">
                A platform admin sets it up under Admin → Platform keys.
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
