import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useCreateDatabase, useGuilds } from "../../api/queries";
import type { ColumnInput } from "../../api/types";
import {
  Button,
  Select,
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
import { columnErrors, columnsForSave, tableName } from "./values";

const orgScope = "org";

/** A new table: its name, purpose, whether one guild owns it, and its columns. */
export function CreateTableDialog({
  open,
  onOpenChange,
  guildId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The guild to own it at first, when created from a guild. */
  guildId?: string;
}) {
  const navigate = useNavigate();
  const guilds = useGuilds();
  const create = useCreateDatabase();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState(guildId ?? orgScope);
  const [columns, setColumns] = useState<ColumnInput[]>([blankColumn()]);
  const [tried, setTried] = useState(false);

  const nameError =
    name.trim() && !tableName.test(name.trim())
      ? "Lowercase letters, digits, _ and -, starting with a letter."
      : undefined;
  const errors = columnErrors(columns);
  const invalid =
    !name.trim() ||
    Boolean(nameError) ||
    !purpose.trim() ||
    columns.length === 0 ||
    errors.size > 0;

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
              <Select
                tone="surface"
                label="Belongs to"
                hint={
                  scope === orgScope
                    ? "Guilds and agents reach it through grants."
                    : "Only this guild's agents reach it, and they write it."
                }
                value={scope}
                onValueChange={setScope}
                options={[
                  { value: orgScope, label: "The organisation" },
                  ...(guilds.data ?? []).map((guild) => ({ value: guild.id, label: guild.name })),
                ]}
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
