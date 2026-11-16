import type { ToastOptions } from "@guildsrun/ui";
import type {
  CollectionRecord,
  Column,
  RecordChanges,
  RecordUpdated,
  RecordUpdateFailure,
} from "../../api/types/tables";
import { fieldError, parseField } from "./values";

/** The ids of the shown records that are in the selection, in the order shown. */
export function recordsInSelection(
  records: readonly CollectionRecord[],
  selectionIds: ReadonlySet<number>,
): number[] {
  return records.flatMap((record) => (selectionIds.has(record.id) ? [record.id] : []));
}

/**
 * What a bulk edit of one column sends to each of its records: the field's text as the column's
 * value, null when empty; or why the column cannot take it, as the record dialog checks it. A unique
 * column holds a value on one record at most, so a value for several records is refused.
 */
export function bulkEditBody(
  column: Column,
  text: string,
  recordCount: number,
): { body: RecordChanges } | { error: string } {
  const error = fieldError(text, column);
  if (error) return { error };
  const parsed = parseField(text, column);
  if ("error" in parsed) return parsed;
  if (column.unique && parsed.value !== null && recordCount > 1) {
    return { error: "Unique: one record at most can hold a value. Clear it, or edit one record." };
  }
  return { body: { [column.name]: parsed.value } };
}

/**
 * What a bulk edit's next save sends: the first save's value, which stays fixed for every retry;
 * before one, the field's value when its column takes it; else nothing.
 */
export function bulkEditSends(
  sent: RecordChanges | null,
  result: ReturnType<typeof bulkEditBody> | null,
): RecordChanges | null {
  if (sent) return sent;
  return result && "body" in result ? result.body : null;
}

/** The column a bulk edit sets: the one named; undefined before one is chosen, or once the table lost it. */
export function chosenColumn(columns: readonly Column[], columnName: string): Column | undefined {
  return columns.find((column) => column.name === columnName);
}

/** The records a bulk edit's next save sends to: those the last one refused, or else every one asked. */
export function bulkEditTargets(
  recordIds: readonly number[],
  failed: readonly RecordUpdateFailure[],
): readonly number[] {
  return failed.length ? failed.map((failure) => failure.recordId) : recordIds;
}

/** Record ids as the dialogs name them: `#1, #2`. */
export function recordIdsText(recordIds: readonly number[]): string {
  return recordIds.map((recordId) => `#${recordId}`).join(", ");
}

/** The toast after a bulk edit saved some records: how many, and the values that still do not fit. */
export function recordsUpdatedToast(
  columnName: string,
  updated: readonly RecordUpdated[],
): ToastOptions {
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
