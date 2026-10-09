import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { BookOpen, Database, Inbox, Sparkles } from "lucide-react";
import { useState } from "react";
import { useAgentsByGuild, useBrokenEmbeds, useGuilds } from "../../api/queries";
import { agentLook } from "../../app/agents";
import { readStored, writeStored } from "../../app/storage";
import {
  SkeletonRows,
  AgentRow,
  GuildRow,
  Sidebar,
  SidebarSection,
  UtilityLink,
} from "@guildsrun/ui";
import { CreateAgentDialog } from "../agent/CreateAgentDialog";
import { CreateGuildDialog } from "../guild/CreateGuildDialog";
import { AccountMenu } from "./AccountMenu";
import { listedGuilds } from "./guilds";
import { useInboxCount } from "./inbox";

/** Guild ids the operator folded in the sidebar. */
const collapsedKey = "guilds-guilds-collapsed";

function readCollapsed(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(readStored(collapsedKey) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** The full sidebar: guilds with their agents, then the workspace tools and the account. */
export function GuildSidebar({ onRetract }: { onRetract: () => void }) {
  const navigate = useNavigate();
  const { guildId, agentId } = useParams({ strict: false });
  const guilds = useGuilds();
  const listed = listedGuilds(guilds.data);
  const agentsByGuild = useAgentsByGuild(listed.map((guild) => guild.id));
  const brokenEmbeds = useBrokenEmbeds(listed.map((guild) => guild.id));
  const [creatingGuild, setCreatingGuild] = useState(false);
  const [addingTo, setAddingTo] = useState<{ id: string; name: string } | null>(null);
  const inboxCount = useInboxCount();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const setOpen = (id: string, open: boolean) => {
    const next = { ...collapsed, [id]: !open };
    if (open) delete next[id];
    writeStored(collapsedKey, JSON.stringify(next));
    setCollapsed(next);
  };

  return (
    <>
      <Sidebar
        onRetract={onRetract}
        section={
          <SidebarSection
            label="Guilds"
            {...(guilds.data ? { count: listed.length } : {})}
            onAdd={() => setCreatingGuild(true)}
            addLabel="Create a guild"
          />
        }
        footer={
          <>
            <UtilityLink
              asChild
              density="compact"
              icon={Inbox}
              tone="plum"
              title="Inbox"
              {...(inboxCount ? { count: inboxCount } : {})}
            >
              <Link to="/inbox" />
            </UtilityLink>
            <UtilityLink
              asChild
              density="compact"
              icon={Sparkles}
              tone="signal"
              title="Builder"
            >
              <Link to="/builder" />
            </UtilityLink>
            <UtilityLink
              asChild
              density="compact"
              icon={BookOpen}
              tone="plum-tint"
              title="Recipes"
            >
              <Link to="/recipes" />
            </UtilityLink>
            <UtilityLink
              asChild
              density="compact"
              icon={Database}
              tone="signal-tint"
              title="Databases"
            >
              <Link to="/databases" />
            </UtilityLink>
            <AccountMenu />
          </>
        }
      >
        {guilds.isPending ? (
          <SkeletonRows rows={4} label="Loading guilds" />
        ) : (
          listed.map((guild) => {
            const agents = (agentsByGuild.get(guild.id) ?? []).filter(
              (agent) => !agent.archived_at,
            );
            return (
              <GuildRow
                key={guild.id}
                name={guild.name}
                agentCount={agents.length}
                maxAgents={guild.max_agents}
                visibility={guild.visibility}
                selected={guild.id === guildId}
                onSelect={() =>
                  void navigate({ to: "/guilds/$guildId", params: { guildId: guild.id } })
                }
                open={!collapsed[guild.id]}
                onOpenChange={(open) => setOpen(guild.id, open)}
                onAddAgent={() => setAddingTo({ id: guild.id, name: guild.name })}
              >
                {agents.map((agent) => {
                  const look = agentLook(agent);
                  return (
                    <AgentRow
                      key={agent.id}
                      asChild
                      name={agent.name}
                      tone={look.tone}
                      {...(look.src ? { src: look.src } : {})}
                      state={agent.generating ? "running" : "idle"}
                      browser={agent.browser}
                      {...(brokenEmbeds.has(agent.id)
                        ? { brokenLinks: brokenEmbeds.get(agent.id) ?? [] }
                        : {})}
                      selected={agent.id === agentId}
                    >
                      <Link
                        to="/guilds/$guildId/agents/$agentId"
                        params={{ guildId: guild.id, agentId: agent.id }}
                        search={{}}
                      />
                    </AgentRow>
                  );
                })}
              </GuildRow>
            );
          })
        )}
        {guilds.data && listed.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">
            No guilds yet.{" "}
            <Link to="/builder" className="font-semibold text-signal-t underline">
              Start one with the Builder
            </Link>
            .
          </p>
        ) : null}
      </Sidebar>
      <CreateGuildDialog open={creatingGuild} onOpenChange={setCreatingGuild} />
      <CreateAgentDialog guild={addingTo} onClose={() => setAddingTo(null)} />
    </>
  );
}
