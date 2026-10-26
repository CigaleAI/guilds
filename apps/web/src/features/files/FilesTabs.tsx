import { useParams, useSearch } from "@tanstack/react-router";
import { FilesBrowser } from "./FilesBrowser";

const enc = encodeURIComponent;

/** The agent's Files tab: its own files, its guild's, and the organisation's; `?path=` opens one first. */
export function AgentFilesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { path } = useSearch({ from: "/guilds/$guildId/agents/$agentId/state/files" });
  return (
    <FilesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      scopes={[
        { id: "agent", title: "Agent", prefix: `/api/agents/${enc(agentId)}/files` },
        { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/files` },
        { id: "org", title: "Org", prefix: "/api/org/files" },
      ]}
    />
  );
}

/** The guild's State Files view: files its agents share, and the organisation's; `?path=` opens one first. */
export function GuildFilesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { path } = useSearch({ from: "/guilds/$guildId/state/files" });
  return (
    <FilesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      scopes={[
        { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/files` },
        { id: "org", title: "Org", prefix: "/api/org/files" },
      ]}
    />
  );
}
