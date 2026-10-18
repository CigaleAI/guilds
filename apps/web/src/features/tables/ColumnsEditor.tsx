import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { ColumnInput, ColumnType } from "../../api/types";
import {
  Button,
  IconButton,
  Checkbox,
  FormField,
  Select,
  TextField,
  Field,
  FieldInput,
  Icon,
  Tag,
} from "@guildsrun/ui";
import { columnTypes, maxValues } from "./values";

export function blankColumn(): ColumnInput {
  return { name: "", type: "text", description: "", required: false, unique: false };
}

type ColumnsEditorProps = {
  columns: ColumnInput[];
  onChange: (columns: ColumnInput[]) => void;
  /** Why each column cannot be saved, by index. */
  errors: Map<number, string>;
};

/** A table's columns: name, type, description, required, unique and allowed values, in order. */
export function ColumnsEditor({ columns, onChange, errors }: ColumnsEditorProps) {
  const update = (index: number, patch: Partial<ColumnInput>) =>
    onChange(columns.map((column, at) => (at === index ? { ...column, ...patch } : column)));
  const move = (index: number, by: number) => {
    const next = [...columns];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(index + by, 0, moved);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {columns.map((column, index) => {
        const takesValues = column.type === "text" || column.type === "array";
        const canBeUnique = column.type === "text" || column.type === "number";
        return (
          <div key={index} className="flex flex-col gap-3 rounded-lg bg-surface p-3">
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                tone="paper"
                label="Name"
                mono
                className="min-w-40 flex-1"
                value={column.name}
                onChange={(event) => update(index, { name: event.currentTarget.value })}
              />
              <Select
                tone="paper"
                label="Type"
                className="w-36"
                value={column.type}
                onValueChange={(value) => {
                  const type = value as ColumnType;
                  const next: ColumnInput = {
                    ...column,
                    type,
                    unique: type === "text" || type === "number" ? column.unique : false,
                  };
                  if (type !== "text" && type !== "array") delete next.values;
                  onChange(columns.map((item, at) => (at === index ? next : item)));
                }}
                options={columnTypes.map((type) => ({ value: type, label: type }))}
              />
              <div className="flex items-center gap-1 pb-1">
                <IconButton
                  icon={ArrowUp}
                  label="Move up"
                  variant="ghost"
                  size={28}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  icon={ArrowDown}
                  label="Move down"
                  variant="ghost"
                  size={28}
                  disabled={index === columns.length - 1}
                  onClick={() => move(index, 1)}
                />
                <IconButton
                  icon={X}
                  label={`Remove ${column.name || "this column"}`}
                  variant="ghost"
                  size={28}
                  onClick={() => onChange(columns.filter((_, at) => at !== index))}
                />
              </div>
            </div>
            <TextField
              tone="paper"
              label="Description"
              maxLength={200}
              placeholder="What agents should put here"
              value={column.description}
              onChange={(event) => update(index, { description: event.currentTarget.value })}
            />
            {takesValues ? (
              <ValuesField
                values={column.values ?? []}
                onChange={(values) => update(index, { values })}
              />
            ) : null}
            <div className="flex flex-wrap items-center gap-5">
              <Checkbox
                label="Required"
                checked={column.required}
                onCheckedChange={(checked) => update(index, { required: checked === true })}
              />
              <Checkbox
                label="Unique"
                checked={column.unique}
                disabled={!canBeUnique}
                onCheckedChange={(checked) => update(index, { unique: checked === true })}
              />
              {errors.get(index) ? (
                <span className="text-sm text-plum-t">{errors.get(index)}</span>
              ) : null}
            </div>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...columns, blankColumn()])}
      >
        <Icon icon={Plus} size={14} />
        Add column
      </Button>
    </div>
  );
}

function ValuesField({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const addDraft = () => {
    const text = draft.trim();
    setDraft("");
    if (!text || values.includes(text) || values.length >= maxValues) return;
    onChange([...values, text]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addDraft();
      return;
    }
    if (event.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <FormField controlId={id} label="Allowed values" aside="optional · Enter to add">
      <Field
        shape="rounded"
        tone="paper"
        className="min-h-10 flex-wrap gap-1.5 py-1.5"
        onClick={() => inputRef.current?.focus()}
      >
        {values.map((value) => (
          <Tag key={value} tone="term" className="max-w-full">
            <span className="truncate">{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              className="inline-flex text-muted hover:text-fg"
              onClick={() => onChange(values.filter((item) => item !== value))}
            >
              <Icon icon={X} size={14} />
            </button>
          </Tag>
        ))}
        <FieldInput
          ref={inputRef}
          id={id}
          value={draft}
          maxLength={64}
          disabled={values.length >= maxValues}
          placeholder={values.length ? "Add another" : "Type a value and press Enter"}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          onBlur={addDraft}
        />
      </Field>
    </FormField>
  );
}
