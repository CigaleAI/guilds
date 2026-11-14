import { Pencil } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useUpdateRecord } from "../../api/queries/tables";
import type { CollectionRecord, Column } from "../../api/types/tables";
import {
  Banner,
  Button,
  IconButton,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@guildsrun/ui";
import { RecordField, toastRecordSaved } from "./RecordDialog";
import { fieldError, fieldText, recordChanges } from "./values";

type EditableCellProps = {
  collectionId: string;
  record: CollectionRecord;
  column: Column;
  /** The value as the grid shows it. */
  children: ReactNode;
};

/** A record's value in the grid, with a pencil that edits it in place with the record dialog's field. */
export function EditableCell({ collectionId, record, column, children }: EditableCellProps) {
  const [open, setOpen] = useState(false);
  return (
    <span className="group/cell flex items-center gap-1">
      <span className="min-w-0 flex-1">{children}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <IconButton
            icon={Pencil}
            label={`Edit ${column.name} of record #${record.id}`}
            variant="ghost"
            size={24}
            className="opacity-0 group-hover/cell:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          />
        </PopoverTrigger>
        {/* The popover renders outside the row, but its clicks still bubble to the row and open the dialog. */}
        <PopoverContent className="w-80" onClick={(event) => event.stopPropagation()}>
          <CellForm
            key={`${record.id}:${record.version}`}
            collectionId={collectionId}
            record={record}
            column={column}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </span>
  );
}

type CellFormProps = {
  collectionId: string;
  record: CollectionRecord;
  column: Column;
  onClose: () => void;
};

/** One field of a saved record, checked as the record dialog checks it and sent only when changed. */
function CellForm({ collectionId, record, column, onClose }: CellFormProps) {
  const update = useUpdateRecord(collectionId);
  const loaded = fieldText(record[column.name], column);
  const [text, setText] = useState(loaded);
  const [tried, setTried] = useState(false);
  const error = fieldError(text, column);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (error) return;
    const body = recordChanges([column], { [column.name]: text }, { [column.name]: loaded });
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    update.mutate(
      { recordId: record.id, body },
      {
        onSuccess: ({ warnings }) => {
          toastRecordSaved(record.id, warnings);
          onClose();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <RecordField
        column={column}
        text={text}
        onChange={setText}
        error={tried ? error : undefined}
      />
      {update.error ? (
        <Banner tone="error" title="Couldn't save the record">
          <span className="whitespace-pre-wrap">{update.error.message}</span>
        </Banner>
      ) : null}
      <div className="flex justify-end gap-2">
        <PopoverClose asChild>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
        </PopoverClose>
        <Button type="submit" size="sm" disabled={update.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
