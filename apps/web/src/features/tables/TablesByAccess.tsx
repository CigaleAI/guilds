import { RotateCw } from "lucide-react";
import { useTablesAccess } from "../../api/queries/access";
import type { Collection } from "../../api/types/tables";
import { relativeTime } from "../../app/format";
import { Button, DatabaseItem, Icon, ListGroupLabel } from "@guildsrun/ui";
import { tablesByAccess, type TableAccessRead } from "./accessGroups";

type TablesByAccessProps = {
  tables: readonly Collection[];
  selectedId: string | undefined;
  onOpen: (tableId: string) => void;
};

/**
 * The tables by who their access lists reach, each table under every group it matches. A failed
 * read lists its tables apart, with a retry, and never stops another table from opening.
 */
export function TablesByAccess({ tables, selectedId, onOpen }: TablesByAccessProps) {
  const reads = useTablesAccess(tables.map((table) => table.id));
  const readsById = new Map(tables.map((table, index) => [table.id, reads[index]]));
  const readOf = (tableId: string): TableAccessRead => {
    const read = readsById.get(tableId);
    if (read?.isSuccess) return { status: "success", list: read.data };
    return { status: read?.isError ? "error" : "pending" };
  };
  const retry = () => {
    for (const read of reads) if (read.isError) void read.refetch();
  };

  return tablesByAccess(tables, readOf).map((group) => (
    <div key={group.key} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pr-3">
        <ListGroupLabel>{group.label}</ListGroupLabel>
        {group.kind === "error" ? (
          <Button variant="ghost" size="sm" onClick={retry}>
            <Icon icon={RotateCw} size={14} />
            Retry
          </Button>
        ) : null}
      </div>
      {group.tables.map((item) => (
        <DatabaseItem
          key={item.id}
          name={item.name}
          purpose={item.purpose}
          count={item.count ?? 0}
          age={relativeTime(item.updated_at)}
          selected={item.id === selectedId}
          onClick={() => onOpen(item.id)}
        />
      ))}
    </div>
  ));
}
