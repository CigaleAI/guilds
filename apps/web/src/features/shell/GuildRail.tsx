import { Link, useParams } from "@tanstack/react-router";
import { BookOpen, Database, Inbox, Settings, Sparkles } from "lucide-react";
import { useGuilds } from "../../api/queries/guilds";
import { cappedCount, RingCount, CollapsedRail, RailItem } from "@guildsrun/ui";
import { AccountMenu } from "./AccountMenu";
import { guildInitials } from "./guilds";
import { useInboxCount, useUnreadByGuild } from "./inbox";

/** The retracted sidebar: guild tiles, workspace tools and the account. */
export function GuildRail({ onExpand }: { onExpand: () => void }) {
  const { guildId } = useParams({ strict: false });
  const guilds = useGuilds().data ?? [];
  const inboxCount = useInboxCount();
  const unread = useUnreadByGuild();

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
          {...(unread.has(guild.id)
            ? {
                badge: <RingCount>{cappedCount(unread.get(guild.id) ?? 0)}</RingCount>,
                badgeOffset: "count" as const,
              }
            : {})}
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
                  badge: <RingCount>{cappedCount(inboxCount)}</RingCount>,
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
          <RailItem asChild tone="signal-tint" icon={Database} label="Tables">
            <Link to="/tables" />
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
