import { useParams, useSearch } from "@tanstack/react-router";
import { FileBrowser } from "./FileBrowser";

const enc = encodeURIComponent;

/** The agent's Notes tab: its own notes, its guild's, and the organisation's; `?path=` opens one first. */
export function AgentNotesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { path } = useSearch({ from: "/guilds/$guildId/agents/$agentId/state/notes" });
  return (
    <FileBrowser
      key={path ?? ""}
      guildId={guildId}
      agentId={agentId}
      initialPath={path}
      scopes={[
        { id: "agent", title: "Agent", prefix: `/api/agents/${enc(agentId)}/files` },
        { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/files` },
        { id: "org", title: "Org", prefix: "/api/org/files" },
      ]}
    />
  );
}

/** The guild's State Files view: notes its agents share, and the organisation's; `?path=` opens one first. */
export function GuildFilesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { path } = useSearch({ from: "/guilds/$guildId/state/files" });
  return (
    <FileBrowser
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
