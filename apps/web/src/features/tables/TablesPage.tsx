import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Database, Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  useDatabase,
  useDatabases,
  useDeleteDatabase,
  useUpdateDatabase,
} from "../../api/queries/tables";
import { useGuilds } from "../../api/queries/guilds";
import { useItemAccess } from "../../api/queries/access";
import type { Collection, ColumnInput } from "../../api/types/tables";
import { relativeTime } from "../../app/format";
import { useMediaQuery, wideScreen } from "../../app/media";
import {
  cn,
  Button,
  IconButton,
  Segmented,
  Select,
  TextAreaField,
  TextField,
  DatabaseItem,
  ListGroupLabel,
  Banner,
  EmptyState,
  SkeletonRows,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
  Icon,
  Tag,
} from "@guildsrun/ui";
import { AccessListPanel } from "../access/AccessListPanel";
import { ColumnsEditor } from "./ColumnsEditor";
import { CreateTableDialog } from "./CreateTableDialog";
import { RecordsPanel } from "./RecordsPanel";
import {
  columnErrors,
  columnsForSave,
  describeChanges,
  isTableTab,
  tableName,
  tableTabs,
} from "./values";

export type TableTab = (typeof tableTabs)[number];

function scopeLabel(collection: Collection): string {
  return collection.guild ? `Guild · ${collection.guild.name}` : "Organisation";
}

/**
 * The organisation's tables: the list by where each belongs, and the open one's records, columns
 * and access list.
 */
export function TablesPage() {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const wide = useMediaQuery(wideScreen);
  const tables = useDatabases();
  const [creating, setCreating] = useState(false);

  const list = tables.data ?? [];
  const selectedId = params.collectionId ?? (wide ? list[0]?.id : undefined);
  const showingList = wide || !params.collectionId;
  const showingDetail = Boolean(selectedId) && (wide || Boolean(params.collectionId));
  const showingSection =
    showingDetail || (wide && !selectedId) || (!wide && !list.length && !tables.isPending);
  const groups = [
    { label: "Organisation", items: list.filter((item) => !item.guild) },
    ...[...new Set(list.flatMap((item) => (item.guild ? [item.guild.name] : [])))]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ label: name, items: list.filter((item) => item.guild?.name === name) })),
  ].filter((group) => group.items.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        className={cn(
          "min-h-0 flex-col gap-3 border-b border-line p-4 md:flex md:w-80 md:flex-none md:border-r md:border-b-0",
          showingList ? "flex flex-1" : "hidden",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <h1 className="type-h2">Tables</h1>
          <IconButton
            icon={Plus}
            label="New table"
            variant="surface"
            onClick={() => setCreating(true)}
          />
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto">
          {tables.isPending ? (
            <SkeletonRows rows={5} label="Loading tables" />
          ) : tables.isError ? (
            <Banner tone="error" title="Couldn't load the tables" meta={tables.error.message} />
          ) : (
            groups.map((group) => (
              <div key={group.label} className="flex flex-col gap-1">
                <ListGroupLabel>{group.label}</ListGroupLabel>
                {group.items.map((item) => (
                  <DatabaseItem
                    key={item.id}
                    name={item.name}
                    purpose={item.purpose}
                    count={item.count ?? 0}
                    age={relativeTime(item.updated_at)}
                    selected={item.id === selectedId}
                    onClick={() =>
                      void navigate({
                        to: "/tables/$collectionId",
                        params: { collectionId: item.id },
                      })
                    }
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </aside>
      <section
        className={cn("min-h-0 min-w-0 flex-1 flex-col", showingSection ? "flex" : "hidden")}
      >
        {selectedId ? (
          <TableDetail
            key={selectedId}
            id={selectedId}
            tab={isTableTab(search.tab) ? search.tab : "records"}
            onTab={(tab) =>
              void navigate({
                to: "/tables/$collectionId",
                params: { collectionId: selectedId },
                search: tab === "records" ? {} : { tab },
              })
            }
            {...(!wide && params.collectionId
              ? { onBack: () => void navigate({ to: "/tables" }) }
              : {})}
          />
        ) : tables.isPending ? null : (
          <div className="grid flex-1 place-items-center p-6">
            <EmptyState
              icon={Database}
              title="No tables yet"
              description="Tables hold records with typed columns that agents search and write."
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  New table
                </Button>
              }
            />
          </div>
        )}
      </section>
      <CreateTableDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

type TableDetailProps = {
  id: string;
  tab: TableTab;
  onTab: (tab: TableTab) => void;
  onBack?: () => void;
};

function TableDetail({ id, tab, onTab, onBack }: TableDetailProps) {
  const navigate = useNavigate();
  const table = useDatabase(id);
  const remove = useDeleteDatabase();
  const access = useItemAccess({ kind: "collection", id });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (table.isPending) {
    return (
      <div className="p-6">
        <SkeletonRows rows={6} label="Loading the table" />
      </div>
    );
  }
  if (table.isError) {
    return (
      <div className="p-6">
        <Banner tone="error" title="Couldn't load the table" meta={table.error.message} />
      </div>
    );
  }
  const collection = table.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-2 border-b border-line px-4 py-3 md:gap-3 md:px-6 md:py-5">
        <div className="flex flex-wrap items-center gap-2 md:gap-2.5">
          {onBack ? (
            <IconButton
              icon={ArrowLeft}
              label="Back to tables"
              variant="ghost"
              size={28}
              onClick={onBack}
            />
          ) : null}
          <h2 className="font-mono text-lg font-medium md:text-2xl">{collection.name}</h2>
          <Tag tone={collection.guild ? "tide" : "signal"} font="sans">
            {scopeLabel(collection)}
          </Tag>
          <span className="type-meta text-muted">
            {collection.count ?? 0} records · {collection.columns.length} columns
          </span>
          <span className="flex-1" />
          <IconButton
            icon={Pencil}
            label="Edit name, purpose and owner"
            variant="surface"
            onClick={() => setEditing(true)}
          />
          <Button asChild variant="outline" size="md">
            <a
              href={`/api/collections/${encodeURIComponent(id)}/export`}
              download={`${collection.name}.jsonl`}
            >
              <Icon icon={Download} size={14} />
              <span className="sr-only sm:not-sr-only">Export</span>
            </a>
          </Button>
          <Button variant="danger" size="md" onClick={() => setDeleting(true)}>
            <Icon icon={Trash2} size={14} />
            <span className="sr-only sm:not-sr-only">Delete</span>
          </Button>
        </div>
        <p className="line-clamp-2 text-sm text-fg-2 md:line-clamp-none">{collection.purpose}</p>
        <Segmented
          size="sm"
          label="Table view"
          value={tab}
          onValueChange={onTab}
          options={[
            { value: "records", label: "Records", count: collection.count ?? 0 },
            { value: "columns", label: "Columns", count: collection.columns.length },
            { value: "access", label: "Access", count: access.data?.subjects.length ?? 0 },
          ]}
        />
      </header>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          tab === "records" ? "py-4 md:py-5" : "px-4 py-4 md:px-6 md:py-5",
        )}
      >
        {tab === "records" ? (
          <RecordsPanel collection={collection} />
        ) : tab === "columns" ? (
          <ColumnsTab collection={collection} />
        ) : (
          <AccessListPanel
            target={{ kind: "collection", id }}
            intro={`Who reads and writes ${collection.name}. Where it belongs only places it; this list decides who reaches it.`}
          />
        )}
      </div>
      <EditTableDialog collection={collection} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        kind="destructive"
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${collection.name}?`}
        description={`The table and its ${collection.count ?? 0} records are removed; every guild and agent loses it at once.`}
        confirmLabel="Delete table"
        confirmText={collection.name}
        onConfirm={() =>
          remove.mutateAsync(id).then(
            () => {
              toast({ kind: "success", title: `${collection.name} deleted` });
              void navigate({ to: "/tables" });
            },
            (error: Error) => {
              toast({
                kind: "error",
                title: "Couldn't delete the table",
                description: error.message,
              });
              throw error;
            },
          )
        }
      />
    </div>
  );
}

/** The columns as saved, each tagged with its own name so a rename is sent as one. */
function columnsOf(collection: Collection): ColumnInput[] {
  return collection.columns.map((column) => ({ ...column, rename_from: column.name }));
}

type ColumnsTabProps = { collection: Collection };

function ColumnsTab({ collection }: ColumnsTabProps) {
  const update = useUpdateDatabase(collection.id);
  const [draft, setDraft] = useState<ColumnInput[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const columns = draft ?? columnsOf(collection);
  const errors = columnErrors(columns);
  const changes = describeChanges(collection.columns, columns);
  const dirty = draft !== null && changes.length > 0;
  const reshapes =
    (collection.count ?? 0) > 0 &&
    changes.some(
      (change) => !change.startsWith("Add ") && !change.startsWith("Change the description of "),
    );

  const columnsUpdate = { columns: columnsForSave(columns) };
  const saveToasts = {
    onSuccess: () => {
      setDraft(null);
      toast({ kind: "success", title: "Columns saved" });
    },
    onError: (error: Error) =>
      toast({ kind: "error", title: "Couldn't save the columns", description: error.message }),
  };

  return (
    <div className="flex flex-col gap-4">
      <ColumnsEditor columns={columns} onChange={setDraft} errors={errors} />
      <div className="sticky bottom-0 flex items-center justify-end gap-2 rounded-lg bg-surface px-4 py-3">
        {dirty ? (
          <span className="mr-auto text-sm text-muted">{changes.length} unsaved changes</span>
        ) : null}
        <Button
          variant="ghost"
          disabled={!dirty || update.isPending}
          onClick={() => setDraft(null)}
        >
          Discard
        </Button>
        <Button
          disabled={!dirty || errors.size > 0 || update.isPending}
          onClick={() =>
            reshapes ? setConfirming(true) : update.mutate(columnsUpdate, saveToasts)
          }
        >
          Save columns
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Apply to ${collection.name}'s ${collection.count ?? 0} records?`}
        description={
          <ul className="list-disc pl-5">
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        }
        confirmLabel="Apply"
        onConfirm={() => update.mutateAsync(columnsUpdate, saveToasts)}
      />
    </div>
  );
}

const orgScope = "org";

type EditTableDialogProps = {
  collection: Collection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function EditTableDialog({ collection, open, onOpenChange }: EditTableDialogProps) {
  const guilds = useGuilds();
  const update = useUpdateDatabase(collection.id);
  const [name, setName] = useState(collection.name);
  const [purpose, setPurpose] = useState(collection.purpose);
  const [scope, setScope] = useState(collection.guild?.id ?? orgScope);
  const moving = scope !== (collection.guild?.id ?? orgScope);
  const nameError = tableName.test(name.trim())
    ? undefined
    : "Lowercase letters, digits, _ and -, starting with a letter.";
  const target = guilds.data?.find((guild) => guild.id === scope)?.name;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (nameError || !purpose.trim()) return;
    update.mutate(
      {
        name: name.trim(),
        purpose: purpose.trim(),
        ...(moving ? { guild_id: scope === orgScope ? null : scope } : {}),
      },
      {
        onSuccess: () => {
          toast({ kind: "success", title: "Table saved" });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader title={`Edit ${collection.name}`} />
          <DialogBody>
            <TextField
              tone="surface"
              label="Name"
              mono
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              {...(nameError ? { error: nameError } : {})}
            />
            <TextAreaField
              tone="surface"
              label="Purpose"
              font="sans"
              rows={2}
              maxLength={400}
              showCount
              value={purpose}
              onChange={(event) => setPurpose(event.currentTarget.value)}
            />
            <Select
              tone="surface"
              label="Belongs to"
              value={scope}
              onValueChange={setScope}
              options={[
                { value: orgScope, label: "The organisation" },
                ...(guilds.data ?? []).map((guild) => ({ value: guild.id, label: guild.name })),
              ]}
            />
            {moving ? (
              <Banner
                tone="info"
                title={
                  scope === orgScope
                    ? "Moving to the organisation"
                    : `Moving to ${target ?? "a guild"}`
                }
              >
                Only where it is listed changes. Its access list stays as it is; change who reaches
                it on the Access tab.
              </Banner>
            ) : null}
            {update.isError ? (
              <Banner tone="error" title="Couldn't save the table">
                {update.error.message}
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
