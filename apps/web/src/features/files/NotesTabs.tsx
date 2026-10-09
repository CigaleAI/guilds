import { useParams } from "@tanstack/react-router";
import { FileBrowser } from "./FileBrowser";

const enc = encodeURIComponent;

/** The agent's Notes tab: its own notes, its guild's, and the organisation's. */
export function AgentNotesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  return (
    <FileBrowser
      guildId={guildId}
      agentId={agentId}
      scopes={[
        { id: "agent", title: "Agent", prefix: `/api/agents/${enc(agentId)}/files` },
        { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/files` },
        { id: "org", title: "Org", prefix: "/api/org/files" },
      ]}
    />
  );
}

/** The guild's State Files view: notes its agents share, and the organisation's. */
export function GuildFilesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  return (
    <FileBrowser
      guildId={guildId}
      scopes={[
        { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/files` },
        { id: "org", title: "Org", prefix: "/api/org/files" },
      ]}
    />
  );
}
