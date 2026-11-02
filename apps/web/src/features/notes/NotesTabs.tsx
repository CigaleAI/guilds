import { useParams, useSearch } from "@tanstack/react-router";
import { NotesBrowser } from "./NotesBrowser";

/** The agent's Notes tab: its guild's notes and those shared with it, as the agent reaches them; `?path=` opens one first. */
export function AgentNotesTab() {
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { path } = useSearch({ from: "/guilds/$guildId/agents/$agentId/state/notes" });
  return (
    <NotesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      page={{ type: "agent", id: agentId }}
    />
  );
}

/** The guild's State Notes view: its own notes and those shared with it, as its agents reach them; `?path=` opens one first. */
export function GuildNotesTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { path } = useSearch({ from: "/guilds/$guildId/state/notes" });
  return (
    <NotesBrowser
      key={path ?? ""}
      guildId={guildId}
      initialPath={path}
      page={{ type: "guild", id: guildId }}
    />
  );
}
