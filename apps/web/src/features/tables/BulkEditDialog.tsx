import { useRef, useState, type FormEvent } from "react";
import { useUpdateRecordsInTurn } from "../../api/queries/tables";
import type {
  Collection,
  Column,
  RecordChanges,
  RecordsUpdateOutcome,
} from "../../api/types/tables";
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  toast,
} from "@guildsrun/ui";
import {
  bulkEditBody,
  bulkEditSends,
  bulkEditTargets,
  chosenColumn,
  recordIdsText,
  recordsUpdatedToast,
} from "./bulkEdit";
import { RecordField } from "./RecordDialog";

/** What a bulk edit sets: one column, on the records selected for it. */
export type BulkEdit = { columnName: string; recordIds: readonly number[] };

type BulkEditDialogProps = {
  collection: Collection;
  /** The column and records, as the selection held them when the dialog opened; null keeps it closed. */
  edit: BulkEdit | null;
  onClose: () => void;
};

/**
 * Sets the selection's column to the same value on its records, checked as the record dialog checks
 * it. Each record is saved by its own request, one at a time. The first save fixes the value: the
 * field stays off from then on, the records the server refuses are listed with its reasons and stay
 * in the dialog, and the next save sends them the same value, to them only. A second save while one
 * runs sends nothing more, and the dialog stays open until it ends. A column the table loses is
 * named, and nothing is sent.
 */
export function BulkEditDialog({ collection, edit, onClose }: BulkEditDialogProps) {
  const update = useUpdateRecordsInTurn(collection.id);
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<RecordChanges | null>(null);
  const [outcome, setOutcome] = useState<RecordsUpdateOutcome | null>(null);
  const running = useRef(false);
  const columnName = edit?.columnName ?? "";
  const column = chosenColumn(collection.columns, columnName);
  const targets = bulkEditTargets(edit?.recordIds ?? [], outcome?.failed ?? []);
  const result = column ? bulkEditBody(column, text, targets.length) : null;
  const body = bulkEditSends(sent, result);

  const close = () => {
    if (running.current) return;
    setText("");
    setTried(false);
    setSent(null);
    setOutcome(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!column || !body || running.current) return;
    running.current = true;
    setSent(body);
    void update.mutateAsync({ recordIds: targets, body }).then((next) => {
      running.current = false;
      setOutcome(next);
      if (next.updated.length) toast(recordsUpdatedToast(column.name, next.updated));
      if (!next.failed.length) close();
    });
  };

  return (
    <Dialog open={edit !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader
            title={`Edit ${targets.length} ${targets.length === 1 ? "record" : "records"}`}
            description="Sets one column to the same value on each record; an empty field clears it. Each record is saved on its own and keeps its other values."
          />
          <DialogBody>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                Column {columnName} · Records {recordIdsText(targets)}
              </p>
              <BulkEditField
                columnName={columnName}
                column={column}
                text={text}
                onChange={setText}
                tried={tried}
                result={result}
                disabled={sent !== null}
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
            <BulkEditSaveButton
              saving={update.isPending}
              retrying={outcome !== null}
              disabled={!column}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type BulkEditFieldProps = {
  /** The column chosen. */
  columnName: string;
  /** Its definition in the table; undefined when the table has no such column. */
  column: Column | undefined;
  text: string;
  onChange: (text: string) => void;
  /** Whether a save was pressed, after which the field names why its value is refused. */
  tried: boolean;
  /** What the field's value sends, or why it is refused; null without a column. */
  result: ReturnType<typeof bulkEditBody> | null;
  disabled: boolean;
};

/** The chosen column's field, or that the table has lost it. */
function BulkEditField({
  columnName,
  column,
  text,
  onChange,
  tried,
  result,
  disabled,
}: BulkEditFieldProps) {
  const error = tried && result && "error" in result ? result.error : undefined;
  if (!column) {
    return <Banner tone="error" title={`${columnName} is no longer a column of this table`} />;
  }
  return (
    <RecordField
      column={column}
      text={text}
      onChange={onChange}
      error={error}
      disabled={disabled}
    />
  );
}

type BulkEditSaveButtonProps = {
  saving: boolean;
  /** Whether the save sends to the records the last one refused. */
  retrying: boolean;
  disabled: boolean;
};

/** The dialog's submit button, named for a first save, a retry, or a save running. */
function BulkEditSaveButton({ saving, retrying, disabled }: BulkEditSaveButtonProps) {
  return (
    <Button type="submit" disabled={saving || disabled}>
      {saving ? "Saving…" : retrying ? "Retry failed" : "Save changes"}
    </Button>
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
