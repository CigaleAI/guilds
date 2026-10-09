import { Link, Navigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useGuilds } from "../../api/queries";
import { readStored } from "../../app/storage";
import { Button, EmptyState, SkeletonRows } from "@guildsrun/ui";
import { lastGuildKey } from "../guild/GuildWorkspace";
import { listedGuilds } from "../shell/guilds";

/** Opens the last guild visited, or the first; with none, points to the Builder. */
export function Home() {
  const guilds = useGuilds();
  if (guilds.isPending) {
    return (
      <div className="p-10">
        <SkeletonRows rows={3} label="Loading guilds" />
      </div>
    );
  }
  const listed = listedGuilds(guilds.data);
  const last = readStored(lastGuildKey);
  const target = listed.find((guild) => guild.id === last) ?? listed[0];
  if (target) return <Navigate to="/guilds/$guildId" params={{ guildId: target.id }} replace />;
  return (
    <div className="grid flex-1 place-items-center p-6">
      <EmptyState
        icon={Sparkles}
        title="No guilds yet"
        description="Describe the guild you want in one sentence and the Builder drafts it."
        action={
          <Button asChild>
            <Link to="/builder">Open the Builder</Link>
          </Button>
        }
      />
    </div>
  );
}
