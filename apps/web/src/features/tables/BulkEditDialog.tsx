import { useRef, useState, type FormEvent } from "react";
import { useUpdateRecordsInTurn } from "../../api/queries/tables";
import type { Collection, RecordUpdateFailure } from "../../api/types/tables";
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
import { bulkEditBody, recordsUpdatedToast } from "./bulkEdit";
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
 * one runs sends nothing more, and the dialog stays open until it ends.
 */
export function BulkEditDialog({ collection, recordIds, onClose }: BulkEditDialogProps) {
  const update = useUpdateRecordsInTurn(collection.id);
  const [columnName, setColumnName] = useState(collection.columns[0]?.name ?? "");
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [failed, setFailed] = useState<readonly RecordUpdateFailure[]>([]);
  const running = useRef(false);
  const column = collection.columns.find((item) => item.name === columnName) ?? collection.columns[0];
  const targets = failed.length ? failed.map((failure) => failure.recordId) : (recordIds ?? []);

  const close = () => {
    if (running.current) return;
    setColumnName(collection.columns[0]?.name ?? "");
    setText("");
    setTried(false);
    setFailed([]);
    onClose();
  };

  if (!column) return null;
  const result = bulkEditBody(column, text);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if ("error" in result || running.current) return;
    running.current = true;
    void update.mutateAsync({ recordIds: targets, body: result.body }).then((outcome) => {
      running.current = false;
      setFailed(outcome.failed);
      if (outcome.updated.length) toast(recordsUpdatedToast(column.name, outcome.updated));
      if (!outcome.failed.length) close();
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
              <Select
                tone="surface"
                label="Column"
                value={column.name}
                disabled={update.isPending || failed.length > 0}
                onValueChange={(name) => {
                  setColumnName(name);
                  setText("");
                  setTried(false);
                }}
                options={collection.columns.map((item) => ({ value: item.name, label: item.name }))}
              />
              <RecordField
                key={column.name}
                column={column}
                text={text}
                onChange={setText}
                error={tried && "error" in result ? result.error : undefined}
              />
              <RecordUpdateFailures failed={failed} />
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={update.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : failed.length ? "Retry failed" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type RecordUpdateFailuresProps = { failed: readonly RecordUpdateFailure[] };

/** The records the last save could not change, each with the server's reason; nothing when none. */
function RecordUpdateFailures({ failed }: RecordUpdateFailuresProps) {
  if (!failed.length) return null;
  return (
    <Banner tone="error" title={`Couldn't save ${failed.length} ${failed.length === 1 ? "record" : "records"}`}>
      {failed.map((failure) => (
        <span key={failure.recordId} className="block whitespace-pre-wrap">
          #{failure.recordId}: {failure.reason}
        </span>
      ))}
    </Banner>
  );
}
