import { useParams, useSearch } from "@tanstack/react-router";
import { useIdentity } from "../../app/identity";
import { FilesBrowser } from "./FilesBrowser";

/** The agent's Files tab: the files it reads, its guild's, and every file; `?path=` opens one first. */
export function AgentFilesTab() {
  const { org } = useIdentity();
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { path } = useSearch({ from: "/guilds/$guildId/agents/$agentId/state/files" });
  return (
    <FilesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      scopes={[
        { title: "Agent", page: { type: "agent", id: agentId } },
        { title: "Guild", page: { type: "guild", id: guildId } },
        { title: "Org", page: { type: "org", id: org.id } },
      ]}
    />
  );
}

/** The guild's State Files view: the files open to it, its agents or the organisation, and every file; `?path=` opens one first. */
export function GuildFilesTab() {
  const { org } = useIdentity();
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { path } = useSearch({ from: "/guilds/$guildId/state/files" });
  return (
    <FilesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      scopes={[
        { title: "Guild", page: { type: "guild", id: guildId } },
        { title: "Org", page: { type: "org", id: org.id } },
      ]}
    />
  );
}
