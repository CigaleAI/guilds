import { useParams, useSearch } from "@tanstack/react-router";
import { NotesBrowser } from "./NotesBrowser";

const enc = encodeURIComponent;

/** The agent's Notes tab: its own notes, its guild's, and the organisation's; `?path=` opens one first. */
export function AgentNotesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { path } = useSearch({ from: "/guilds/$guildId/agents/$agentId/state/notes" });
  return (
    <NotesBrowser
      key={path ?? ""}
      guildId={guildId}
      agentId={agentId}
      initialPath={path}
      scopes={[
        { id: "agent", title: "Agent", prefix: `/api/agents/${enc(agentId)}/notes` },
        { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/notes` },
        { id: "org", title: "Org", prefix: "/api/org/notes" },
      ]}
    />
  );
}

/** The guild's State Notes view: notes its agents share, and the organisation's; `?path=` opens one first. */
export function GuildNotesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { path } = useSearch({ from: "/guilds/$guildId/state/notes" });
  return (
    <NotesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      scopes={[
        { id: "guild", title: "Guild", prefix: `/api/guilds/${enc(guildId)}/notes` },
        { id: "org", title: "Org", prefix: "/api/org/notes" },
      ]}
    />
  );
}
