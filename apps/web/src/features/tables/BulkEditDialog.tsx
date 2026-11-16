import { useRef, useState, type FormEvent } from "react";
import { useUpdateRecordsInTurn } from "../../api/queries/tables";
import type { Collection, Column, RecordsUpdateOutcome } from "../../api/types/tables";
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Select,
  toast,
} from "@guildsrun/ui";
import {
  bulkEditBody,
  bulkEditTargets,
  chosenColumn,
  recordIdsText,
  recordsUpdatedToast,
} from "./bulkEdit";
import { RecordField } from "./RecordDialog";

type BulkEditDialogProps = {
  collection: Collection;
  /** The records to edit, as the selection held them when the dialog opened; null keeps it closed. */
  recordIds: readonly number[] | null;
  onClose: () => void;
};

/**
 * Sets one column to the same value on several records, checked as the record dialog checks it.
 * Each record is saved by its own request, one at a time; the records the server refuses are listed
 * with its reasons and stay in the dialog, and the next save sends to them only. A second save while
 * one runs sends nothing more, and the dialog stays open until it ends. A column chosen and then
 * gone from the table is named, and nothing is sent until another is chosen.
 */
export function BulkEditDialog({ collection, recordIds, onClose }: BulkEditDialogProps) {
  const update = useUpdateRecordsInTurn(collection.id);
  const [columnName, setColumnName] = useState("");
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [outcome, setOutcome] = useState<RecordsUpdateOutcome | null>(null);
  const running = useRef(false);
  const column = chosenColumn(collection.columns, columnName);
  const failed = outcome?.failed ?? [];
  const targets = bulkEditTargets(recordIds ?? [], failed);
  const result = column ? bulkEditBody(column, text, targets.length) : null;

  const close = () => {
    if (running.current) return;
    setColumnName("");
    setText("");
    setTried(false);
    setOutcome(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!column || !result || "error" in result || running.current) return;
    running.current = true;
    void update.mutateAsync({ recordIds: targets, body: result.body }).then((next) => {
      running.current = false;
      setOutcome(next);
      if (next.updated.length) toast(recordsUpdatedToast(column.name, next.updated));
      if (!next.failed.length) close();
    });
  };

  return (
    <Dialog open={recordIds !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={`Edit ${targets.length} ${targets.length === 1 ? "record" : "records"}`}
            description="Sets one column to the same value on each record; an empty field clears it. Each record is saved on its own and keeps its other values."
          />
          <DialogBody>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">Records {recordIdsText(targets)}</p>
              <Select
                tone="surface"
                label="Column"
                placeholder="Choose a column"
                value={column?.name ?? ""}
                disabled={update.isPending || failed.length > 0}
                onValueChange={(name) => {
                  setColumnName(name);
                  setText("");
                  setTried(false);
                }}
                options={collection.columns.map((item) => ({ value: item.name, label: item.name }))}
              />
              <BulkEditField
                columnName={columnName}
                column={column}
                text={text}
                onChange={setText}
                error={tried && result && "error" in result ? result.error : undefined}
              />
              <RecordsUpdateStatus outcome={outcome} />
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={update.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={update.isPending || !column}>
              {update.isPending ? "Saving…" : failed.length ? "Retry failed" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type BulkEditFieldProps = {
  /** The column chosen; empty before one is. */
  columnName: string;
  /** Its definition in the table; undefined when the table has no such column. */
  column: Column | undefined;
  text: string;
  onChange: (text: string) => void;
  error: string | undefined;
};

/** The chosen column's field, or that the table has lost it or has no column. */
function BulkEditField({ columnName, column, text, onChange, error }: BulkEditFieldProps) {
  if (!column) {
    return (
      <Banner
        tone="error"
        title={
          columnName
            ? `${columnName} is no longer a column of this table`
            : "This table has no columns"
        }
      />
    );
  }
  return (
    <RecordField key={column.name} column={column} text={text} onChange={onChange} error={error} />
  );
}

type RecordsUpdateStatusProps = { outcome: RecordsUpdateOutcome | null };

/**
 * What the last save did to each record: those it saved, and those it could not with the server's
 * reason; nothing before a save or when every record was saved.
 */
function RecordsUpdateStatus({ outcome }: RecordsUpdateStatusProps) {
  if (!outcome?.failed.length) return null;
  const { updated, failed } = outcome;
  return (
    <>
      {updated.length ? (
        <p className="text-sm">Saved {recordIdsText(updated.map((item) => item.recordId))}</p>
      ) : null}
      <Banner
        tone="error"
        title={`Couldn't save ${failed.length} ${failed.length === 1 ? "record" : "records"}`}
      >
        {failed.map((failure) => (
          <span key={failure.recordId} className="block whitespace-pre-wrap">
            #{failure.recordId}: {failure.reason}
          </span>
        ))}
      </Banner>
    </>
  );
}
