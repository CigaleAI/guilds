import { Link, useParams } from "@tanstack/react-router";
import { BookOpen, Database, Inbox, Settings, Sparkles } from "lucide-react";
import { useGuilds } from "../../api/queries";
import { RingCount, CollapsedRail, RailItem } from "@guildsrun/ui";
import { AccountMenu } from "./AccountMenu";
import { guildInitials, listedGuilds } from "./guilds";
import { useInboxCount } from "./inbox";

/** The retracted sidebar: guild tiles, workspace tools and the account. */
export function GuildRail({ onExpand }: { onExpand: () => void }) {
  const { guildId } = useParams({ strict: false });
  const guilds = listedGuilds(useGuilds().data);
  const inboxCount = useInboxCount();

  return (
    <CollapsedRail
      onExpand={onExpand}
      guilds={guilds.map((guild) => (
        <RailItem
          key={guild.id}
          asChild
          tone="guild"
          label={guild.name}
          selected={guild.id === guildId}
        >
          <Link to="/guilds/$guildId" params={{ guildId: guild.id }}>
            {guildInitials(guild.name)}
          </Link>
        </RailItem>
      ))}
      tools={
        <>
          <RailItem
            asChild
            tone="plum"
            icon={Inbox}
            label="Inbox"
            {...(inboxCount
              ? {
                  badge: <RingCount>{inboxCount > 99 ? "99+" : inboxCount}</RingCount>,
                  badgeOffset: "count" as const,
                }
              : {})}
          >
            <Link to="/inbox" />
          </RailItem>
          <RailItem asChild tone="signal" icon={Sparkles} label="Builder">
            <Link to="/builder" />
          </RailItem>
          <RailItem asChild tone="plum-tint" icon={BookOpen} label="Recipes">
            <Link to="/recipes" />
          </RailItem>
          <RailItem asChild tone="signal-tint" icon={Database} label="Databases">
            <Link to="/databases" />
          </RailItem>
        </>
      }
      footer={
        <>
          <RailItem asChild tone="well" icon={Settings} label="Settings">
            <Link to="/settings" />
          </RailItem>
          <AccountMenu compact />
        </>
      }
    />
  );
}
