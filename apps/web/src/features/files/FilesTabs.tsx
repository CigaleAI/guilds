import { useParams, useSearch } from "@tanstack/react-router";
import { FilesBrowser } from "./FilesBrowser";

/** The agent's Files tab: its guild's files and those shared with it, as the agent reaches them; `?path=` opens one first. */
export function AgentFilesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { path } = useSearch({ from: "/guilds/$guildId/agents/$agentId/state/files" });
  return (
    <FilesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      page={{ type: "agent", id: agentId }}
    />
  );
}

/** The guild's State Files view: its own files and those shared with it, as its agents reach them; `?path=` opens one first. */
export function GuildFilesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { path } = useSearch({ from: "/guilds/$guildId/state/files" });
  return (
    <FilesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      page={{ type: "guild", id: guildId }}
    />
  );
}
