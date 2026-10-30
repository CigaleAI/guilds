import { Link, Outlet, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  CircleDollarSign,
  FilePen,
  Globe,
  KeyRound,
  Layers,
  Maximize2,
  MessageSquare,
  Minimize2,
  Repeat,
  Settings,
  SquareTerminal,
  Trash2,
  Unlink,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { useFinishedChatIdleClose } from "./chat/chatLinger";
import { useAgent, useDeleteAgent } from "../../api/queries/agents";
import { useBrokenEmbeds } from "../../api/queries/notes";
import { agentLook } from "../../app/agents";
import { ReturnButton } from "../../app/ReturnButton";
import { useMediaQuery, wideScreen } from "../../app/media";
import { readStored, writeStored } from "../../app/storage";
import {
  IconButton,
  TabsNav,
  tabsTrigger,
  PageError,
  SkeletonRows,
  AgentHeader,
  ConfirmDialog,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  toast,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  Icon,
} from "@guildsrun/ui";
import { BrowserLoginStrip } from "./BrowserLoginStrip";
import { CodingNotReadyButton } from "./CodingReadiness";
import { CodingStrip } from "./CodingStrip";
import { ChatSessionChrome } from "./chat/SessionChrome";
import { capabilityOn } from "./settings/configForm";

/** The inspector as a sheet ("modal") or the whole window ("full"), remembered across visits. */
const viewModeKey = "guilds-agent-view-mode";

/** The inspector's tabs in order, by route. */
const tabs = [
  { route: "/guilds/$guildId/agents/$agentId", label: "Chat", icon: MessageSquare },
  { route: "/guilds/$guildId/agents/$agentId/prompt", label: "Prompt", icon: FilePen },
  { route: "/guilds/$guildId/agents/$agentId/state", label: "State", icon: Layers },
  { route: "/guilds/$guildId/agents/$agentId/routine", label: "Routine", icon: Repeat },
  {
    route: "/guilds/$guildId/agents/$agentId/browser",
    label: "Browser",
    icon: Globe,
    capability: "browser",
  },
  {
    route: "/guilds/$guildId/agents/$agentId/cli",
    label: "CLI",
    icon: SquareTerminal,
  },
  { route: "/guilds/$guildId/agents/$agentId/tools", label: "Tools", icon: Wrench },
  { route: "/guilds/$guildId/agents/$agentId/secrets", label: "Secrets", icon: KeyRound },
  { route: "/guilds/$guildId/agents/$agentId/usage", label: "Usage", icon: CircleDollarSign },
  { route: "/guilds/$guildId/agents/$agentId/settings", label: "Settings", icon: Settings },
] as const;

/** One agent, over its guild's page: who it is, what it is doing, the open tab, and Chat's session. */
export function AgentInspector() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const navigate = useNavigate();
  const wide = useMediaQuery(wideScreen);
  const onChat = Boolean(useMatchRoute()({ to: "/guilds/$guildId/agents/$agentId", fuzzy: false }));
  const agent = useAgent(agentId);
  const broken = useBrokenEmbeds([guildId]).get(agentId) ?? [];
  const [full, setFull] = useState(() => readStored(viewModeKey) === "full");
  const [deleting, setDeleting] = useState(false);
  const removeAgent = useDeleteAgent(guildId);

  const toggleFull = () => {
    writeStored(viewModeKey, full ? "modal" : "full");
    setFull(!full);
  };
  const close = () => void navigate({ to: "/guilds/$guildId", params: { guildId } });
  useFinishedChatIdleClose(agentId, Boolean(agent.data?.generating), onChat, close);

  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent expanded={full} aria-describedby={undefined} data-return-source="">
        {agent.data ? (
          <>
            <SheetTitle className="sr-only">{agent.data.name}</SheetTitle>
            <AgentHeader
              compact={!wide}
              name={agent.data.name}
              {...agentLook(agent.data)}
              state={agent.data.generating ? "running" : "idle"}
              {...(agent.data.focus ? { focus: agent.data.focus } : {})}
              actions={
                <>
                  {broken.length ? (
                    <IconButton
                      icon={Unlink}
                      label={`Not reachable from the Task: ${broken.join(", ")}`}
                      title={`Not reachable from the Task: ${broken.join(", ")}`}
                      variant="surface"
                      className="text-t-ochre-fg"
                      onClick={() =>
                        void navigate({
                          to: "/guilds/$guildId/agents/$agentId/prompt",
                          params: { guildId, agentId },
                        })
                      }
                    />
                  ) : null}
                  {agent.data.config.coding ? (
                    <CodingNotReadyButton guildId={guildId} agentId={agentId} />
                  ) : null}
                  {wide ? (
                    <IconButton
                      icon={full ? Minimize2 : Maximize2}
                      label={full ? "Show as a sheet" : "Fill the window"}
                      variant="surface"
                      onClick={toggleFull}
                    />
                  ) : null}
                  <Menu modal={false}>
                    <MenuTrigger variant="surface" label="Agent options" />
                    <MenuContent>
                      <MenuItem icon={Trash2} destructive onSelect={() => setDeleting(true)}>
                        Delete agent
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                  <SheetClose asChild>
                    <IconButton icon={X} label="Close" variant="ink" />
                  </SheetClose>
                </>
              }
            />
            <div className="flex min-w-0 shrink-0 items-center border-y border-line bg-surface">
              <TabsNav aria-label="Agent pages" className="min-w-0 w-auto flex-1 border-y-0">
                {tabs
                  .filter(
                    (tab) =>
                      !("capability" in tab) || capabilityOn(agent.data?.config, tab.capability),
                  )
                  .map(({ route, label, icon }) => (
                    <Link
                      key={route}
                      to={route}
                      params={{ guildId, agentId }}
                      search={{}}
                      {...(route === "/guilds/$guildId/agents/$agentId"
                        ? { activeOptions: { exact: true, includeSearch: false } }
                        : {})}
                      className={tabsTrigger({ look: "bar" })}
                    >
                      <Icon icon={icon} size={16} />
                      {label}
                    </Link>
                  ))}
              </TabsNav>
              {onChat ? <ChatSessionChrome /> : null}
            </div>
            {onChat && agent.data.config.coding ? (
              <CodingStrip guildId={guildId} agentId={agentId} />
            ) : null}
            {agent.data.config.browser ? (
              <BrowserLoginStrip guildId={guildId} agentId={agentId} />
            ) : null}
            <ReturnButton />
            <Outlet />
          </>
        ) : agent.isError ? (
          <div className="grid flex-1 place-items-center p-6">
            <SheetTitle className="sr-only">Agent</SheetTitle>
            <PageError title="Couldn't load this agent" description={agent.error.message} />
          </div>
        ) : (
          <div className="p-8">
            <SheetTitle className="sr-only">Loading agent</SheetTitle>
            <SkeletonRows rows={4} label="Loading agent" />
          </div>
        )}
      </SheetContent>
      <ConfirmDialog
        kind="destructive"
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${agent.data?.name ?? "this agent"}?`}
        description="Its sessions, routines, notes, home and usage row are removed; its posts stay in the group chat. This can't be undone."
        confirmLabel="Delete agent"
        {...(agent.data ? { confirmText: agent.data.name } : {})}
        onConfirm={() =>
          removeAgent.mutateAsync(agentId).then(
            () => {
              toast({ kind: "success", title: `${agent.data?.name ?? "Agent"} deleted` });
              close();
            },
            (error: Error) => {
              toast({
                kind: "error",
                title: "Couldn't delete the agent",
                description: error.message,
              });
              throw error;
            },
          )
        }
      />
    </Sheet>
  );
}
