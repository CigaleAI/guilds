import { useParams, useSearch } from "@tanstack/react-router";
import { useIdentity } from "../../app/identity";
import { NotesBrowser } from "./NotesBrowser";

/** The agent's Notes tab: the notes it reads, its guild's, and every note; `?path=` opens one first. */
export function AgentNotesTab() {
  const { org } = useIdentity();
  const { guildId, agentId } = useParams({ from: "/guilds/$guildId/agents/$agentId" });
  const { path } = useSearch({ from: "/guilds/$guildId/agents/$agentId/state/notes" });
  return (
    <NotesBrowser
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

/** The guild's State Notes view: the notes open to it or its agents, and every note; `?path=` opens one first. */
export function GuildNotesTab() {
  const { org } = useIdentity();
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  const { path } = useSearch({ from: "/guilds/$guildId/state/notes" });
  return (
    <NotesBrowser
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
