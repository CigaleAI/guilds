import { useGuild } from "../../api/queries/guilds";
import { TextField } from "@guildsrun/ui";

type HomeGuildFieldProps = {
  /** The guild the new item is homed in: the guild of the page it is made on. */
  guildId: string;
};

/**
 * The home a new note or file gets, beside its first access row: the guild it is listed under. It
 * is fixed once the item exists and decides nothing about who reaches it.
 */
export function HomeGuildField({ guildId }: HomeGuildFieldProps) {
  const guild = useGuild(guildId);
  return (
    <TextField
      tone="surface"
      label="Home"
      hint="Listed under this guild; who reaches it is its access list."
      value={guild.data?.name ?? ""}
      placeholder="This guild"
      readOnly
    />
  );
}
