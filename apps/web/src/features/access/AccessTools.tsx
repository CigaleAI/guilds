import { ChevronDown, ChevronRight, Plus, RotateCcw } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useId, useState, type ReactNode } from "react";
import {
  useAccess,
  useBulkBindings,
  useConnection,
  useDisconnectServer,
  useRemoveOrgServer,
  useSetBinding,
} from "../../api/queries/access";
import { useInstance } from "../../api/queries/admin";
import type {
  AccessBinding,
  AccessOwner,
  BindingsChange,
  BindingTarget,
  McpServerAccess,
} from "../../api/types/access";
import {
  Button,
  IconButton,
  Segmented,
  ToolRow,
  Banner,
  SkeletonRows,
  ConfirmDialog,
  toast,
  cn,
  Icon,
} from "@guildsrun/ui";
import {
  bindingOrigin,
  canResetFirst,
  isCapabilityNativeTool,
  nativeToolDisplay,
  toolFamilyGroups,
  withCapabilityNativeTools,
  type AgentNativeCapabilities,
} from "./access";
import { useServerConnect } from "./ConnectDialogs";
import { OrgServerDialog } from "./OrgServerDialog";
import { scopeCopy } from "./scopeCopy";
import { ServerCard } from "./ServerCard";

type ToolsPane = "builtin" | "connections";

const allPanes: readonly ToolsPane[] = ["connections", "builtin"];
const paneOptions: { value: ToolsPane; label: string }[] = [
  { value: "connections", label: "Integrations" },
  { value: "builtin", label: "Native tools" },
];

type PaneProps = {
  title: string;
  description: string;
  children: ReactNode;
};

function Pane({ title, description, children }: PaneProps) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">{description}</p>
      {children}
    </section>
  );
}

/** The servers a scope can sign in to. */
function connectable<T extends { slug: string }>(servers: T[], _owner: AccessOwner): T[] {
  return servers;
}

type AccessToolsProps = {
  owner: AccessOwner;
  hideFamilies?: string[];
  /** Which of the two sections to show. */
  panes?: readonly ToolsPane[];
  /** Agent capabilities that gate browser and coding tools. */
  capabilities?: AgentNativeCapabilities;
  /** The viewer may add and remove the organisation's own remote servers. */
  serverManager?: boolean;
};

/**
 * What a scope's agents can use: integrations and native tools. Each switch sets the scope's own binding over what it inherits from wider scopes,
 * organisation and the platform; runs take the tools as they are when they start.
 */
export function AccessTools({
  owner,
  hideFamilies = [],
  panes = allPanes,
  capabilities,
  serverManager = false,
}: AccessToolsProps) {
  const copy = scopeCopy(owner);
  const access = useAccess(owner);
  const setBinding = useSetBinding(owner);
  const bulk = useBulkBindings(owner);
  const connect = useServerConnect(owner);
  const [pane, setPane] = useState<ToolsPane>(panes[0] ?? "connections");
  const switcher = panes.length > 1;

  const instance = useInstance();
  const busy = setBinding.isPending || bulk.isPending || connect.busy;

  const failed = (title: string) => (error: Error) =>
    toast({ kind: "error", title, description: error.message });

  const toggle = (
    target: BindingTarget,
    item: Pick<AccessBinding, "enabled" | "overlay">,
    enabled: boolean,
  ) => {
    if (item.enabled === enabled) return;
    setBinding.mutate(
      {
        target,
        enabled,
        resetFirst: canResetFirst(item),
      },
      {
        onError: failed(
          enabled ? `Couldn't turn on ${target.id}` : `Couldn't turn off ${target.id}`,
        ),
      },
    );
  };

  if (access.isPending) {
    return (
      <Frame>
        <SkeletonRows rows={6} label="Loading tools" />
      </Frame>
    );
  }
  if (access.isError) {
    return (
      <Frame>
        <Banner
          tone="error"
          title="Couldn't load the tools"
          meta={access.error.message}
          action={
            <Button variant="outline" size="sm" onClick={() => void access.refetch()}>
              Retry
            </Button>
          }
        />
      </Frame>
    );
  }

  const { tools, mcp } = access.data;

  const renderBinding = (item: AccessBinding, target: BindingTarget) => {
    const origin = bindingOrigin(item, owner.scope);
    const display = nativeToolDisplay(item, owner.scope, capabilities, instance.data);
    return (
      <ToolRow
        key={item.name}
        name={item.name}
        enabled={display.enabled}
        {...(display.caption ? { caption: display.caption } : {})}
        {...(display.bindable && item.source_scope ? { source: item.source_scope } : {})}
        {...(display.bindable && origin ? { origin } : {})}
        {...(display.bindable
          ? {
              onEnabledChange: (enabled: boolean) => toggle(target, item, enabled),
              disabled: busy,
            }
          : {})}
        {...(display.bindable && canResetFirst(item)
          ? {
              actions: (
                <IconButton
                  icon={RotateCcw}
                  label={`Reset ${item.name} to what ${copy.subject} inherits`}
                  variant="ghost"
                  size={28}
                  disabled={busy}
                  onClick={() =>
                    bulk.mutate(
                      { targets: [target], enabled: "inherit" },
                      { onError: failed(`Couldn't reset ${item.name}`) },
                    )
                  }
                />
              ),
            }
          : {})}
      />
    );
  };

  return (
    <Frame>
      <p className="text-sm text-fg-2">
        {copy.switchesIntro} A run starts with the tools of that moment. Turning a tool off drops it
        from later turns.
      </p>

      {switcher ? (
        <Segmented
          size="sm"
          label="Tools section"
          value={pane}
          onValueChange={setPane}
          options={paneOptions.filter((option) => panes.includes(option.value))}
        />
      ) : null}

      {pane === "connections" ? (
        <IntegrationsPane
          owner={owner}
          servers={mcp}
          serverManager={serverManager}
          busy={busy}
          onToggle={toggle}
          onBulk={(server, names, enabled) =>
            bulk.mutate(
              { targets: names.map((id) => ({ kind: "mcp_tool" as const, id })), enabled },
              { onError: failed(`Couldn't update ${server.name}'s tools`) },
            )
          }
          onConnect={connect.start}
        />
      ) : (
        <Pane
          title="Native tools"
          description="Notes, tables, memory, scripts, routines, group chat and secrets, served by the orchestrator; browser and coding follow the agent's capabilities. No login to connect."
        >
          <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
            {toolFamilyGroups(withCapabilityNativeTools(tools, capabilities))
              .filter((group) => !hideFamilies.includes(group.label))
              .map((group) => (
                <NativeFamily
                  key={group.label}
                  label={group.label}
                  count={group.tools.length}
                  defaultOpen={!group.tools.every((tool) => isCapabilityNativeTool(tool.name))}
                >
                  {group.tools.map((tool) =>
                    renderBinding(tool, { kind: "native_tool", id: tool.name }),
                  )}
                </NativeFamily>
              ))}
          </div>
        </Pane>
      )}

      {connect.dialogs}
    </Frame>
  );
}

type IntegrationsPaneProps = {
  owner: AccessOwner;
  servers: McpServerAccess[];
  /** The viewer may add and remove the organisation's own remote servers. */
  serverManager: boolean;
  /** A binding change or a sign-in is in flight. */
  busy: boolean;
  onToggle: (
    target: BindingTarget,
    item: Pick<AccessBinding, "enabled" | "overlay">,
    enabled: boolean,
  ) => void;
  onBulk: (server: McpServerAccess, names: string[], enabled: BindingsChange["enabled"]) => void;
  onConnect: (server: McpServerAccess) => void;
};

/**
 * The servers the scope reaches, a card each, with adding, removing and disconnecting one: the
 * organisation's own servers only where the viewer manages them.
 */
function IntegrationsPane({
  owner,
  servers,
  serverManager,
  busy,
  onToggle,
  onBulk,
  onConnect,
}: IntegrationsPaneProps) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<McpServerAccess | null>(null);
  const [disconnecting, setDisconnecting] = useState<{
    server: McpServerAccess;
    connectionId: string;
  } | null>(null);
  const removeServer = useRemoveOrgServer(owner.id);
  const disconnect = useDisconnectServer();
  const manages = serverManager && owner.scope === "org";
  const cardsBusy = busy || disconnect.isPending || removeServer.isPending;

  return (
    <Pane
      title="Integrations"
      description="Remote tools the orchestrator calls with a login it holds; keys never reach an agent's machine. Logins inherited from wider scopes appear here: turn a server off, or sign in with a login of its own."
    >
      <div className="flex flex-col gap-3">
        {manages ? (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Icon icon={Plus} size={14} />
              Add a remote server
            </Button>
          </div>
        ) : null}
        {connectable(servers, owner).map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            owner={owner}
            busy={cardsBusy}
            {...(manages && server.org_owned ? { onRemove: () => setRemoving(server) } : {})}
            onServerEnabled={(enabled) => onToggle({ kind: "mcp", id: server.id }, server, enabled)}
            onToolEnabled={(name, enabled) => {
              const tool = server.tools.find((item) => item.name === name);
              if (tool) onToggle({ kind: "mcp_tool", id: name }, tool, enabled);
            }}
            onBulk={(names, enabled) => onBulk(server, names, enabled)}
            onConnect={() => onConnect(server)}
            onDisconnect={(connectionId) => setDisconnecting({ server, connectionId })}
          />
        ))}
      </div>
      {owner.scope === "org" ? (
        <OrgServerDialog orgId={owner.id} open={adding} onClose={() => setAdding(false)} />
      ) : null}
      <RemoveServerDialog
        server={removing}
        onClose={() => setRemoving(null)}
        remove={removeServer.mutateAsync}
      />
      <DisconnectDialog
        login={disconnecting}
        onClose={() => setDisconnecting(null)}
        disconnect={disconnect.mutateAsync}
      />
    </Pane>
  );
}

type RemoveServerDialogProps = {
  /** The organisation's own server to remove; null keeps the dialog closed. */
  server: McpServerAccess | null;
  onClose: () => void;
  /** Removes a server by its id; rejects when the removal fails. */
  remove: (serverId: string) => Promise<unknown>;
};

/** Asks before removing an organisation's own server with every login to it. */
function RemoveServerDialog({ server, onClose, remove }: RemoveServerDialogProps) {
  return (
    <ConfirmDialog
      kind="destructive"
      open={server !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Remove ${server?.name ?? ""}?`}
      description="This removes the server for the whole organisation, with every login to it and the bindings that use them."
      confirmLabel="Remove server"
      onConfirm={() =>
        server
          ? remove(server.id).then(
              () => {
                toast({ kind: "success", title: `${server.name} removed` });
                onClose();
              },
              (error: Error) => {
                toast({
                  kind: "error",
                  title: `Couldn't remove ${server.name}`,
                  description: error.message,
                });
                throw error;
              },
            )
          : undefined
      }
    />
  );
}

type DisconnectDialogProps = {
  /** The server and the scope's own login to it; null keeps the dialog closed. */
  login: { server: McpServerAccess; connectionId: string } | null;
  onClose: () => void;
  /** Deletes a login by its id; rejects when the deletion fails. */
  disconnect: (connectionId: string) => Promise<unknown>;
};

/** Asks before deleting the scope's own login to a server, counting the bindings that use it. */
function DisconnectDialog({ login, onClose, disconnect }: DisconnectDialogProps) {
  const bindingsOfLogin = useConnection(login?.connectionId ?? null);
  const bindingCount = bindingsOfLogin.data?.bindings?.length;
  return (
    <ConfirmDialog
      kind="destructive"
      open={login !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Disconnect ${login?.server.name ?? ""}?`}
      description={`${
        bindingCount === undefined
          ? "This removes the login."
          : `This removes the login and ${bindingCount} binding${bindingCount === 1 ? "" : "s"} that use it.`
      } Its tools go back to the login inherited from a wider scope, if there is one.`}
      confirmLabel="Disconnect"
      onConfirm={() =>
        login
          ? disconnect(login.connectionId).then(
              () => {
                toast({ kind: "success", title: `${login.server.name} disconnected` });
                onClose();
              },
              (error: Error) => {
                toast({
                  kind: "error",
                  title: `Couldn't disconnect ${login.server.name}`,
                  description: error.message,
                });
                throw error;
              },
            )
          : undefined
      }
    />
  );
}

type NativeFamilyProps = {
  label: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
};

function NativeFamily({ label, count, defaultOpen, children }: NativeFamilyProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="flex flex-col border-b border-line last:border-b-0"
    >
      <Collapsible.Trigger
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left hover:bg-paper",
          open && "border-b border-line",
        )}
        aria-controls={open ? bodyId : undefined}
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} className="text-muted" />
        <span className="type-label text-muted">{label}</span>
        <span className="ml-auto text-xs tabular-nums text-muted">{count}</span>
      </Collapsible.Trigger>
      <Collapsible.Content id={bodyId}>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

type FrameProps = { children: ReactNode };

function Frame({ children }: FrameProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-6">{children}</div>
    </div>
  );
}
