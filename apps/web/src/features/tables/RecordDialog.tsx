import { TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useAddRecord, useDeleteRecord, useUpdateRecord } from "../../api/queries/tables";
import type { Collection, CollectionRecord, Column } from "../../api/types/tables";
import { messageTime } from "../../app/format";
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
  toast,
  Icon,
  type FormFieldText,
} from "@guildsrun/ui";
import { fieldText, fits, parseField } from "./values";
import { LatestChange, useOpenStepInAgent } from "../notes/LatestChange";

const unset = "__unset__";

type FieldProps = {
  column: Column;
  text: string;
  onChange: (text: string) => void;
  error: string | undefined;
};

/** A column's field: a pick among its values, a text area for free text, or a typed input. */
function Field({ column, text, onChange, error }: FieldProps) {
  const label = column.required ? `${column.name} *` : column.name;
  const labels = { label, hint: column.description, ...(error ? { error } : {}) };
  if (column.type === "boolean" || (column.type === "text" && column.values?.length)) {
    return <ChoiceField column={column} text={text} onChange={onChange} labels={labels} />;
  }
  if (column.type === "text") {
    return (
      <TextAreaField
        tone="surface"
        font="sans"
        rows={2}
        {...labels}
        value={text}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  return <TypedField column={column} text={text} onChange={onChange} labels={labels} />;
}

type ChoiceFieldProps = {
  column: Column;
  text: string;
  onChange: (text: string) => void;
  labels: FormFieldText;
};

/** A boolean column, or a text column with allowed values: one of them, or not set. */
function ChoiceField({ column, text, onChange, labels }: ChoiceFieldProps) {
  const options =
    column.type === "boolean"
      ? [
          { value: "true", label: "true" },
          { value: "false", label: "false" },
        ]
      : (column.values ?? []).map((value) => ({ value, label: value }));
  return (
    <Select
      tone="surface"
      {...labels}
      value={text || unset}
      onValueChange={(value) => onChange(value === unset ? "" : value)}
      options={[{ value: unset, label: "(not set)" }, ...options]}
    />
  );
}

type TypedFieldProps = {
  column: Column;
  text: string;
  onChange: (text: string) => void;
  labels: FormFieldText;
};

/** A number, time or array column: an input of its type, an array's values comma-separated. */
function TypedField({ column, text, onChange, labels }: TypedFieldProps) {
  return (
    <TextField
      tone="surface"
      {...labels}
      mono={column.type !== "datetime"}
      type={
        column.type === "number" ? "number" : column.type === "datetime" ? "datetime-local" : "text"
      }
      step={column.type === "number" ? "any" : undefined}
      placeholder={
        column.type === "array"
          ? column.values?.length
            ? column.values.join(", ")
            : "a, b, c"
          : undefined
      }
      value={text}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

type RecordDialogProps = {
  collection: Collection;
  /** The record to edit; "new" for a new one; null keeps the dialog closed. */
  record: CollectionRecord | "new" | null;
  onClose: () => void;
};

/** One record: a field per column, with who last changed it, to add, save or delete. */
export function RecordDialog({ collection, record, onClose }: RecordDialogProps) {
  return (
    <Dialog open={record !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        {record ? (
          <RecordForm
            key={record === "new" ? "new" : `${record.id}:${record.version}`}
            collection={collection}
            record={record}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type RecordFormHeaderProps = {
  collection: Collection;
  record: CollectionRecord | "new";
};

/** Which record the form holds, and for a saved one who changed it last, when, and its version. */
function RecordFormHeader({ collection, record }: RecordFormHeaderProps) {
  if (record === "new") return <DialogHeader title="New record" description={collection.name} />;
  return (
    <DialogHeader
      title={`Record #${record.id}`}
      description={`${collection.name} · updated ${messageTime(record.updated_at)}${record.updated_by ? ` by ${record.updated_by}` : ""} · v${record.version}`}
    />
  );
}

type RecordFormProps = {
  collection: Collection;
  record: CollectionRecord | "new";
  onClose: () => void;
};

function RecordForm({ collection, record, onClose }: RecordFormProps) {
  const creating = record === "new";
  const add = useAddRecord(collection.id);
  const update = useUpdateRecord(collection.id);
  const remove = useDeleteRecord(collection.id);
  const openInAgent = useOpenStepInAgent(undefined);
  const initial = Object.fromEntries(
    collection.columns.map((column) => [
      column.name,
      creating ? "" : fieldText(record[column.name], column),
    ]),
  );
  const [texts, setTexts] = useState<Record<string, string>>(initial);
  const [tried, setTried] = useState(false);

  const parsed = collection.columns.map((column) => ({
    column,
    result: parseField(texts[column.name] ?? "", column),
  }));
  const errors = Object.fromEntries(
    parsed.flatMap(({ column, result }) => {
      if ("error" in result) return [[column.name, result.error]];
      if (column.required && result.value === null) return [[column.name, "Required."]];
      return [];
    }),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) return;
    if (creating) {
      const body = Object.fromEntries(
        parsed.flatMap(({ column, result }) =>
          "value" in result && result.value !== null ? [[column.name, result.value]] : [],
        ),
      );
      add.mutate(body, {
        onSuccess: ({ record: saved, merged }) => {
          toast({
            kind: "success",
            title: merged ? `Merged into record #${merged}` : `Added record #${saved.id}`,
          });
          onClose();
        },
      });
      return;
    }
    const body = Object.fromEntries(
      parsed.flatMap(({ column, result }) =>
        "value" in result && texts[column.name] !== initial[column.name]
          ? [[column.name, result.value]]
          : [],
      ),
    );
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    update.mutate(
      { recordId: record.id, body },
      {
        onSuccess: ({ warnings }) => {
          toast({
            kind: warnings.length ? "warning" : "success",
            title: `Saved record #${record.id}`,
            ...(warnings.length
              ? { description: `Still not fitting: ${warnings.join("; ")}` }
              : {}),
          });
          onClose();
        },
      },
    );
  };

  const failure = add.error ?? update.error ?? remove.error;

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <RecordFormHeader collection={collection} record={record} />
      <DialogBody>
        {!creating && record.display_path ? (
          <LatestChange
            displayPath={record.display_path}
            onOpenStep={(change) => {
              onClose();
              openInAgent(change);
            }}
          />
        ) : null}
        {collection.columns.map((column) => (
          <div key={column.name} className="flex flex-col gap-1">
            <Field
              column={column}
              text={texts[column.name] ?? ""}
              onChange={(text) => setTexts({ ...texts, [column.name]: text })}
              error={tried ? errors[column.name] : undefined}
            />
            {!creating && !fits(record[column.name], column) ? (
              <span className="flex items-center gap-1.5 text-xs text-t-ochre-fg">
                <Icon icon={TriangleAlert} size={14} />
                The stored value no longer fits this column.
              </span>
            ) : null}
          </div>
        ))}
        {failure ? (
          <Banner tone="error" title="Couldn't save the record">
            <span className="whitespace-pre-wrap">{failure.message}</span>
          </Banner>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {!creating ? (
          <Button
            variant="danger"
            className="mr-auto"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(record.id, {
                onSuccess: () => {
                  toast({ kind: "success", title: `Deleted record #${record.id}` });
                  onClose();
                },
              })
            }
          >
            Delete record
          </Button>
        ) : null}
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
        <Button type="submit" disabled={add.isPending || update.isPending}>
          {creating ? "Add record" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
