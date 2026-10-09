import { ArtifactError } from "./errors.js";

/**
 * The column dialect of a collection. A collection is a typed table: the
 * operator declares its columns, every record write is validated against
 * them, and State prints them to the agents that can read the collection.
 */
export const COLUMN_TYPES = ["text", "number", "boolean", "datetime", "array"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export type CollectionColumn = {
  name: string;
  type: ColumnType;
  description: string;
  required: boolean;
  unique: boolean;
  /** `text` or `array` only: the closed list of accepted values. */
  values?: string[];
};

export const COLUMN_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const RESERVED_COLUMN_NAMES = ["id", "created_at", "updated_at", "created_by", "updated_by"] as const;
export const COLUMNS_MAX = 64;
export const COLUMN_DESCRIPTION_MAX = 200;
export const COLUMN_VALUES_MAX = 50;
export const COLUMN_VALUE_MAX = 64;
export const ARRAY_ITEMS_MAX = 50;
export const ARRAY_ITEM_MAX = 200;

const COLUMN_FIELDS = new Set(["name", "type", "description", "required", "unique", "values"]);
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isColumnType(value: unknown): value is ColumnType {
  return typeof value === "string" && (COLUMN_TYPES as readonly string[]).includes(value);
}

/**
 * Validates a column list as the operator or a recipe declares it and returns
 * it normalised. Throws a 422 naming the first rule broken.
 */
export function parseColumns(raw: unknown): CollectionColumn[] {
  if (!Array.isArray(raw)) {
    throw new ArtifactError("columns must be an array", 422);
  }
  if (raw.length > COLUMNS_MAX) {
    throw new ArtifactError(`at most ${COLUMNS_MAX} columns`, 422);
  }
  const seen = new Set<string>();
  const uniques: string[] = [];
  const columns = raw.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new ArtifactError(`column ${index + 1}: must be an object`, 422);
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const label = name || `column ${index + 1}`;
    if (!COLUMN_NAME_RE.test(name)) {
      throw new ArtifactError(`${describe(label)}: name must match ${COLUMN_NAME_RE.source}`, 422);
    }
    if ((RESERVED_COLUMN_NAMES as readonly string[]).includes(name)) {
      throw new ArtifactError(`column "${name}": name is reserved`, 422);
    }
    if (seen.has(name)) {
      throw new ArtifactError(`column "${name}": duplicate name`, 422);
    }
    seen.add(name);
    for (const field of Object.keys(item)) {
      if (!COLUMN_FIELDS.has(field)) {
        throw new ArtifactError(`column "${name}": unknown field "${field}"`, 422);
      }
    }
    if (!isColumnType(item.type)) {
      throw new ArtifactError(`column "${name}": type must be one of ${COLUMN_TYPES.join(", ")}`, 422);
    }
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!description) {
      throw new ArtifactError(`column "${name}": description is required`, 422);
    }
    if (description.length > COLUMN_DESCRIPTION_MAX) {
      throw new ArtifactError(
        `column "${name}": description must be at most ${COLUMN_DESCRIPTION_MAX} characters`,
        422,
      );
    }
    if (item.required !== undefined && typeof item.required !== "boolean") {
      throw new ArtifactError(`column "${name}": required must be true or false`, 422);
    }
    if (item.unique !== undefined && typeof item.unique !== "boolean") {
      throw new ArtifactError(`column "${name}": unique must be true or false`, 422);
    }
    const unique = item.unique === true;
    if (unique && item.type !== "text" && item.type !== "number") {
      throw new ArtifactError(`column "${name}": unique needs a text or number column`, 422);
    }
    if (unique) {
      uniques.push(name);
    }
    const column: CollectionColumn = {
      name,
      type: item.type,
      description,
      required: item.required === true,
      unique,
    };
    if (item.values !== undefined && item.values !== null) {
      if (item.type !== "text" && item.type !== "array") {
        throw new ArtifactError(`column "${name}": values needs a text or array column`, 422);
      }
      const values = parseValues(item.values);
      if (!values) {
        throw new ArtifactError(
          `column "${name}": values must be a list of 1 to ${COLUMN_VALUES_MAX} distinct non-empty ` +
            `strings of at most ${COLUMN_VALUE_MAX} characters`,
          422,
        );
      }
      column.values = values;
    }
    return column;
  });
  if (uniques.length > 1) {
    throw new ArtifactError(`only one column can be unique (${uniques.join(", ")})`, 422);
  }
  return columns;
}

function describe(label: string): string {
  return label.startsWith("column ") ? label : `column "${label}"`;
}

function parseValues(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > COLUMN_VALUES_MAX) {
    return null;
  }
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      return null;
    }
    const text = item.trim();
    if (!text || text.length > COLUMN_VALUE_MAX || values.includes(text)) {
      return null;
    }
    values.push(text);
  }
  return values;
}

/** The declared columns as stored on the row, tolerant of a malformed value. */
export function columnsOf(value: unknown): CollectionColumn[] {
  try {
    return parseColumns(value ?? []);
  } catch {
    return [];
  }
}

export function columnNamed(columns: CollectionColumn[], name: string): CollectionColumn | null {
  return columns.find((column) => column.name === name) ?? null;
}

export function uniqueColumn(columns: CollectionColumn[]): CollectionColumn | null {
  return columns.find((column) => column.unique) ?? null;
}

function got(value: unknown): string {
  if (value === null) return "got null";
  if (Array.isArray(value)) return "got a list";
  if (typeof value === "object") return "got an object";
  if (typeof value === "string") {
    const text = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `got ${JSON.stringify(text)}`;
  }
  return `got ${String(value)}`;
}

/**
 * Checks one value against its column. Returns the value to store (datetime
 * values are normalised to UTC) or the problem, phrased for the model.
 */
export function checkValue(
  column: CollectionColumn,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; problem: string } {
  const fail = (expected: string): { ok: false; problem: string } => ({
    ok: false,
    problem: `column "${column.name}": expected ${expected}; ${got(value)}`,
  });
  switch (column.type) {
    case "text": {
      if (typeof value !== "string") {
        return fail(column.values ? `one of ${column.values.join(", ")}` : "text");
      }
      if (column.values && !column.values.includes(value)) {
        return fail(`one of ${column.values.join(", ")}`);
      }
      return { ok: true, value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail("number");
      }
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return fail("true or false");
      }
      return { ok: true, value };
    }
    case "datetime": {
      const normalised = typeof value === "string" ? normalizeDatetime(value) : null;
      if (!normalised) {
        return fail("an ISO 8601 datetime with a timezone");
      }
      return { ok: true, value: normalised };
    }
    case "array":
      return checkArrayValue(column, value, fail);
  }
}

function checkArrayValue(
  column: CollectionColumn,
  value: unknown,
  fail: (expected: string) => { ok: false; problem: string },
): { ok: true; value: unknown } | { ok: false; problem: string } {
  const expected = column.values ? `a list of ${column.values.join(", ")}` : "a list of text";
  if (!Array.isArray(value)) {
    return fail(expected);
  }
  if (value.length > ARRAY_ITEMS_MAX) {
    return fail(`a list of at most ${ARRAY_ITEMS_MAX} text items`);
  }
  const stored: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    const label = `item ${index + 1}`;
    if (typeof item !== "string" || !item) {
      return { ok: false, problem: `column "${column.name}": ${label}: expected text; ${got(item)}` };
    }
    if (item.length > ARRAY_ITEM_MAX) {
      return {
        ok: false,
        problem: `column "${column.name}": ${label}: expected text of at most ${ARRAY_ITEM_MAX} characters; ${got(item)}`,
      };
    }
    if (column.values && !column.values.includes(item)) {
      return { ok: false, problem: `column "${column.name}": ${label}: expected one of ${column.values.join(", ")}; ${got(item)}` };
    }
    if (stored.includes(item)) {
      return { ok: false, problem: `column "${column.name}": ${label}: duplicate ${JSON.stringify(item)}` };
    }
    stored.push(item);
  }
  return { ok: true, value: stored };
}

/** An ISO 8601 datetime with a timezone, normalised to UTC; null otherwise. */
export function normalizeDatetime(value: string): string | null {
  const text = value.trim();
  if (!DATETIME_RE.test(text)) {
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function unknownColumn(columns: CollectionColumn[], name: string): string {
  const declared = columns.map((column) => column.name).join(", ");
  return `column "${name}": unknown column; declared columns are ${declared || "(none)"}`;
}

/**
 * Validates the whole body of a new record. Unknown columns, missing required
 * columns, and values of the wrong shape are all reported at once.
 */
export function validateAdd(
  columns: CollectionColumn[],
  body: Record<string, unknown>,
): { body: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const stored: Record<string, unknown> = {};
  for (const name of Object.keys(body)) {
    if (!columnNamed(columns, name)) {
      problems.push(unknownColumn(columns, name));
    }
  }
  for (const column of columns) {
    const value = body[column.name];
    if (value === undefined || value === null) {
      if (column.required) {
        problems.push(`column "${column.name}": required`);
      }
      continue;
    }
    const checked = checkValue(column, value);
    if (checked.ok) {
      stored[column.name] = checked.value;
    } else {
      problems.push(checked.problem);
    }
  }
  return { body: stored, problems };
}

/**
 * Validates the columns present in a patch. `null` clears an optional column
 * and is a problem on a required one.
 */
export function validatePatch(
  columns: CollectionColumn[],
  patch: Record<string, unknown>,
): { set: Record<string, unknown>; clear: string[]; problems: string[] } {
  const problems: string[] = [];
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [name, value] of Object.entries(patch)) {
    const column = columnNamed(columns, name);
    if (!column) {
      problems.push(unknownColumn(columns, name));
      continue;
    }
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      if (column.required) {
        problems.push(`column "${column.name}": required; cannot be cleared`);
      } else {
        clear.push(column.name);
      }
      continue;
    }
    const checked = checkValue(column, value);
    if (checked.ok) {
      set[column.name] = checked.value;
    } else {
      problems.push(checked.problem);
    }
  }
  return { set, clear, problems };
}

/** Problems a stored record has against the current columns. */
export function recordProblems(columns: CollectionColumn[], body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(body)) {
    if (!columnNamed(columns, name)) {
      problems.push(unknownColumn(columns, name));
    }
  }
  for (const column of columns) {
    const value = body[column.name];
    if (value === undefined || value === null) {
      if (column.required) {
        problems.push(`column "${column.name}": required`);
      }
      continue;
    }
    const checked = checkValue(column, value);
    if (!checked.ok) {
      problems.push(checked.problem);
    }
  }
  return problems;
}

export function recordRejected(problems: string[]): ArtifactError {
  return new ArtifactError(["record rejected", ...problems.map((problem) => `- ${problem}`)].join("\n"), 422);
}

/** The normalised unique value the store compares records by. */
export function normalizeIdentity(column: CollectionColumn, value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const text = value.normalize("NFC").trim().toLowerCase();
  return text || null;
}

export function identityFor(columns: CollectionColumn[], body: Record<string, unknown>): string | null {
  const column = uniqueColumn(columns);
  return column ? normalizeIdentity(column, body[column.name]) : null;
}

/** One line per column for hints: `status (text: new | done, required)`. */
export function describeColumn(column: CollectionColumn): string {
  const type = column.values ? `${column.type}: ${column.values.join(" | ")}` : column.type;
  const flags = [column.required ? "required" : "", column.unique ? "unique" : ""].filter(Boolean);
  return `${column.name} (${[type, ...flags].join(", ")})`;
}

/** The compact column list State prints for a collection. */
export function columnCatalog(columns: CollectionColumn[]): Array<Record<string, unknown>> {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    ...(column.values ? { values: column.values } : {}),
    ...(column.required ? { required: true } : {}),
    ...(column.unique ? { unique: true } : {}),
    description: column.description,
  }));
}

/**
 * What changes when the columns of a live collection are replaced: renamed
 * columns move their key in every record, removed columns drop it. A rename
 * is a column whose `rename_from` names a previous column; the field is
 * consumed here and never stored.
 */
export function parseColumnChange(
  previous: CollectionColumn[],
  raw: unknown,
): { columns: CollectionColumn[]; renamed: Array<{ from: string; to: string }>; removed: string[] } {
  if (!Array.isArray(raw)) {
    throw new ArtifactError("columns must be an array", 422);
  }
  const renamed: Array<{ from: string; to: string }> = [];
  const stripped = raw.map((item) => {
    if (!isPlainObject(item) || !("rename_from" in item)) {
      return item;
    }
    const { rename_from: from, ...rest } = item;
    const to = typeof rest.name === "string" ? rest.name.trim() : "";
    if (typeof from !== "string" || !previous.some((column) => column.name === from)) {
      throw new ArtifactError(`column "${to}": rename_from must name a current column`, 422);
    }
    if (from !== to) {
      renamed.push({ from, to });
    }
    return rest;
  });
  const columns = parseColumns(stripped);
  const kept = new Set([...columns.map((column) => column.name), ...renamed.map((item) => item.from)]);
  const removed = previous.map((column) => column.name).filter((name) => !kept.has(name));
  return { columns, renamed, removed };
}
