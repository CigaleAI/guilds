import type { Column, ColumnInput, ColumnType } from "../../api/types/tables";

export const columnTypes: ColumnType[] = ["text", "number", "boolean", "datetime", "array"];

/** Fields every record has, which no column may be named. */
const reservedColumns = ["id", "created_at", "updated_at", "created_by", "updated_by"];
const columnName = /^[a-z][a-z0-9_]{0,63}$/;
export const tableName = /^[a-z][a-z0-9_-]{0,62}$/;
const maxColumns = 64;
export const maxValues = 50;
/** A column's description is instructions every agent that reads the table gets in State. */
export const maxColumnDescription = 1000;

/** Whether a stored value still fits its column; a changed column can leave old values behind. */
export function fits(value: unknown, column: Column): boolean {
  if (value === null || value === undefined) return true;
  switch (column.type) {
    case "text":
      return typeof value === "string" && (!column.values?.length || column.values.includes(value));
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "array":
      return (
        Array.isArray(value) &&
        value.every(
          (item) =>
            typeof item === "string" && (!column.values?.length || column.values.includes(item)),
        )
      );
  }
}

/** A value as the form shows it: arrays as comma-separated text, datetimes in local time. */
export function fieldText(value: unknown, column: Column): string {
  if (value === null || value === undefined) return "";
  if (column.type === "array" && Array.isArray(value)) return value.join(", ");
  if (column.type === "datetime" && typeof value === "string") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  return String(value);
}

/** What the form's text means for its column: a value, null when empty, or why it cannot be. */
export function parseField(text: string, column: Column): { value: unknown } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null };
  switch (column.type) {
    case "text":
      return { value: text };
    case "number": {
      const number = Number(trimmed);
      return Number.isFinite(number) ? { value: number } : { error: "A number." };
    }
    case "boolean":
      return trimmed === "true" || trimmed === "false"
        ? { value: trimmed === "true" }
        : { error: "true or false." };
    case "datetime": {
      const date = new Date(trimmed);
      return Number.isNaN(date.getTime())
        ? { error: "A date and time." }
        : { value: date.toISOString() };
    }
    case "array":
      return {
        value: trimmed
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      };
  }
}

/** A filter on one column: a value, or a range for numbers and times. */
export type ColumnFilter = { value?: string; from?: string; to?: string };

/** The server's `where` from the filters set; text and arrays match what they contain. */
export function whereOf(
  filters: Record<string, ColumnFilter>,
  columns: readonly Column[],
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const [name, filter] of Object.entries(filters)) {
    if (name === "id") {
      if (filter.value?.trim()) where.id = Number(filter.value);
      continue;
    }
    const column = columns.find((item) => item.name === name);
    if (!column) continue;
    if (column.type === "number" || column.type === "datetime") {
      const convert = (text: string) =>
        column.type === "number" ? Number(text) : new Date(text).toISOString();
      const from = filter.from?.trim() ? convert(filter.from) : undefined;
      const to = filter.to?.trim() ? convert(filter.to) : undefined;
      if (from !== undefined && to !== undefined && from === to) where[name] = from;
      else if (from !== undefined || to !== undefined) {
        where[name] = {
          ...(from !== undefined ? { gte: from } : {}),
          ...(to !== undefined ? { lte: to } : {}),
        };
      }
    } else if (filter.value !== undefined && filter.value !== "") {
      if (filter.value === "(empty)") where[name] = null;
      else if (column.type === "boolean") where[name] = filter.value === "true";
      else where[name] = filter.value;
    }
  }
  return where;
}

/** Columns as the server accepts them: names trimmed, empty allowed-values lists omitted. */
export function columnsForSave(columns: readonly ColumnInput[]): ColumnInput[] {
  return columns.map((column) => {
    const { values, ...rest } = column;
    const next: ColumnInput = {
      ...rest,
      name: column.name.trim(),
      description: column.description.trim(),
    };
    if ((next.type === "text" || next.type === "array") && values?.length) {
      next.values = values;
    }
    return next;
  });
}

/** Why a set of columns cannot be saved, by column index; the empty map means it can. */
export function columnErrors(columns: readonly ColumnInput[]): Map<number, string> {
  const errors = new Map<number, string>();
  const seen = new Set<string>();
  columns.forEach((column, index) => {
    const name = column.name.trim();
    if (!columnName.test(name))
      errors.set(index, "Lowercase letters, digits and _, starting with a letter.");
    else if (reservedColumns.includes(name)) errors.set(index, `"${name}" is reserved.`);
    else if (seen.has(name)) errors.set(index, "Another column has this name.");
    else if (!column.description.trim()) errors.set(index, "Describe the column for the agents.");
    else if (column.unique && column.type !== "text" && column.type !== "number") {
      errors.set(index, "Only a text or number column can be unique.");
    } else if ((column.values?.length ?? 0) > maxValues)
      errors.set(index, `At most ${maxValues} values.`);
    seen.add(name);
  });
  const unique = columns.flatMap((column, index) => (column.unique ? [index] : []));
  for (const index of unique.slice(1)) errors.set(index, "Only one column can be unique.");
  if (columns.length > maxColumns) errors.set(maxColumns, `At most ${maxColumns} columns.`);
  return errors;
}

/** What a columns edit changes, in words, to confirm before it reshapes existing records. */
export function describeChanges(
  before: readonly Column[],
  after: readonly ColumnInput[],
): string[] {
  const changes: string[] = [];
  const kept = new Set<string>();
  for (const column of after) {
    const origin = column.rename_from ?? column.name;
    const previous = before.find((item) => item.name === origin);
    if (!previous) {
      changes.push(`Add ${column.name} (${column.type})`);
      continue;
    }
    kept.add(previous.name);
    if (previous.name !== column.name) changes.push(`Rename ${previous.name} to ${column.name}`);
    if (previous.description !== column.description)
      changes.push(`Change the description of ${column.name}`);
    if (previous.type !== column.type)
      changes.push(`Change ${column.name} from ${previous.type} to ${column.type}`);
    if ((previous.values ?? []).join("\u0000") !== (column.values ?? []).join("\u0000")) {
      changes.push(`Change the allowed values of ${column.name}`);
    }
    if (previous.required !== column.required) {
      changes.push(`${column.required ? "Require" : "Stop requiring"} ${column.name}`);
    }
    if (previous.unique !== column.unique)
      changes.push(`${column.unique ? "Make" : "Stop making"} ${column.name} unique`);
  }
  for (const column of before)
    if (!kept.has(column.name)) changes.push(`Remove ${column.name} and its values`);
  return changes;
}
