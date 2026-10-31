import { Filter, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useClearRecords, useDeleteRecord, useRecords } from "../../api/queries/tables";
import type { Collection, CollectionRecord, Column, RecordsPage } from "../../api/types/tables";
import { relativeTime } from "../../app/format";
import {
  Button,
  IconButton,
  SearchField,
  Select,
  TextField,
  BoolCell,
  DataTable,
  IdCell,
  Banner,
  ConfirmDialog,
  toast,
  Icon,
  PillCount,
  Tag,
} from "@guildsrun/ui";
import type { DataTableColumn, DataTableSort } from "@guildsrun/ui";
import { RecordDialog } from "./RecordDialog";
import { fits, whereOf, type ColumnFilter } from "./values";

const pageSize = 50;
const any = "__any__";

type CellProps = { value: unknown; column: Column };

function Cell({ value, column }: CellProps) {
  if (value === null || value === undefined) return <span className="text-faint">—</span>;
  if (!fits(value, column)) {
    return (
      <Tag tone="plum" title="No longer fits this column">
        {JSON.stringify(value)}
      </Tag>
    );
  }
  if (column.type === "boolean") return <BoolCell value={value === true} />;
  if (column.type === "number") return <span className="font-mono">{String(value)}</span>;
  if (column.type === "datetime") return <span>{new Date(String(value)).toLocaleString()}</span>;
  if (column.type === "array" && Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item) => (
          <Tag key={String(item)} tone="well">
            {String(item)}
          </Tag>
        ))}
      </span>
    );
  }
  const text = String(value);
  return (
    <span title={text.length > 60 ? text : undefined}>
      {text.length > 60 ? `${text.slice(0, 58)}…` : text}
    </span>
  );
}

type ChoiceFilterProps = {
  column: Column;
  filter: ColumnFilter;
  onChange: (filter: ColumnFilter) => void;
};

/** A boolean column, or one with allowed values: any record, one value, or the empty ones. */
function ChoiceFilter({ column, filter, onChange }: ChoiceFilterProps) {
  const values = column.type === "boolean" ? ["true", "false"] : (column.values ?? []);
  return (
    <Select
      tone="paper"
      label={column.name}
      value={filter.value || any}
      onValueChange={(value) => onChange({ value: value === any ? "" : value })}
      options={[
        { value: any, label: "any" },
        ...values.map((value) => ({ value, label: value })),
        { value: "(empty)", label: "(empty)" },
      ]}
    />
  );
}

type RangeFilterProps = {
  column: Column;
  filter: ColumnFilter;
  onChange: (filter: ColumnFilter) => void;
};

/** A number or time column: the values from one end, up to the other, or both. */
function RangeFilter({ column, filter, onChange }: RangeFilterProps) {
  const type = column.type === "number" ? "number" : "datetime-local";
  return (
    <div className="flex items-end gap-2">
      <TextField
        tone="paper"
        label={`${column.name} from`}
        type={type}
        value={filter.from ?? ""}
        onChange={(event) => onChange({ ...filter, from: event.currentTarget.value })}
      />
      <TextField
        tone="paper"
        label="to"
        type={type}
        value={filter.to ?? ""}
        onChange={(event) => onChange({ ...filter, to: event.currentTarget.value })}
      />
    </div>
  );
}

type FilterInputProps = {
  column: Column;
  filter: ColumnFilter;
  onChange: (filter: ColumnFilter) => void;
};

/** A column's filter: a pick among its values, a range for numbers and times, or contained text. */
function FilterInput({ column, filter, onChange }: FilterInputProps) {
  if (column.type === "boolean" || column.values?.length) {
    return <ChoiceFilter column={column} filter={filter} onChange={onChange} />;
  }
  if (column.type === "number" || column.type === "datetime") {
    return <RangeFilter column={column} filter={filter} onChange={onChange} />;
  }
  return (
    <TextField
      tone="paper"
      label={`${column.name} contains`}
      value={filter.value ?? ""}
      onChange={(event) => onChange({ value: event.currentTarget.value })}
    />
  );
}

type RecordsPanelProps = { collection: Collection };

/**
 * A table's records: a ranked search, or filters with sortable, paged rows. A row opens the
 * record to edit; new records and clearing them all start here.
 */
export function RecordsPanel({ collection }: RecordsPanelProps) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<DataTableSort>({ columnId: "id", direction: "ascending" });
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<CollectionRecord | "new" | null>(null);
  const [clearing, setClearing] = useState(false);
  const [removing, setRemoving] = useState<CollectionRecord | null>(null);

  const where = whereOf(filters, collection.columns);
  const filterCount = Object.keys(where).length;
  const records = useRecords(collection.id, {
    ...(query ? { query } : {}),
    where,
    order: { column: sort.columnId, direction: sort.direction === "ascending" ? "asc" : "desc" },
    limit: pageSize,
    offset,
  });

  const setFilter = (name: string, filter: ColumnFilter) => {
    setFilters({ ...filters, [name]: filter });
    setOffset(0);
  };

  const columns: DataTableColumn<CollectionRecord>[] = [
    { id: "id", header: "#", sortable: !query, cell: (row) => <IdCell value={row.id} /> },
    ...collection.columns.map((column) => ({
      id: column.name,
      header: column.name,
      sortable: !query && column.type !== "array",
      cell: (row: CollectionRecord) => <Cell value={row[column.name]} column={column} />,
    })),
    {
      id: "updated_at",
      header: "Updated",
      sortable: !query,
      cell: (row) => <span className="text-muted">{relativeTime(row.updated_at)}</span>,
    },
    {
      id: "delete",
      header: <span className="sr-only">Delete</span>,
      cell: (row) => (
        <IconButton
          icon={Trash2}
          label={`Delete record #${row.id}`}
          variant="ghost"
          size={28}
          onClick={(event) => {
            event.stopPropagation();
            setRemoving(row);
          }}
        />
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6">
        <SearchField
          tone="surface"
          className="min-w-0 flex-1"
          label="Search records"
          placeholder="Search records, then Enter…"
          value={typed}
          onValueChange={(value) => {
            setTyped(value);
            if (!value) setQuery("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setQuery(typed.trim());
              setOffset(0);
            }
          }}
        />
        <FiltersToggle
          open={filtersOpen}
          count={filterCount}
          onToggle={() => setFiltersOpen(!filtersOpen)}
        />
        <IconButton
          icon={RefreshCw}
          label="Refresh the records"
          variant="ghost"
          disabled={records.isFetching}
          onClick={() => void records.refetch()}
        />
        <Button size="md" onClick={() => setOpen("new")}>
          <Icon icon={Plus} size={14} />
          Add record
        </Button>
        <Button
          variant="danger"
          size="md"
          disabled={!collection.count}
          onClick={() => setClearing(true)}
        >
          <Icon icon={Trash2} size={14} />
          Delete all
        </Button>
      </div>

      {filtersOpen ? (
        <RecordFilters
          columns={collection.columns}
          filters={filters}
          filterCount={filterCount}
          onFilterChange={setFilter}
          onClear={() => setFilters({})}
        />
      ) : null}

      {records.isError ? (
        <Banner className="mx-4 md:mx-6" tone="error" title="Couldn't load the records">
          <span className="whitespace-pre-wrap">{records.error.message}</span>
        </Banner>
      ) : (
        <DataTable
          label={`${collection.name} records`}
          tone="surface"
          className="min-h-0 flex-1"
          tableClassName="min-w-240"
          columns={columns}
          rows={records.data?.records ?? []}
          getRowKey={(row) => String(row.id)}
          sort={query ? null : sort}
          onSortChange={(next) => {
            setSort(next);
            setOffset(0);
          }}
          onRowClick={(row) => setOpen(row)}
          empty={
            records.isPending ? (
              <span className="text-muted">Loading records…</span>
            ) : query || filterCount ? (
              <span className="text-muted">No matching records.</span>
            ) : (
              <span className="text-muted">No records yet.</span>
            )
          }
        />
      )}

      <RecordsPager
        page={records.data}
        searching={Boolean(query)}
        offset={offset}
        onOffsetChange={setOffset}
      />

      <RecordDialog collection={collection} record={open} onClose={() => setOpen(null)} />
      <DeleteRecordDialog
        collectionId={collection.id}
        record={removing}
        onClose={() => setRemoving(null)}
      />
      <ClearRecordsDialog
        collection={collection}
        open={clearing}
        onOpenChange={setClearing}
        onCleared={() => setOffset(0)}
      />
    </div>
  );
}

type FiltersToggleProps = {
  open: boolean;
  /** How many filters are set. */
  count: number;
  onToggle: () => void;
};

/** The button that shows or hides the filters, with how many are set. */
function FiltersToggle({ open, count, onToggle }: FiltersToggleProps) {
  return (
    <Button variant={open ? "primary" : "outline"} size="md" onClick={onToggle}>
      <Icon icon={Filter} size={14} />
      Filters
      {count ? <PillCount>{count}</PillCount> : null}
    </Button>
  );
}

type RecordFiltersProps = {
  columns: readonly Column[];
  filters: Record<string, ColumnFilter>;
  /** How many filters are set. */
  filterCount: number;
  onFilterChange: (name: string, filter: ColumnFilter) => void;
  onClear: () => void;
};

/** A filter on the id and on each column, and clearing them all. */
function RecordFilters({
  columns,
  filters,
  filterCount,
  onFilterChange,
  onClear,
}: RecordFiltersProps) {
  return (
    <div className="mx-4 flex flex-wrap items-end gap-3 rounded-lg bg-surface p-3 md:mx-6">
      <TextField
        tone="paper"
        label="id"
        type="number"
        className="w-28"
        value={filters.id?.value ?? ""}
        onChange={(event) => onFilterChange("id", { value: event.currentTarget.value })}
      />
      {columns.map((column) => (
        <FilterInput
          key={column.name}
          column={column}
          filter={filters[column.name] ?? {}}
          onChange={(filter) => onFilterChange(column.name, filter)}
        />
      ))}
      <Button variant="ghost" size="sm" disabled={!filterCount} onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

type RecordsPagerProps = {
  page: RecordsPage | undefined;
  /** A ranked search shows its top matches on one page. */
  searching: boolean;
  offset: number;
  onOffsetChange: (offset: number) => void;
};

/** How many records the view shows, and the previous and next pages of a filtered view. */
function RecordsPager({ page, searching, offset, onOffsetChange }: RecordsPagerProps) {
  const total = page?.total ?? 0;
  const shown = page?.records.length ?? 0;
  return (
    <div className="flex items-center gap-3 px-4 text-sm text-muted md:px-6">
      <span>
        {searching
          ? `${shown} match${shown === 1 ? "" : "es"}${shown === pageSize ? ` · top ${pageSize} shown` : ""}`
          : total
            ? `${offset + 1}–${offset + shown} of ${total} records`
            : "0 records"}
      </span>
      <span className="flex-1" />
      {!searching ? (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + shown >= total}
            onClick={() => onOffsetChange(offset + pageSize)}
          >
            Next
          </Button>
        </>
      ) : null}
    </div>
  );
}

type DeleteRecordDialogProps = {
  collectionId: string;
  /** The record to delete; null keeps the dialog closed. */
  record: CollectionRecord | null;
  onClose: () => void;
};

/** Confirms deleting one record, which goes for every agent that reads the table. */
function DeleteRecordDialog({ collectionId, record, onClose }: DeleteRecordDialogProps) {
  const remove = useDeleteRecord(collectionId);
  return (
    <ConfirmDialog
      kind="destructive"
      open={record !== null}
      onOpenChange={(value) => !value && onClose()}
      title={`Delete record #${record?.id ?? ""}?`}
      description="The record goes for every agent that reads this table; its id is not reused."
      confirmLabel="Delete record"
      onConfirm={() =>
        record
          ? remove.mutateAsync(record.id).then(
              () => onClose(),
              (error: Error) => {
                toast({
                  kind: "error",
                  title: "Couldn't delete the record",
                  description: error.message,
                });
                throw error;
              },
            )
          : undefined
      }
    />
  );
}

type ClearRecordsDialogProps = {
  collection: Collection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCleared: () => void;
};

/** Confirms deleting every record of the table, whatever the view shows. */
function ClearRecordsDialog({
  collection,
  open,
  onOpenChange,
  onCleared,
}: ClearRecordsDialogProps) {
  const clear = useClearRecords(collection.id);
  return (
    <ConfirmDialog
      kind="destructive"
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete every record from ${collection.name}?`}
      description={`All ${collection.count ?? 0} records go, whatever the search or filters show. The table, its columns and its access list stay; new ids carry on.`}
      confirmLabel="Delete all records"
      confirmText={collection.name}
      onConfirm={() =>
        clear.mutateAsync().then(
          () => {
            toast({ kind: "success", title: `Cleared ${collection.name}` });
            onCleared();
          },
          (error: Error) => {
            toast({
              kind: "error",
              title: "Couldn't clear the records",
              description: error.message,
            });
            throw error;
          },
        )
      }
    />
  );
}
