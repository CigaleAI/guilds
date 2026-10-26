import { Link, Navigate, Outlet, useParams } from "@tanstack/react-router";
import { Database, FileText, ShieldCheck } from "lucide-react";
import { TabsNav, tabsTrigger, Icon } from "@guildsrun/ui";
/** The State tab's sub-tabs in order, by route. */
const stateTabs = [
  { route: "/guilds/$guildId/state/notes", label: "Notes", icon: FileText },
  { route: "/guilds/$guildId/state/tables", label: "Tables", icon: Database },
  { route: "/guilds/$guildId/state/access", label: "Access", icon: ShieldCheck },
] as const;

/** The guild's State tab: shared notes, the tables its agents reach, and their access, one route per sub-tab. */
export function GuildState() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line px-3 py-2 md:px-6">
        <TabsNav look="track" aria-label="Guild state">
          {stateTabs.map(({ route, label, icon }) => (
            <Link
              key={route}
              to={route}
              params={{ guildId }}
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
export function GuildStateIndex() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  return <Navigate to="/guilds/$guildId/state/notes" params={{ guildId }} replace />;
}
