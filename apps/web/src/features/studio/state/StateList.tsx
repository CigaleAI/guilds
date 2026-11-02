import { useState } from "react";
import { useStudioState } from "../../../api/queries/studio";
import type { StateItemRow, StudioAgent } from "../../../api/types/studio";
import { relativeTime } from "../../../app/format";
import { readStored, writeStored } from "../../../app/storage";
import {
  Banner,
  Checkbox,
  DataTable,
  FilterBar,
  Segmented,
  SkeletonRows,
  Tag,
  type DataTableColumn,
  type DataTableSort,
} from "@guildsrun/ui";
import { useStudio } from "../StudioContext";
import { StateItemDetail } from "./StateItemDetail";
import {
  STATE_DEFAULT_HOURS,
  STATE_WINDOW_HOURS,
  actorShare,
  filterStateRows,
  findStateRow,
  isAwaitingApproval,
  itemSize,
  itemsAwaitingApproval,
  stateFlagLabels,
  type StateSortKey,
  type StateWindowHours,
} from "./stateModel";

const hoursKey = "studio.state.hours";
const windowLabel: Record<StateWindowHours, string> = { 24: "24 h", 72: "3 d", 168: "7 d" };

/** The window State last showed, remembered in this browser. */
export function storedStateHours(): StateWindowHours {
  const value = Number(readStored(hoursKey));
  return STATE_WINDOW_HOURS.find((hours) => hours === value) ?? STATE_DEFAULT_HOURS;
}

/**
 * Every note, table, script and Memory of the guild's state with its changes and reads in the
 * window; an item opens to who changes and reads it, its references, and its history.
 */
export function StateList() {
  const { session, search, approvals } = useStudio();
  const [hours, setHours] = useState(storedStateHours);
  const rows = useStudioState(session.id, hours, search.agent ?? null, search.kind ?? null);
  const waiting = itemsAwaitingApproval(approvals.proposals);
  if (rows.isError) {
    return (
      <div className="p-5">
        <Banner tone="error" title="Couldn't load the guild's state" meta={rows.error.message} />
      </div>
    );
  }
  if (!rows.data)
    return <SkeletonRows rows={6} label="Loading the guild's state" className="p-5" />;
  const selected = findStateRow(rows.data, search.item);
  if (selected) {
    return (
      <StateItemDetail
        row={selected}
        hours={hours}
        pending={isAwaitingApproval(selected, waiting)}
      />
    );
  }
  const changeHours = (next: StateWindowHours) => {
    setHours(next);
    writeStored(hoursKey, String(next));
  };
  return (
    <StateTable rows={rows.data} waiting={waiting} hours={hours} onHoursChange={changeHours} />
  );
}

/** The order each sortable column sorts by. */
const sortKeys = {
  item: "name",
  changes: "changes",
  reads: "reads",
  last: "last",
} satisfies Record<string, StateSortKey>;

/** Whether the table sorts by a column State orders by. */
function isSortColumn(columnId: string): columnId is keyof typeof sortKeys {
  return Object.hasOwn(sortKeys, columnId);
}

type StateTableProps = {
  rows: StateItemRow[];
  waiting: Set<string>;
  hours: StateWindowHours;
  onHoursChange: (hours: StateWindowHours) => void;
};

function StateTable({ rows, waiting, hours, onHoursChange }: StateTableProps) {
  const { agents, search, go } = useStudio();
  const [query, setQuery] = useState("");
  const [needsLook, setNeedsLook] = useState(false);
  const [sort, setSort] = useState<DataTableSort>({ columnId: "changes", direction: "descending" });
  const shown = filterStateRows(rows, { needsLook, query }, waiting, {
    key: isSortColumn(sort.columnId) ? sortKeys[sort.columnId] : "changes",
    descending: sort.direction === "descending",
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <FilterBar
        query={query}
        onQueryChange={setQuery}
        placeholder="Search notes, tables, scripts…"
        searchLabel="Search the guild's state"
        size="sm"
        actions={
          <>
            <Checkbox
              label="Needs a look"
              checked={needsLook}
              onCheckedChange={(value) => setNeedsLook(value === true)}
            />
            <Segmented
              size="sm"
              mono
              label="Window"
              value={String(hours)}
              onValueChange={(value) => {
                const next = STATE_WINDOW_HOURS.find((window) => String(window) === value);
                if (next) onHoursChange(next);
              }}
              options={STATE_WINDOW_HOURS.map((value) => ({
                value: String(value),
                label: windowLabel[value],
              }))}
            />
          </>
        }
      />
      <DataTable
        label="The guild's state"
        tone="surface"
        className="min-h-0 flex-1 rounded-lg"
        tableClassName="min-w-240"
        columns={stateColumns(waiting, agents)}
        rows={shown}
        getRowKey={(row) => row.display_path}
        sort={sort}
        onSortChange={setSort}
        onRowClick={(row) =>
          go({
            section: "state",
            ...(search.agent ? { agent: search.agent } : {}),
            tab: "list",
            ...(search.kind ? { kind: search.kind } : {}),
            item: row.display_path,
          })
        }
        empty={<span className="text-muted">Nothing in the guild's state matches.</span>}
      />
    </div>
  );
}

/** The agent whose Memory or script an item is, by name; null for a note, a file, and a table. */
function agentLabel(row: StateItemRow, agents: StudioAgent[]): string | null {
  if (row.agent_id === null) return null;
  return agents.find((agent) => agent.id === row.agent_id)?.name ?? "agent";
}

function stateColumns(
  waiting: Set<string>,
  agents: StudioAgent[],
): DataTableColumn<StateItemRow>[] {
  return [
    {
      id: "item",
      header: "Item",
      sortable: true,
      className: "min-w-72",
      cell: (row) => (
        <span className="flex flex-col gap-1">
          <span className="font-mono text-sm font-medium">{row.title}</span>
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {[row.kind, agentLabel(row, agents)].filter(Boolean).join(" · ")}
            {stateFlagLabels(row, isAwaitingApproval(row, waiting)).map((label) => (
              <Tag key={label} tone={label === "needs approval" ? "signal" : "ochre"} font="sans">
                {label}
              </Tag>
            ))}
          </span>
        </span>
      ),
    },
    { id: "size", header: "Size", cell: (row) => itemSize(row) },
    { id: "changes", header: "Changes", align: "end", sortable: true, cell: (row) => row.changes },
    { id: "reads", header: "Reads", align: "end", sortable: true, cell: (row) => row.reads },
    { id: "writer", header: "Most changed by", cell: (row) => actorShare(row.top_writer) },
    { id: "reader", header: "Most read by", cell: (row) => actorShare(row.top_reader) },
    {
      id: "last",
      header: "Last change",
      sortable: true,
      cell: (row) =>
        row.last_change
          ? `${relativeTime(row.last_change.at)} · ${row.last_change.actor.name}`
          : "—",
    },
  ];
}
