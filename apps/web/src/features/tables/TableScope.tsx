import type { ReactNode } from "react";
import { useGuilds } from "../../api/queries/guilds";
import { Select } from "@guildsrun/ui";

/** The scope of a table that belongs to the organisation rather than to one guild. */
export const orgScope = "org";

type TableScopeSelectProps = {
  /** `orgScope`, or the id of the guild the table belongs to. */
  value: string;
  onValueChange: (scope: string) => void;
  hint?: ReactNode;
};

/** Where a table belongs: the organisation, or one of its guilds. */
export function TableScopeSelect({ value, onValueChange, hint }: TableScopeSelectProps) {
  const guilds = useGuilds();
  return (
    <Select
      tone="surface"
      label="Belongs to"
      hint={hint}
      value={value}
      onValueChange={onValueChange}
      options={[
        { value: orgScope, label: "The organisation" },
        ...(guilds.data ?? []).map((guild) => ({ value: guild.id, label: guild.name })),
      ]}
    />
  );
}
