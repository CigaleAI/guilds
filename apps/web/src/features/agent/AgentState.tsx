import { Link, Navigate, Outlet, useParams } from "@tanstack/react-router";
import { BookOpen, Brain, Database, FileCode, FolderTree } from "lucide-react";
import { useAgent } from "../../api/queries";
import { TabsNav, tabsTrigger, Icon } from "@guildsrun/ui";
import { capabilityOn } from "./settings/configForm";

/** The State tab's sub-tabs in order, by route. */
const stateTabs = [
  { route: "/guilds/$guildId/agents/$agentId/state/memory", label: "Memory", icon: Brain },
  { route: "/guilds/$guildId/agents/$agentId/state/notes", label: "Notes", icon: BookOpen },
  {
    route: "/guilds/$guildId/agents/$agentId/state/databases",
    label: "Databases",
    icon: Database,
  },
  {
    route: "/guilds/$guildId/agents/$agentId/state/scripts",
    label: "Scripts",
    icon: FileCode,
    capability: "scripting",
  },
  {
    route: "/guilds/$guildId/agents/$agentId/state/artifacts",
    label: "Artifact scope",
    icon: FolderTree,
  },
] as const;

/** The agent's State tab: what it keeps between runs, and how far it reaches, one route per sub-tab. */
export function AgentState() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const agent = useAgent(agentId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line px-3 py-2 md:px-6">
        <TabsNav look="track" aria-label="Agent state">
          {stateTabs
            .filter(
              (tab) => !("capability" in tab) || capabilityOn(agent.data?.config, tab.capability),
            )
            .map(({ route, label, icon }) => (
              <Link
                key={route}
                to={route}
                params={{ guildId, agentId }}
                search={{}}
                className={tabsTrigger({ look: "track" })}
              >
                <Icon icon={icon} size={14} />
                {label}
              </Link>
            ))}
        </TabsNav>
      </div>
      <Outlet />
    </div>
  );
}

/** `…/state` on its own opens the first sub-tab. */
export function AgentStateIndex() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  return (
    <Navigate
      to="/guilds/$guildId/agents/$agentId/state/memory"
      params={{ guildId, agentId }}
      search={{}}
      replace
    />
  );
}
