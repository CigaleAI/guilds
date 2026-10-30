import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useGuilds } from "../../api/queries/guilds";
import { readStored } from "../../app/storage";
import { SkeletonRows } from "@guildsrun/ui";
import { CreateGuildDialog } from "../guild/CreateGuildDialog";
import { lastGuildKey } from "../guild/GuildWorkspace";
import { GuildEmptyState } from "./GuildEmptyState";

/** Opens the last guild visited, or the first; with none, offers Create a guild or the Builder. */
export function Home() {
  const guilds = useGuilds();
  const [creating, setCreating] = useState(false);
  if (guilds.isPending) {
    return (
      <div className="p-10">
        <SkeletonRows rows={3} label="Loading guilds" />
      </div>
    );
  }
  const listed = guilds.data ?? [];
  const last = readStored(lastGuildKey);
  const target = listed.find((guild) => guild.id === last) ?? listed[0];
  if (target) return <Navigate to="/guilds/$guildId" params={{ guildId: target.id }} replace />;
  return (
    <>
      <GuildEmptyState onCreateGuild={() => setCreating(true)} />
      <CreateGuildDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
