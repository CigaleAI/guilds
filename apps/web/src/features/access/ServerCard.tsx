import { Link, useLocation } from "@tanstack/react-router";
import { Link2, Play, Trash2, Unlink } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { lookupWithLogin, useSaveSettings } from "../../api/queries/access";
import { useInstance } from "../../api/queries/admin";
import type { AccessOwner, McpServerAccess, McpToolAccess } from "../../api/types/access";
import { useIdentity } from "../../app/identity";
import { Button, FilterBar, IntegrationCard, Tag, ToolRow, toast, Icon } from "@guildsrun/ui";
import { connectorSetupGap, setupSearch, type ConnectorSetupGap } from "../instance/instance";
import {
  bindingOrigin,
  canTestLogin,
  connectionStatus,
  filterTools,
  loginSettingsPanel,
  ownedConnection,
  serverOriginLabel,
  type ToolFilter,
} from "./access";
import { connectorLogo } from "./connectorLogo";
import { GithubSettings } from "./GithubRepositories";
import { SettingsForm, type SettingsValue } from "./SettingsForm";
import { TestConnectionDialog } from "./TestConnectionDialog";

type ServerCardProps = {
  server: McpServerAccess;
  owner: AccessOwner;
  busy: boolean;
  onServerEnabled: (enabled: boolean) => void;
  onToolEnabled: (toolName: string, enabled: boolean) => void;
  onBulk: (toolNames: string[], enabled: boolean | "inherit") => void;
  onConnect: () => void;
  onDisconnect: (connectionId: string) => void;
  /** Removes one of the organisation's own servers; absent for the rest. */
  onRemove?: () => void;
};

/** One connected-tools server at the scope being edited: its login, a Test call, its On/Off, and its tools behind a toggle. */
export function ServerCard({
  server,
  owner,
  busy,
  onServerEnabled,
  onToolEnabled,
  onBulk,
  onConnect,
  onDisconnect,
  onRemove,
}: ServerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ToolFilter>("all");
  const [testing, setTesting] = useState<McpToolAccess | "pick" | null>(null);

  const instance = useInstance();
  const setupGap = connectorSetupGap(server, instance.data);
  const owned = ownedConnection(server, owner.scope);
  const active = server.tools.filter((tool) => tool.enabled).length;
  const canTest = canTestLogin(server);
  const status = connectionStatus(server);
  const logo = connectorLogo(server.logo_url);
  const panel = loginSettingsPanel(server);

  return (
    <>
      <IntegrationCard
        tone="surface"
        name={server.name}
        description={serverDescription(server, setupGap)}
        {...(logo ? { logo, logoTone: "paper" } : {})}
        {...(status ? { status } : {})}
        {...(server.account_hint ? { accountHint: server.account_hint } : {})}
        enabled={server.enabled}
        {...(server.source_scope ? { source: server.source_scope } : {})}
        onEnabledChange={(enabled: boolean) => {
          if (enabled) setExpanded(true);
          onServerEnabled(enabled);
        }}
        switchDisabled={busy}
        actions={
          <ServerActions
            server={server}
            busy={busy}
            canTest={canTest}
            owned={owned}
            setupGap={setupGap}
            onTest={() =>
              setTesting(server.tools.length === 1 ? (server.tools[0] ?? "pick") : "pick")
            }
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onRemove={onRemove}
          />
        }
        {...(server.tools.length ? { tools: { active, total: server.tools.length } } : {})}
        expanded={expanded}
        onExpandedChange={setExpanded}
        {...(panel
          ? {
              settings:
                panel.kind === "schema" ? (
                  <LoginSettings
                    key={server.connection_id}
                    server={server}
                    schema={panel.schema}
                    owned={owned}
                  />
                ) : (
                  <GithubSettings server={server} owned={owned} />
                ),
            }
          : {})}
      >
        {expanded ? (
          <ServerTools
            server={server}
            owner={owner}
            busy={busy}
            canTest={canTest}
            query={query}
            onQueryChange={setQuery}
            filter={filter}
            onFilterChange={setFilter}
            onToolEnabled={onToolEnabled}
            onBulk={onBulk}
            onTest={setTesting}
          />
        ) : null}
      </IntegrationCard>
      <TestConnectionDialog
        server={server}
        tool={testing === "pick" ? null : testing}
        open={testing !== null}
        onOpenChange={(open) => !open && setTesting(null)}
      />
    </>
  );
}

/**
 * A server's description, with tags for where it comes from and the note when its sign-in cannot
 * start on this box; the bare description when it has neither.
 */
function serverDescription(server: McpServerAccess, setupGap: ConnectorSetupGap | null): ReactNode {
  const origin = serverOriginLabel(server);
  if (!origin && !server.experimental && !setupGap) return server.description;
  return (
    <>
      {server.description}
      {origin || server.experimental ? (
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
          {origin ? (
            <Tag tone={server.verified ? "tide" : "ochre"} font="sans">
              {origin}
            </Tag>
          ) : null}
          {server.experimental ? (
            <Tag tone="ochre" font="sans">
              Experimental
            </Tag>
          ) : null}
          {server.publisher ? <span className="text-muted">{server.publisher}</span> : null}
        </span>
      ) : null}
      {setupGap ? <SetupGapNote setupGap={setupGap} /> : null}
    </>
  );
}

type SetupGapNoteProps = { setupGap: ConnectorSetupGap };

/** Why a server's sign-in cannot start on this box, with the way to set it up for a platform admin. */
function SetupGapNote({ setupGap }: SetupGapNoteProps) {
  const { user } = useIdentity();
  const location = useLocation();
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
      <Tag tone="ochre" font="sans">
        Not set up
      </Tag>
      {setupGap.text}
      {user.platform_admin && setupGap.integration ? (
        <Link
          to="/admin"
          search={setupSearch(setupGap.integration, location.href)}
          className="underline"
        >
          Set up
        </Link>
      ) : null}
    </span>
  );
}

type ServerActionsProps = {
  server: McpServerAccess;
  busy: boolean;
  canTest: boolean;
  /** The scope's own login, which it may disconnect; null when the login is inherited or absent. */
  owned: string | null;
  setupGap: ConnectorSetupGap | null;
  onTest: () => void;
  onConnect: () => void;
  onDisconnect: (connectionId: string) => void;
  /** Removes one of the organisation's own servers; undefined for the rest. */
  onRemove: (() => void) | undefined;
};

/** A server card's buttons: a Test call, the scope's own sign-in or its disconnect, and removing an org's own server. */
function ServerActions({
  server,
  busy,
  canTest,
  owned,
  setupGap,
  onTest,
  onConnect,
  onDisconnect,
  onRemove,
}: ServerActionsProps) {
  return (
    <>
      <Button
        variant="outline"
        size="md"
        onClick={onTest}
        disabled={busy || !canTest}
        title={canTest ? "Call a function on this login" : "Connect to test"}
      >
        <Icon icon={Play} size={14} />
        Test
      </Button>
      {owned ? (
        <Button variant="outline" size="md" onClick={() => onDisconnect(owned)} disabled={busy}>
          <Icon icon={Unlink} size={14} />
          Disconnect
        </Button>
      ) : (
        <Button
          variant="outline"
          size="md"
          onClick={onConnect}
          disabled={busy || setupGap !== null}
          title={
            setupGap?.text ??
            (server.connection_id
              ? "Sign in with a login of its own instead of the inherited one"
              : "Sign in to this server")
          }
        >
          <Icon icon={Link2} size={14} />
          {server.connection_id ? "Use own login" : "Connect"}
        </Button>
      )}
      {onRemove ? (
        <Button variant="ghost" size="md" onClick={onRemove} disabled={busy}>
          <Icon icon={Trash2} size={14} />
          Remove server
        </Button>
      ) : null}
    </>
  );
}

type ServerToolsProps = {
  server: McpServerAccess;
  owner: AccessOwner;
  busy: boolean;
  canTest: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  filter: ToolFilter;
  onFilterChange: (filter: ToolFilter) => void;
  onToolEnabled: (toolName: string, enabled: boolean) => void;
  onBulk: (toolNames: string[], enabled: boolean | "inherit") => void;
  onTest: (tool: McpToolAccess) => void;
};

/** An expanded card's tools: filtered by name and state, switched one by one or all at once. */
function ServerTools({
  server,
  owner,
  busy,
  canTest,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  onToolEnabled,
  onBulk,
  onTest,
}: ServerToolsProps) {
  const active = server.tools.filter((tool) => tool.enabled).length;
  const listed = filterTools(server.tools, query, filter);
  const overridden = server.tools.filter((tool) => tool.overlay).map((tool) => tool.name);
  return (
    <div className="flex flex-col">
      <FilterBar
        className="border-b border-line p-3"
        size="sm"
        query={query}
        onQueryChange={onQueryChange}
        placeholder={`Filter ${server.tools.length} tools…`}
        searchLabel={`Filter ${server.name} tools`}
        searchTone="surface"
        filter={{
          value: filter,
          onValueChange: onFilterChange,
          label: "Tool state",
          options: [
            { value: "all", label: "All", count: server.tools.length },
            { value: "active", label: "Active", count: active },
            { value: "disabled", label: "Disabled", count: server.tools.length - active },
          ],
        }}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                onBulk(
                  listed.map((tool) => tool.name),
                  true,
                )
              }
            >
              Enable all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                onBulk(
                  listed.map((tool) => tool.name),
                  false,
                )
              }
            >
              Disable all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || overridden.length === 0}
              onClick={() => onBulk(overridden, "inherit")}
            >
              Reset to inherit
            </Button>
          </>
        }
      />
      {listed.length ? (
        listed.map((tool) => {
          const origin = bindingOrigin(tool, owner.scope);
          return (
            <ToolRow
              key={tool.name}
              name={tool.name}
              description={tool.description}
              enabled={tool.enabled}
              {...(tool.source_scope ? { source: tool.source_scope } : {})}
              {...(origin ? { origin } : {})}
              onEnabledChange={(enabled) => onToolEnabled(tool.name, enabled)}
              disabled={busy}
              {...(canTest ? { onNameClick: () => onTest(tool) } : {})}
            />
          );
        })
      ) : (
        <p className="px-4 py-5 text-sm text-muted">No tools match the current filter.</p>
      )}
    </div>
  );
}

type LoginSettingsProps = {
  server: McpServerAccess;
  schema: Record<string, unknown>;
  owned: string | null;
};

/**
 * What the login stores beside its credentials, as its connector's schema describes it. The
 * scope that owns the login edits and saves it; an inherited login's settings are read-only.
 */
function LoginSettings({ server, schema, owned }: LoginSettingsProps) {
  const connectionId = owned ?? server.connection_id ?? "";
  const save = useSaveSettings(connectionId);
  const [draft, setDraft] = useState<SettingsValue>(server.settings);
  const search = useCallback(
    (property: string, query: string) => lookupWithLogin(connectionId, property, query),
    [connectionId],
  );
  const changed = JSON.stringify(draft) !== JSON.stringify(server.settings);
  return (
    <div className="flex flex-col gap-3">
      {server.needs_settings ? (
        <p className="text-sm text-fg-2">Signed in. Save these settings to finish connecting.</p>
      ) : null}
      {!owned ? (
        <p className="text-xs text-muted">
          Set on the inherited login. Connect here to use your own.
        </p>
      ) : null}
      <SettingsForm
        schema={schema}
        value={draft}
        search={search}
        disabled={save.isPending}
        {...(owned ? { onChange: setDraft } : {})}
      />
      {owned ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={save.isPending || (!changed && !server.needs_settings)}
            onClick={() =>
              save.mutate(draft, {
                onSuccess: () => toast({ kind: "success", title: `${server.name} settings saved` }),
                onError: (error) =>
                  toast({
                    kind: "error",
                    title: "Couldn't save the settings",
                    description: error.message,
                  }),
              })
            }
          >
            {server.needs_settings ? "Save and connect" : "Save settings"}
          </Button>
          {changed ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setDraft(server.settings)}
            >
              Discard
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
