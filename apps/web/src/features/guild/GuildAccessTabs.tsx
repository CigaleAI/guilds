import { useParams } from "@tanstack/react-router";
import { AccessSecrets } from "../access/AccessSecrets";
import { AccessTools } from "../access/AccessTools";
import { ReachList } from "../access/ReachList";

/** The guild's Tools tab: integrations and native tools, what its agents get unless one overrides it. */
export function GuildToolsTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  return (
    <AccessTools owner={{ scope: "guild", id: guildId }} panes={["connections", "builtin"]} />
  );
}

/** The guild's State sub-tab: the notes and tables its agents reach. */
export function GuildReachTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  return <ReachList subject={{ type: "guild", id: guildId }} guildId={guildId} />;
}

/** The guild's Secrets tab: secrets shared with its agents. */
export function GuildSecretsTab() {
  const { guildId } = useParams({ from: "/guilds/$guildId" });
  return <AccessSecrets owner={{ scope: "guild", id: guildId }} />;
}
