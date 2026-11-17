import { RotateCw } from "lucide-react";
import type { Collection } from "../../api/types/tables";
import { relativeTime } from "../../app/format";
import { Button, DatabaseItem, Icon, ListGroupLabel } from "@guildsrun/ui";
import { itemsByAccess } from "../access/accessGroups";
import { useAccessReads } from "../access/useAccessReads";

type TablesByAccessProps = {
  tables: readonly Collection[];
  selectedId: string | undefined;
  onOpen: (tableId: string) => void;
};

const byName = (a: Collection, b: Collection) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The tables by who their access lists reach, each table under every group it matches, in name
 * order. A failed read lists its tables apart, with a retry, and never stops another table from
 * opening.
 */
export function TablesByAccess({ tables, selectedId, onOpen }: TablesByAccessProps) {
  const { readOf, retry } = useAccessReads(
    "collection",
    tables.map((table) => table.id),
  );

  return itemsByAccess([...tables].sort(byName), (table) => readOf(table.id)).map((group) => (
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
      {group.items.map((item) => (
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
