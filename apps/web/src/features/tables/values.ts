import type { Column, ColumnInput, ColumnType } from "../../api/types/tables";
import type { RecordCondition, RecordWhere } from "./types";

export const columnTypes = [
  "text",
  "number",
  "boolean",
  "datetime",
  "array",
] as const satisfies readonly ColumnType[];

export function isColumnType(value: unknown): value is ColumnType {
  return columnTypes.some((type) => type === value);
}

/** The views of an open table. */
export const tableTabs = ["records", "columns", "access"] as const;

export function isTableTab(value: unknown): value is (typeof tableTabs)[number] {
  return tableTabs.some((tab) => tab === value);
}

/** Fields every record has, which no column may be named. */
const reservedColumns = ["id", "created_at", "updated_at", "created_by", "updated_by"];
const columnName = /^[a-z][a-z0-9_]{0,63}$/;
const tableName = /^[a-z][a-z0-9_-]{0,62}$/;
const maxColumns = 64;
export const maxValues = 50;
/** A column's description is instructions every agent that reads the table gets in State. */
export const maxColumnDescription = 1000;

/** Whether a column allows a text: any text, unless it lists the values it allows. */
function isAllowedValue(column: Column, text: string): boolean {
  return !column.values?.length || column.values.includes(text);
}

/** Whether a value that is set fits each column type. */
const fitsType: Record<ColumnType, (value: unknown, column: Column) => boolean> = {
  text: (value, column) => typeof value === "string" && isAllowedValue(column, value),
  number: (value) => typeof value === "number",
  boolean: (value) => typeof value === "boolean",
  datetime: (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
  array: (value, column) =>
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && isAllowedValue(column, item)),
};

/** Whether a stored value still fits its column; a changed column can leave old values behind. */
export function fits(value: unknown, column: Column): boolean {
  return value === null || value === undefined || fitsType[column.type](value, column);
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
): RecordWhere {
  const where: RecordWhere = {};
  for (const [name, filter] of Object.entries(filters)) {
    if (name === "id") {
      if (filter.value?.trim()) where.id = Number(filter.value);
      continue;
    }
    const column = columns.find((item) => item.name === name);
    if (!column) continue;
    const condition =
      column.type === "number" || column.type === "datetime"
        ? rangeCondition(filter, column)
        : valueCondition(filter, column);
    if (condition !== undefined) where[name] = condition;
  }
  return where;
}

/** A range end as the server compares it: a number, or a time in ISO form; none when blank. */
function rangeBound(text: string | undefined, column: Column): number | string | undefined {
  if (!text?.trim()) return undefined;
  return column.type === "number" ? Number(text) : new Date(text).toISOString();
}

/** A number or time filter's condition: the one value when both ends meet, else the range set. */
function rangeCondition(filter: ColumnFilter, column: Column): RecordCondition | undefined {
  const from = rangeBound(filter.from, column);
  const to = rangeBound(filter.to, column);
  if (from !== undefined && from === to) return from;
  if (from === undefined && to === undefined) return undefined;
  return {
    ...(from !== undefined ? { gte: from } : {}),
    ...(to !== undefined ? { lte: to } : {}),
  };
}

/** A text, boolean or array filter's condition: null for "(empty)", none when it is unset. */
function valueCondition(filter: ColumnFilter, column: Column): RecordCondition | undefined {
  if (filter.value === undefined || filter.value === "") return undefined;
  if (filter.value === "(empty)") return null;
  return column.type === "boolean" ? filter.value === "true" : filter.value;
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

/** Why a table cannot take a name; undefined when it can. */
export function tableNameError(name: string): string | undefined {
  return tableName.test(name.trim())
    ? undefined
    : "Lowercase letters, digits, _ and -, starting with a letter.";
}

/** Whether a new table has what creating it needs: a name, a purpose and columns that save. */
export function isNewTableReady(
  name: string,
  purpose: string,
  columns: readonly ColumnInput[],
): boolean {
  return (
    tableNameError(name) === undefined &&
    purpose.trim() !== "" &&
    columns.length > 0 &&
    columnErrors(columns).size === 0
  );
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
    changes.push(...keptColumnChanges(previous, column));
  }
  for (const column of before)
    if (!kept.has(column.name)) changes.push(`Remove ${column.name} and its values`);
  return changes;
}

/** What an edit changes in a column it keeps, in words, one line per field it changes. */
function keptColumnChanges(previous: Column, column: ColumnInput): string[] {
  const changes: string[] = [];
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
  return changes;
}
