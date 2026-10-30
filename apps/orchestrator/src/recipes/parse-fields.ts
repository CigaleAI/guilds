import { isPlainRecord } from "../db/json.js";
import { RecipeError } from "./errors.js";
import type { FieldAuthor } from "../db/schema/index.js";

// The field readers a recipe is parsed with. Each names the field it reads by its path in the
// document, so an error tells the author where to look; an unknown key also says which key the
// author most likely meant.

export function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new RecipeError(`${path} must be an object`);
  }
  return value;
}

/** A key an author writes by mistake, where it is written, and what to write instead. */
type KeyHint = { keys: readonly string[]; at?: RegExp; hint: string };

const KEY_HINTS: readonly KeyHint[] = [
  { keys: ["name"], at: /^roles\[/, hint: "use `role` for the handle and `name_suggestion` for the create-time slug" },
  { keys: ["name"], at: /^notes\[/, hint: "notes use `id`, `level`, `key`, and `body`" },
  { keys: ["path"], at: /^notes\[/, hint: "notes have no folders; `key` is the whole `.md` file name, with no `/`" },
  { keys: ["text"], hint: "use `body`" },
  { keys: ["routines"], hint: "use `schedules` with { key, cron or window, description, instruction }" },
  {
    keys: ["memory", "memory_seed"],
    hint: "not a recipe field; Memory instructions go in task.body and seed files go in notes",
  },
  { keys: ["model"], hint: "put model on `config.model`" },
  { keys: ["capabilities"], hint: "use `native_tools` and `connections`" },
  { keys: ["title"], at: /^notes\[/, hint: "notes use `id`, `level`, `key`, and `body`" },
  { keys: ["key"], at: /^collections\[/, hint: "collections use `name`, not `key`" },
  {
    keys: ["level", "role"],
    at: /^collections\[/,
    hint: "a collection is a table of the applied guild (`scope: \"guild\"`) or of the organisation, where `guild` is the guild's access mode and `writers` lists the roles that write",
  },
  {
    keys: ["schema"],
    at: /^collections\[/,
    hint: "use `columns`: [{ name, type, description, required?, unique?, values? }]",
  },
  { keys: ["enabled_tools"], hint: "use `tools` as { tool_name: boolean }" },
  { keys: ["tools"], at: /^connections\[\d+\]$/, hint: "put tool overlays at connections[].roles[role].tools" },
  {
    keys: ["author"],
    at: /^roles\[\d+\]$/,
    hint: "author lives on task, browser, schedules, and scripts — not on the role object",
  },
];

function keyHint(path: string, key: string): string | null {
  const found = KEY_HINTS.find((item) => item.keys.includes(key) && (!item.at || item.at.test(path)));
  return found?.hint ?? null;
}

export function assertKeys(record: Record<string, unknown>, allowed: string[], path: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allow.has(key));
  if (unknown === undefined) {
    return;
  }
  const hint = keyHint(path, unknown);
  const allowedList = allowed.join(", ");
  throw new RecipeError(
    hint
      ? `unknown key ${path}.${unknown}; ${hint}. allowed: ${allowedList}`
      : `unknown key ${path}.${unknown}; allowed: ${allowedList}`,
  );
}

export function asString(value: unknown, path: string, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new RecipeError(`${path} must be a string`);
  }
  return value;
}

/** Whether `value` is one of `allowed`. */
export function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return allowed.some((item) => item === value);
}

export function asOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const text = asString(value, path);
  if (!isOneOf(allowed, text)) {
    throw new RecipeError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return text;
}

export function asBool(value: unknown, path: string, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new RecipeError(`${path} must be a boolean`);
  }
  return value;
}

export function asInt(value: unknown, path: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RecipeError(`${path} must be an integer`);
  }
  return value;
}

export function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** A text field of at most `max` bytes. */
export function boundedText(value: unknown, path: string, max: number): string {
  const text = asString(value, path);
  if (byteLen(text) > max) {
    throw new RecipeError(`${path} exceeds ${max} bytes`);
  }
  return text;
}

export function parseBoolMap(value: unknown, path: string): Record<string, boolean> {
  if (value === undefined) {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(assertObject(value, path))) {
    if (typeof item !== "boolean") {
      throw new RecipeError(`${path}.${key} must be a boolean`);
    }
    out[key] = item;
  }
  return out;
}

/** A list of texts; absent is empty. */
export function textList(value: unknown, path: string): string[] {
  return Array.isArray(value) ? value.map((item, index) => asString(item, `${path}[${index}]`)) : [];
}

/** The role names of a `writers` list, trimmed and without repeats. */
export function parseWriters(value: unknown, path: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RecipeError(`${path} must be an array of role names`);
  }
  const roles = value.map((writer, index) => asString(writer, `${path}[${index}]`).trim());
  return [...new Set(roles.filter(Boolean))];
}

/** A list field: its items, or none when it is absent. */
export function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Who wrote a field and whether the operator reviewed it; `fallback` when the field names no author. */
export function parseAuthor(value: unknown, fallback: FieldAuthor): FieldAuthor {
  if (value === undefined || value === null) {
    return fallback;
  }
  const record = assertObject(value, "author");
  const by = record.by;
  if (by !== "operator" && by !== "builder") {
    throw new RecipeError("author.by must be operator or builder");
  }
  if (record.reviewed === undefined) {
    return { by, reviewed: false };
  }
  if (typeof record.reviewed !== "boolean") {
    throw new RecipeError("author.reviewed must be a boolean");
  }
  return { by, reviewed: record.reviewed };
}
