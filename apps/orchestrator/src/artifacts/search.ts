import type { CollectionColumn } from "../db/schema/index.js";
import { checkBoolean, checkDatetime, checkNumber, checkText, columnNamed, type Checked } from "./columns.js";
import type { OrderClause, WhereClause } from "../db/collections.js";
import { ArtifactError } from "./errors.js";

/** Byte cap for the flattened value text that `record_search` indexes. */
export const SEARCH_BLOB_MAX_BYTES = 32 * 1024;
export const WHERE_COLUMNS_MAX = 8;
export const WHERE_TERM_MAX = 200;
export const SYSTEM_ORDER_COLUMNS = ["id", "created_at", "updated_at"] as const;

/**
 * The text `record_search` matches for one record: the id followed by every
 * scalar value in the body, depth first. Keys are left out so that a column
 * name shared by every record never matches.
 */
export function searchBlobFor(id: string, body: unknown): string {
  const parts: string[] = [id];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
      return;
    }
    const text = String(value).trim();
    if (text) parts.push(text);
  };
  visit(body);
  return truncateUtf8(parts.join(" "), SEARCH_BLOB_MAX_BYTES);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A positive integer record id from a number or a numeric string. */
export function parseRecordId(value: unknown, label = "id"): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
    throw new ArtifactError(`${label} must be a positive integer`, 422);
  }
  return Number(text);
}

/**
 * Validates the `where` argument: one term per declared column, matched by
 * the column's type. A text term matches by substring and, when the column
 * has no closed list and the term has no digit, by similar spelling; an
 * open array matches an item the same way; a term outside a closed list
 * is an error naming the list; number and datetime columns match exactly
 * or by a `gte` / `lte` range; boolean and `id` exactly; `null` matches a
 * missing or null value.
 */
export function parseWhere(value: unknown, columns: CollectionColumn[]): WhereClause[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!isPlainObject(value)) {
    throw new ArtifactError("where must be an object of column: term", 422);
  }
  const entries = Object.entries(value);
  if (entries.length > WHERE_COLUMNS_MAX) {
    throw new ArtifactError(`where takes at most ${WHERE_COLUMNS_MAX} columns`, 422);
  }
  return entries.map(([name, raw]) => parseClause(name, raw, columns));
}

function parseClause(name: string, raw: unknown, columns: CollectionColumn[]): WhereClause {
  const label = `where.${name}`;
  if (name === "id") {
    return { column: "id", op: "id", id: parseRecordId(raw, label) };
  }
  const column = columnNamed(columns, name);
  if (!column) {
    const declared = columns.map((item) => item.name).join(", ");
    throw new ArtifactError(`${label}: unknown column; declared columns are ${declared || "(none)"}`, 422);
  }
  if (raw === null) {
    return { column: name, type: column.type, op: "null" };
  }
  if (isPlainObject(raw)) {
    return parseRange(label, column, raw);
  }
  if (typeof raw === "string" && raw.trim().length > WHERE_TERM_MAX) {
    throw new ArtifactError(`${label}: term must be at most ${WHERE_TERM_MAX} characters`, 422);
  }
  return parseTerm(label, column, raw);
}

/**
 * The clause one term makes on its column: by substring or similar spelling on text without a
 * closed list and on an open array, by item on a closed array, exactly otherwise.
 */
function parseTerm(label: string, column: CollectionColumn, raw: unknown): WhereClause {
  const term = typeof raw === "string" ? raw.trim() : raw;
  switch (column.type) {
    case "array":
      return parseArrayTerm(label, column, raw);
    case "text":
      return column.values
        ? { column: column.name, type: "text", op: "eq", term: checkedTerm(label, column, checkText(column, term)) }
        : { column: column.name, type: "text", op: "like", term: textTerm(label, raw) };
    case "number":
      return { column: column.name, type: "number", op: "eq", term: checkedTerm(label, column, checkNumber(column, term)) };
    case "datetime":
      return { column: column.name, type: "datetime", op: "eq", term: checkedTerm(label, column, checkDatetime(column, term)) };
    case "boolean":
      return { column: column.name, type: "boolean", op: "eq", term: checkedTerm(label, column, checkBoolean(column, term)) };
  }
}

/** The clause a term makes on an array column: an item of its closed list, or a substring of an item when it has none. */
function parseArrayTerm(label: string, column: CollectionColumn, raw: unknown): WhereClause {
  const term = textTerm(label, raw);
  if (column.values && !column.values.includes(term)) {
    throw new ArtifactError(`${label}: expected one of ${column.values.join(", ")}; ${gotText(raw)}`, 422);
  }
  return { column: column.name, type: "array", op: column.values ? "contains" : "like", term };
}

/** A term that must be text, trimmed; a 422 when it is not text or is empty. */
function textTerm(label: string, raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ArtifactError(`${label}: expected text; ${gotText(raw)}`, 422);
  }
  return raw.trim();
}

/** The value a term checked against its column holds; a 422 naming the term at `label` when it does not fit. */
function checkedTerm<T>(label: string, column: CollectionColumn, checked: Checked<T>): T {
  if (!checked.ok) {
    throw new ArtifactError(checked.problem.replace(`column "${column.name}"`, label), 422);
  }
  return checked.value;
}

function parseRange(label: string, column: CollectionColumn, raw: Record<string, unknown>): WhereClause {
  if (column.type !== "number" && column.type !== "datetime") {
    throw new ArtifactError(`${label}: a range needs a number or datetime column`, 422);
  }
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.some((key) => key !== "gte" && key !== "lte")) {
    throw new ArtifactError(`${label}: a range is { "gte": value } and/or { "lte": value }`, 422);
  }
  if (column.type === "number") {
    return {
      column: column.name,
      type: "number",
      op: "range",
      gte: "gte" in raw ? checkedTerm(`${label}.gte`, column, checkNumber(column, raw.gte)) : null,
      lte: "lte" in raw ? checkedTerm(`${label}.lte`, column, checkNumber(column, raw.lte)) : null,
    };
  }
  return {
    column: column.name,
    type: "datetime",
    op: "range",
    gte: "gte" in raw ? checkedTerm(`${label}.gte`, column, checkDatetime(column, raw.gte)) : null,
    lte: "lte" in raw ? checkedTerm(`${label}.lte`, column, checkDatetime(column, raw.lte)) : null,
  };
}

function gotText(value: unknown): string {
  if (value === undefined) return "got nothing";
  if (Array.isArray(value)) return "got a list";
  if (typeof value === "object" && value !== null) return "got an object";
  return `got ${JSON.stringify(value)}`;
}

/**
 * The `order` argument: `{ column, direction }` over a declared column that
 * is not an array, `id`, `created_at`, or `updated_at`; a string `"column"`
 * or `"column desc"` is accepted too.
 */
export function parseOrder(value: unknown, columns: CollectionColumn[]): OrderClause | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const { column, direction } = readOrderRequest(value);
  if (direction !== "asc" && direction !== "desc") {
    throw new ArtifactError("order.direction must be asc or desc", 422);
  }
  const declared = columnNamed(columns, column);
  const known = SYSTEM_ORDER_COLUMNS.some((system) => system === column) || declared;
  if (!column || !known) {
    const names = [...SYSTEM_ORDER_COLUMNS, ...columns.map((item) => item.name)].join(", ");
    throw new ArtifactError(`order.column must be one of ${names}`, 422);
  }
  if (declared?.type === "array") {
    throw new ArtifactError("order.column cannot be an array column", 422);
  }
  return { column, direction };
}

/** The column and direction an `order` argument names, before either is checked. */
type OrderRequest = { column: string; direction: string };

/** What an `order` argument asks for, from `"column"`, `"column desc"`, or `{ column, direction }`; ascending unless it says otherwise. */
function readOrderRequest(value: unknown): OrderRequest {
  if (typeof value === "string") {
    const parts = value.trim().split(/\s+/);
    return { column: parts[0] ?? "", direction: (parts[1] ?? "asc").toLowerCase() };
  }
  if (isPlainObject(value)) {
    return {
      column: typeof value.column === "string" ? value.column.trim() : "",
      direction: typeof value.direction === "string" ? value.direction.trim().toLowerCase() : "asc",
    };
  }
  throw new ArtifactError("order must be { column, direction }", 422);
}

/** The `since` argument: an ISO 8601 timestamp, returned normalised to UTC. */
export function parseSince(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = typeof value === "string" ? new Date(value.trim()) : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    throw new ArtifactError("since must be an ISO 8601 timestamp", 422);
  }
  return date.toISOString();
}

export function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) {
    throw new ArtifactError("limit must be a positive integer", 422);
  }
  return Math.min(Math.max(Number(text), 1), max);
}

export function parseOffset(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) {
    throw new ArtifactError("offset must be a non-negative integer", 422);
  }
  return Number(text);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
}
