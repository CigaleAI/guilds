import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useAgentsByGuild } from "../../api/queries/agents";
import { useGuilds } from "../../api/queries/guilds";
import { useItemAccess, useSetItemAccess } from "../../api/queries/access";
import type { AccessEntry, AccessListMode, AccessRow, AccessTarget } from "../../api/types/access";
import { useIdentity } from "../../app/identity";
import {
  Banner,
  Button,
  Icon,
  IconButton,
  Segmented,
  Select,
  SkeletonRows,
  toast,
} from "@guildsrun/ui";
import {
  accessCandidates,
  accessModeLabel,
  accessModes,
  findCandidate,
  modeForType,
  subjectCaption,
  subjectKey,
  withMode,
  withoutSubject,
  withSubject,
} from "./accessList";

const resolution =
  "A guild or organisation row covers every agent in it, agents added later included. An agent's own row wins over both; None shuts that agent out. Write includes read.";

const failed = (error: Error) =>
  toast({ kind: "error", title: "Couldn't change the access", description: error.message });

function modeOptions(type: AccessEntry["type"]) {
  return accessModes[type].map((mode) => ({ value: mode, label: accessModeLabel[mode] }));
}

/**
 * A note's or a table's access list: one row per organisation, guild or agent, each with its
 * mode. Every change sends the full list and shows the list the server keeps.
 */
export function AccessListPanel({ target, intro }: { target: AccessTarget; intro: string }) {
  const access = useItemAccess(target);
  const save = useSetItemAccess(target);

  if (access.isPending) return <SkeletonRows rows={3} label="Loading the access list" />;
  if (access.isError) {
    return (
      <Banner tone="error" title="Couldn't load the access list" meta={access.error.message} />
    );
  }
  const entries = access.data.subjects;
  const saveRows = (rows: AccessRow[]) => save.mutate(rows, { onError: failed });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-2">
        {intro} {resolution}
      </p>
      <AccessRows
        entries={entries}
        disabled={save.isPending}
        onMode={(entry, mode) => saveRows(withMode(entries, entry, mode))}
        onRemove={(entry) => saveRows(withoutSubject(entries, entry))}
      />
      <AddAccessRow
        taken={entries}
        ownerAgentId={access.data.owner_agent_id}
        disabled={save.isPending}
        onAdd={(row) => saveRows(withSubject(entries, row))}
      />
    </div>
  );
}

function AccessRows({
  entries,
  disabled,
  onMode,
  onRemove,
}: {
  entries: readonly AccessEntry[];
  disabled: boolean;
  onMode: (entry: AccessEntry, mode: AccessListMode) => void;
  onRemove: (entry: AccessEntry) => void;
}) {
  if (!entries.length) return <p className="text-sm text-muted">No one is on the list.</p>;
  return (
    <div className="flex flex-col overflow-hidden rounded-xl bg-surface">
      {entries.map((entry) => (
        <div
          key={subjectKey(entry)}
          className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{entry.name}</span>
            <span className="truncate text-xs text-muted">{subjectCaption(entry)}</span>
          </div>
          <Segmented
            size="sm"
            label={`${entry.name} access`}
            value={entry.mode}
            disabled={disabled}
            onValueChange={(mode) => onMode(entry, mode)}
            options={modeOptions(entry.type)}
          />
          <IconButton
            icon={X}
            label={`Remove ${entry.name}`}
            variant="ghost"
            size={28}
            disabled={disabled}
            onClick={() => onRemove(entry)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Picks a subject not yet on the list and the mode its row starts with; each add starts the next
 * one over at read.
 */
function AddAccessRow({
  taken,
  ownerAgentId,
  disabled,
  onAdd,
}: {
  taken: readonly AccessEntry[];
  ownerAgentId: string | null;
  disabled: boolean;
  onAdd: (row: AccessRow) => void;
}) {
  const { org } = useIdentity();
  const guilds = useGuilds().data ?? [];
  const agentsByGuild = useAgentsByGuild(guilds.map((guild) => guild.id));
  const [picked, setPicked] = useState("");
  const [mode, setMode] = useState<AccessListMode>("read");
  const groups = accessCandidates({ org, guilds, agentsByGuild, taken, ownerAgentId });
  const subject = findCandidate(groups, picked);

  if (!groups.length) return null;
  const add = () => {
    if (!subject) return;
    onAdd({ type: subject.type, id: subject.id, mode: modeForType(subject.type, mode) });
    setPicked("");
    setMode("read");
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Select
        className="min-w-56 flex-1"
        tone="surface"
        label="Add"
        placeholder="The organisation, a guild or an agent"
        value={subject ? picked : ""}
        onValueChange={setPicked}
        options={groups}
      />
      {subject ? (
        <Segmented
          size="sm"
          label="Mode of the new row"
          value={modeForType(subject.type, mode)}
          onValueChange={setMode}
          options={modeOptions(subject.type)}
        />
      ) : null}
      <Button size="md" variant="outline" disabled={!subject || disabled} onClick={add}>
        <Icon icon={Plus} size={14} />
        Add
      </Button>
    </div>
  );
}
