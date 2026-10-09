import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ComponentProps, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";

export type SortDirection = "ascending" | "descending";

export type DataTableSort = { columnId: string; direction: SortDirection };

export type DataTableColumn<Row> = {
  id: string;
  header: ReactNode;
  cell: (row: Row, index: number) => ReactNode;
  sortable?: boolean;
  align?: "start" | "end";
  /** Width and wrapping for the column's header and cells, such as "w-16" or "min-w-60". */
  className?: string;
};

const tableTone = {
  paper: { table: "bg-paper", head: "bg-paper", hover: "hover:bg-surface" },
  surface: { table: "bg-surface", head: "bg-surface", hover: "hover:bg-paper" },
} as const;

export type DataTableProps<Row> = Omit<ComponentProps<"div">, "children"> & {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row, index: number) => string;
  /** Accessible name for the table. */
  label: string;
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort) => void;
  onRowClick?: (row: Row) => void;
  selectedKey?: string | null;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
  tone?: keyof typeof tableTone;
  /** Classes for the table element, such as a minimum width that makes the frame scroll sideways. */
  tableClassName?: string;
};

const interactiveSelector =
  "button, a, input, select, textarea, label, [role=menuitem], [role=checkbox]";

/**
 * Records, secrets, members or usage as a table: a mono caps header that sticks while the frame
 * scrolls, hairline rows, optional sorting and row selection. The frame scrolls sideways when the
 * table is wider than its container.
 */
export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  label,
  sort,
  onSortChange,
  onRowClick,
  selectedKey,
  empty,
  tone = "paper",
  tableClassName,
  className,
  ...props
}: DataTableProps<Row>) {
  const palette = tableTone[tone];

  const activate = (
    event: MouseEvent<HTMLTableRowElement> | KeyboardEvent<HTMLTableRowElement>,
    row: Row,
  ) => {
    const target =
      event.target instanceof Element ? event.target.closest(interactiveSelector) : null;
    if (target && event.currentTarget.contains(target)) return;
    onRowClick?.(row);
  };

  return (
    <div className={cn("min-h-0 min-w-0 overflow-auto overscroll-contain", className)} {...props}>
      <table
        aria-label={label}
        className={cn(
          "w-full border-separate border-spacing-0 text-left",
          palette.table,
          tableClassName,
        )}
      >
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.columnId === column.id ? sort.direction : null;
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={column.sortable ? (active ?? "none") : undefined}
                  className={cn(
                    "sticky top-0 z-10 border-b border-line px-3 py-3 text-left align-middle whitespace-nowrap",
                    "type-label text-muted",
                    palette.head,
                    column.align === "end" && "text-right",
                    column.className,
                  )}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() =>
                        onSortChange?.({
                          columnId: column.id,
                          direction: active === "ascending" ? "descending" : "ascending",
                        })
                      }
                      className={cn(
                        "group/sort -mx-1 inline-flex cursor-pointer items-center gap-1 rounded-xs px-1 uppercase hover:text-fg",
                        active && "text-fg",
                      )}
                    >
                      {column.header}
                      <Icon
                        icon={
                          active === "ascending"
                            ? ArrowUp
                            : active === "descending"
                              ? ArrowDown
                              : ArrowUpDown
                        }
                        size={14}
                        className={cn(
                          !active &&
                            "text-faint opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100",
                        )}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-6 py-7 text-sm text-muted">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const key = getRowKey(row, index);
              const selected =
                selectedKey !== undefined && selectedKey !== null && key === selectedKey;
              return (
                <tr
                  key={key}
                  data-selected={selected ? "true" : undefined}
                  aria-current={selected ? "true" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? (event) => activate(event, row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          activate(event, row);
                        }
                      : undefined
                  }
                  className={cn(
                    "group/tr text-sm text-fg transition-colors focus-visible:-outline-offset-2",
                    onRowClick && ["cursor-pointer", palette.hover],
                    "selected:bg-t-sig selected:hover:bg-t-sig",
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        "border-b border-line px-3 py-3 align-middle group-last/tr:border-b-0",
                        column.align === "end" && "text-right",
                        column.className,
                      )}
                    >
                      {column.cell(row, index)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
