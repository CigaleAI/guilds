import { ChevronDown, ChevronRight, Plus, RotateCcw } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useId, useState, type ReactNode } from "react";
import {
  useAccess,
  useBulkBindings,
  useConnection,
  useDisconnectServer,
  useInstance,
  useRemoveOrgServer,
  useSetBinding,
} from "../../api/queries";
import type {
  AccessBinding,
  AccessOwner,
  BindingTarget,
  McpServerAccess,
} from "../../api/types";
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

function Pane({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
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
}: {
  owner: AccessOwner;
  hideFamilies?: string[];
  /** Which of the two sections to show. */
  panes?: readonly ToolsPane[];
  /** Agent capabilities that gate browser and coding tools. */
  capabilities?: AgentNativeCapabilities;
  /** The viewer may add and remove the organisation's own remote servers. */
  serverManager?: boolean;
}) {
  const copy = scopeCopy(owner);
  const access = useAccess(owner);
  const setBinding = useSetBinding(owner);
  const bulk = useBulkBindings(owner);
  const connect = useServerConnect(owner);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<McpServerAccess | null>(null);
  const removeServer = useRemoveOrgServer(owner.id);
  const disconnect = useDisconnectServer();
  const [pane, setPane] = useState<ToolsPane>(panes[0] ?? "connections");
  const switcher = panes.length > 1;
  const [disconnecting, setDisconnecting] = useState<{
    server: McpServerAccess;
    connectionId: string;
  } | null>(null);
  const bindingsOfLogin = useConnection(disconnecting?.connectionId ?? null);

  const instance = useInstance();
  const busy = setBinding.isPending || bulk.isPending || connect.busy || disconnect.isPending;

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
  const bindingCount = bindingsOfLogin.data?.bindings?.length;

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
        <Pane
          title="Integrations"
          description="Remote tools the orchestrator calls with a login it holds; keys never reach an agent's machine. Logins inherited from wider scopes appear here: turn a server off, or sign in with a login of its own."
        >
          <div className="flex flex-col gap-3">
            {serverManager && owner.scope === "org" ? (
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <Icon icon={Plus} size={14} />
                  Add a remote server
                </Button>
              </div>
            ) : null}
            {connectable(mcp, owner).map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                owner={owner}
                busy={busy || removeServer.isPending}
                {...(serverManager && owner.scope === "org" && server.org_owned
                  ? { onRemove: () => setRemoving(server) }
                  : {})}
                onServerEnabled={(enabled) =>
                  toggle({ kind: "mcp", id: server.id }, server, enabled)
                }
                onToolEnabled={(name, enabled) => {
                  const tool = server.tools.find((item) => item.name === name);
                  if (tool) toggle({ kind: "mcp_tool", id: name }, tool, enabled);
                }}
                onBulk={(names, enabled) =>
                  bulk.mutate(
                    { targets: names.map((id) => ({ kind: "mcp_tool" as const, id })), enabled },
                    { onError: failed(`Couldn't update ${server.name}'s tools`) },
                  )
                }
                onConnect={() => connect.start(server)}
                onDisconnect={(connectionId) => setDisconnecting({ server, connectionId })}
              />
            ))}
          </div>
          {owner.scope === "org" ? (
            <OrgServerDialog orgId={owner.id} open={adding} onClose={() => setAdding(false)} />
          ) : null}
        </Pane>
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
      <ConfirmDialog
        kind="destructive"
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? ""}?`}
        description="This removes the server for the whole organisation, with every login to it and the bindings that use them."
        confirmLabel="Remove server"
        onConfirm={() =>
          removing
            ? removeServer.mutateAsync(removing.id).then(
                () => {
                  toast({ kind: "success", title: `${removing.name} removed` });
                  setRemoving(null);
                },
                (error: Error) => {
                  failed(`Couldn't remove ${removing.name}`)(error);
                  throw error;
                },
              )
            : undefined
        }
      />
      <ConfirmDialog
        kind="destructive"
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.server.name ?? ""}?`}
        description={`${
          bindingCount === undefined
            ? "This removes the login."
            : `This removes the login and ${bindingCount} binding${bindingCount === 1 ? "" : "s"} that use it.`
        } Its tools go back to the login inherited from a wider scope, if there is one.`}
        confirmLabel="Disconnect"
        onConfirm={() =>
          disconnecting
            ? disconnect.mutateAsync(disconnecting.connectionId).then(
                () => {
                  toast({ kind: "success", title: `${disconnecting.server.name} disconnected` });
                  setDisconnecting(null);
                },
                (error: Error) => {
                  failed(`Couldn't disconnect ${disconnecting.server.name}`)(error);
                  throw error;
                },
              )
            : undefined
        }
      />
    </Frame>
  );
}

function NativeFamily({
  label,
  count,
  defaultOpen,
  children,
}: {
  label: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
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

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
      <div className="mx-auto flex max-w-240 flex-col gap-6">{children}</div>
    </div>
  );
}
