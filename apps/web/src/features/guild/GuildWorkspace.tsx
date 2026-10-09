import {
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { BookmarkPlus, SearchX, Settings, Sparkles, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import {
  useCaptureRecipe,
  useGroupChatState,
  useGuild,
  useGuildAgents,
  useOpenIssues,
  useStudioSessions,
} from "../../api/queries";
import { useGuildStream } from "../../api/streams";
import { agentLook } from "../../app/agents";
import { useMediaQuery, wideScreen } from "../../app/media";
import { writeStored } from "../../app/storage";
import {
  TabsNav,
  tabsTrigger,
  EmptyState,
  PageError,
  Skeleton,
  GuildHeader,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  toast,
  PillCount,
} from "@guildsrun/ui";
import { CreateAgentDialog } from "../agent/CreateAgentDialog";
import { OpenApplyStrip } from "../recipes/OpenApplyStrip";
import { GroupChat } from "./GroupChat";
import { MessageBudget } from "./MessageBudget";

/** The last guild opened, so the app can return to it. */
export const lastGuildKey = "guilds-last-guild";

/** The guild's pages after its group chat, by route. */
const otherTabs = [
  { route: "/guilds/$guildId/settings", label: "Settings" },
  { route: "/guilds/$guildId/state", label: "State" },
  { route: "/guilds/$guildId/routines", label: "Routines" },
  { route: "/guilds/$guildId/issues", label: "Issues" },
  { route: "/guilds/$guildId/tools", label: "Tools" },
  { route: "/guilds/$guildId/secrets", label: "Secrets" },
  { route: "/guilds/$guildId/usage", label: "Usage" },
] as const;

/** One guild: who is in it, and its pages; an agent's inspector opens over the group chat. */
export function GuildWorkspace() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const matchRoute = useMatchRoute();
  const wide = useMediaQuery(wideScreen);
  const [addingAgent, setAddingAgent] = useState(false);
  const sessions = useStudioSessions();
  const capture = useCaptureRecipe();
  const navigate = useNavigate();
  const inspecting = Boolean(matchRoute({ to: "/guilds/$guildId/agents/$agentId", fuzzy: true }));
  useGuildStream(guildId);
  const guild = useGuild(guildId);
  const agents = useGuildAgents(guildId);
  const state = useGroupChatState(guildId);
  const openIssues = useOpenIssues(guildId);

  useEffect(() => writeStored(lastGuildKey, guildId), [guildId]);

  if (guild.isError) {
    return guild.error instanceof ApiError && guild.error.status === 404 ? (
      <div className="grid flex-1 place-items-center p-6">
        <EmptyState
          icon={SearchX}
          title="This guild isn't here"
          description="It was deleted, it's private, or it belongs to another organisation."
          action={
            <Link to="/" className="font-semibold text-signal-t underline">
              Back to your guilds
            </Link>
          }
        />
      </div>
    ) : (
      <div className="grid flex-1 place-items-center p-6">
        <PageError title="Couldn't load this guild" description={guild.error.message} />
      </div>
    );
  }

  const members = (agents.data ?? []).filter((agent) => !agent.archived_at);

  /** Studio resumes the guild's latest live session, or starts one. */
  const openStudio = () => {
    const live = sessions.data?.find(
      (session) => session.source_guild_id === guildId && session.status === "active",
    );
    void (live
      ? navigate({ to: "/studio/$sessionId", params: { sessionId: live.id } })
      : navigate({ to: "/studio", search: { guild: guildId } }));
  };

  const saveAsRecipe = () =>
    capture.mutate(guildId, {
      onSuccess: (row) => {
        toast({ kind: "success", title: `Saved ${row.name} as a draft recipe` });
        void navigate({ to: "/recipes/$recipeId", params: { recipeId: row.id } });
      },
      onError: (error) =>
        toast({ kind: "error", title: "Couldn't save the recipe", description: error.message }),
    });
  const active = members.filter((agent) => agent.generating).length;
  const issueCount = openIssues.data?.length ?? 0;

  return (
    <>
      {guild.data ? (
        <GuildHeader
          compact={!wide}
          name={guild.data.name}
          about={guild.data.about}
          visibility={guild.data.visibility}
          routinesEnabled={guild.data.routines_enabled}
          maxAgents={guild.data.max_agents}
          agents={members.map((agent) => ({
            id: agent.id,
            name: agent.name,
            ...agentLook(agent),
          }))}
          onAgentSelect={(agent) => {
            if (!agent.id) return;
            void navigate({
              to: "/guilds/$guildId/agents/$agentId",
              params: { guildId, agentId: agent.id },
              search: {},
            });
          }}
          activeCount={active}
          actions={
            <>
              {state.data ? <MessageBudget guildId={guildId} state={state.data} /> : null}
              <Menu>
                <MenuTrigger
                  variant="on-plum"
                  label="Guild options"
                  {...(!wide ? { size: 28 } : {})}
                />
                <MenuContent>
                  <MenuItem icon={Sparkles} onSelect={openStudio}>
                    Open in Studio
                  </MenuItem>
                  <MenuItem
                    icon={UserPlus}
                    disabled={members.length >= guild.data.max_agents}
                    onSelect={() => setAddingAgent(true)}
                  >
                    {members.length >= guild.data.max_agents
                      ? `New agent (full at ${guild.data.max_agents})`
                      : "New agent"}
                  </MenuItem>
                  <MenuItem
                    icon={BookmarkPlus}
                    disabled={capture.isPending}
                    onSelect={saveAsRecipe}
                  >
                    Save as recipe
                  </MenuItem>
                  <MenuItem
                    icon={Settings}
                    onSelect={() =>
                      void navigate({ to: "/guilds/$guildId/settings", params: { guildId } })
                    }
                  >
                    Guild settings
                  </MenuItem>
                </MenuContent>
              </Menu>
            </>
          }
        />
      ) : (
        <div className={`flex flex-col gap-3 bg-plum ${wide ? "px-10 py-8" : "px-4 py-2.5"}`}>
          {wide ? (
            <>
              <Skeleton className="h-3 w-16 bg-on-plum-hover" />
              <Skeleton className="h-8 w-72 bg-on-plum-hover" />
            </>
          ) : (
            <Skeleton className="h-5 w-40 bg-on-plum-hover" />
          )}
        </div>
      )}
      <TabsNav aria-label="Guild pages">
        <Link
          to="/guilds/$guildId"
          params={{ guildId }}
          activeOptions={{ exact: true, includeSearch: false }}
          {...(inspecting ? { "aria-current": "page" as const } : {})}
          className={tabsTrigger({ look: "bar" })}
        >
          Group chat
        </Link>
        {otherTabs.map(({ route, label }) => (
          <Link
            key={route}
            to={route}
            params={{ guildId }}
            className={tabsTrigger({ look: "bar" })}
          >
            {label}
            {route === "/guilds/$guildId/issues" && issueCount > 0 ? (
              <PillCount>{issueCount}</PillCount>
            ) : null}
          </Link>
        ))}
      </TabsNav>
      <OpenApplyStrip guildId={guildId} />
      {inspecting && guild.data ? (
        <GroupChat guild={guild.data} agents={agents.data ?? []} state={state.data} />
      ) : null}
      <Outlet />
      <CreateAgentDialog
        guild={addingAgent && guild.data ? { id: guildId, name: guild.data.name } : null}
        onClose={() => setAddingAgent(false)}
      />
    </>
  );
}

/** The guild's index page: its group chat. */
export function GuildChatPage() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { seq } = useSearch({ from: "/guilds/$guildId/" });
  const guild = useGuild(guildId);
  const agents = useGuildAgents(guildId);
  const state = useGroupChatState(guildId);
  return guild.data ? (
    <GroupChat
      key={seq ?? "end"}
      guild={guild.data}
      agents={agents.data ?? []}
      state={state.data}
      {...(seq !== undefined ? { focusSeq: seq } : {})}
    />
  ) : null;
}
