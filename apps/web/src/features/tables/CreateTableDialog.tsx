import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useCreateDatabase } from "../../api/queries/tables";
import type { ColumnInput } from "../../api/types/tables";
import {
  Button,
  TextAreaField,
  TextField,
  Banner,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@guildsrun/ui";
import { blankColumn, ColumnsEditor } from "./ColumnsEditor";
import { orgScope, TableScopeSelect } from "./TableScope";
import { columnErrors, columnsForSave, isNewTableReady, tableNameError } from "./values";

type CreateTableDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The guild to own it at first, when created from a guild. */
  guildId?: string;
};

/** A new table: its name, purpose, whether one guild owns it, and its columns. */
export function CreateTableDialog({ open, onOpenChange, guildId }: CreateTableDialogProps) {
  const navigate = useNavigate();
  const create = useCreateDatabase();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState(guildId ?? orgScope);
  const [columns, setColumns] = useState<ColumnInput[]>([blankColumn()]);
  const [tried, setTried] = useState(false);

  const nameError = name.trim() ? tableNameError(name) : undefined;
  const errors = columnErrors(columns);
  const invalid = !isNewTableReady(name, purpose, columns);

  const close = () => {
    setName("");
    setPurpose("");
    setScope(guildId ?? orgScope);
    setColumns([blankColumn()]);
    setTried(false);
    create.reset();
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (invalid) return;
    create.mutate(
      {
        name: name.trim(),
        purpose: purpose.trim(),
        columns: columnsForSave(columns),
        guild_id: scope === orgScope ? null : scope,
      },
      {
        onSuccess: (collection) => {
          close();
          void navigate({
            to: "/tables/$collectionId",
            params: { collectionId: collection.id },
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="lg">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title="New table"
            description="Records with typed columns that agents search and write."
          />
          <DialogBody>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                tone="surface"
                label="Name"
                mono
                required
                autoFocus
                maxLength={63}
                placeholder="degen-projects"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                {...(nameError ? { error: nameError } : {})}
              />
              <TableScopeSelect
                hint={
                  scope === orgScope
                    ? "Every agent of the organisation starts with read; change it on its Access tab."
                    : "This guild's agents start with read and write; change it on its Access tab."
                }
                value={scope}
                onValueChange={setScope}
              />
            </div>
            <TextAreaField
              tone="surface"
              label="Purpose"
              font="sans"
              required
              rows={2}
              maxLength={400}
              showCount
              placeholder="What this table tracks, for the agents that use it"
              value={purpose}
              onChange={(event) => setPurpose(event.currentTarget.value)}
            />
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Columns</span>
              <ColumnsEditor
                columns={columns}
                onChange={setColumns}
                errors={tried ? errors : new Map()}
              />
            </div>
            {tried && invalid && !create.isError ? (
              <Banner tone="warning" title="Some fields need attention">
                Give the table a name, a purpose and at least one complete column.
              </Banner>
            ) : null}
            {create.isError ? (
              <Banner tone="error" title="Couldn't create the table">
                <span className="whitespace-pre-wrap">{create.error.message}</span>
              </Banner>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create table"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
