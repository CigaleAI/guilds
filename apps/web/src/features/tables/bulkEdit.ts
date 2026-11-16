import type { ToastOptions } from "@guildsrun/ui";
import type { CollectionRecord, Column, RecordChanges, RecordUpdated } from "../../api/types/tables";
import { fieldError, parseField } from "./values";

/** The ids of the shown records that are in the selection, in the order shown. */
export function recordsInSelection(
  records: readonly CollectionRecord[],
  selectionIds: ReadonlySet<number>,
): number[] {
  return records.flatMap((record) => (selectionIds.has(record.id) ? [record.id] : []));
}

/**
 * What a bulk edit of one column sends to each record: the field's text as the column's value, null
 * when empty; or why the column cannot take it, as the record dialog checks it.
 */
export function bulkEditBody(column: Column, text: string): { body: RecordChanges } | { error: string } {
  const error = fieldError(text, column);
  if (error) return { error };
  const parsed = parseField(text, column);
  return "value" in parsed ? { body: { [column.name]: parsed.value } } : parsed;
}

/** The toast after a bulk edit saved some records: how many, and the values that still do not fit. */
export function recordsUpdatedToast(columnName: string, updated: readonly RecordUpdated[]): ToastOptions {
  const warned = updated.filter(({ warnings }) => warnings.length > 0);
  return {
    kind: warned.length ? "warning" : "success",
    title: `Saved ${columnName} on ${updated.length} ${updated.length === 1 ? "record" : "records"}`,
    ...(warned.length
      ? {
          description: `Still not fitting: ${warned
            .map(({ recordId, warnings }) => `#${recordId}: ${warnings.join("; ")}`)
            .join("\n")}`,
        }
      : {}),
  };
}
