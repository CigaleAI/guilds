import { useAgentsByGuild } from "../../api/queries/agents";
import { useGuilds } from "../../api/queries/guilds";
import type { AccessRow } from "../../api/types/access";
import { useIdentity } from "../../app/identity";
import { Segmented, Select } from "@guildsrun/ui";
import { accessCandidates, findCandidate, modeForType, modeOptions, subjectKey } from "./accessList";

type StartingAccessFieldProps = {
  /** The row the new item's access list starts with. */
  value: AccessRow;
  onChange: (row: AccessRow) => void;
  disabled?: boolean;
};

/**
 * The first row of a new note's or file's access list: any subject of the organisation, and the
 * mode its row starts with.
 */
export function StartingAccessField({ value, onChange, disabled = false }: StartingAccessFieldProps) {
  const { org } = useIdentity();
  const guilds = useGuilds().data ?? [];
  const agentsByGuild = useAgentsByGuild(guilds.map((guild) => guild.id));
  const groups = accessCandidates({ org, guilds, agentsByGuild, taken: [] });

  const pick = (key: string) => {
    const subject = findCandidate(groups, key);
    if (subject) onChange({ type: subject.type, id: subject.id, mode: modeForType(subject.type, value.mode) });
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Select
        className="min-w-48 flex-1"
        tone="surface"
        label="Access"
        hint="Who reaches it first; its access list changes later."
        value={subjectKey(value)}
        disabled={disabled}
        onValueChange={pick}
        options={groups}
      />
      <Segmented
        size="sm"
        label="Mode of the first row"
        value={value.mode}
        disabled={disabled}
        onValueChange={(mode) => onChange({ ...value, mode })}
        options={modeOptions(value.type)}
      />
    </div>
  );
}
