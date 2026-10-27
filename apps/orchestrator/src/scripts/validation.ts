import { createHash } from "node:crypto";
import { isPlainRecord } from "../db/json.js";

export const SCRIPTS_DIR = "scripts";
export const SCRIPT_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
export const SCRIPT_DESCRIPTION_MAX = 400;
export const RESERVED_SCRIPT_NAMES = new Set(["manifest"]);
export const NATIVE_TOOL_NAMES = new Set([
  "note_find",
  "note_get",
  "note_write",
  "note_delete",
  "record_search",
  "record_list",
  "record_add",
  "record_update",
  "record_remove",
  "file_find",
  "file_fetch",
  "file_put",
  "file_delete",
  "memory_write",
  "group_post",
  "report_issue",
  "script_create",
  "script_list",
  "script_read",
  "script_run",
  "script_delete",
  "schedule_create_cron",
  "schedule_create_window",
  "schedule_list",
  "schedule_update",
  "schedule_pause",
  "schedule_resume",
  "schedule_delete",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_scroll",
  "browser_screenshot",
  "browser_eval",
  "shell",
  "shell_status",
  "file_read",
  "code_search",
  "code_task",
  "secret_store",
  "secret_request",
]);

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

export function validateScriptName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ScriptError("name must be a string");
  }
  const name = value.trim();
  if (!name) {
    throw new ScriptError("name is required");
  }
  if (RESERVED_SCRIPT_NAMES.has(name)) {
    throw new ScriptError("name is reserved");
  }
  if (!SCRIPT_NAME.test(name)) {
    throw new ScriptError("name must match ^[a-z][a-z0-9_-]{0,62}$");
  }
  return name;
}

export function validateScriptDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new ScriptError("description must be a string");
  }
  const text = value.trim();
  if (!text) {
    throw new ScriptError("description must contain non-whitespace text");
  }
  if (text.length > SCRIPT_DESCRIPTION_MAX) {
    throw new ScriptError(`description must be at most ${SCRIPT_DESCRIPTION_MAX} characters`);
  }
  return text;
}

export function validateScriptSource(value: unknown): string {
  if (typeof value !== "string") {
    throw new ScriptError("source must be a string");
  }
  if (!value.trim()) {
    throw new ScriptError("source must contain non-whitespace text");
  }
  return value;
}

export function scriptSourceHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function validateScriptParameters(
  value: unknown,
): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isPlainRecord(value)) {
    throw new ScriptError("parameters must be a JSON object");
  }
  if (value.type !== "object") {
    throw new ScriptError("parameters must be a JSON Schema object");
  }
  return value;
}

export function assertAvailableScriptName(
  name: string,
  extra: Iterable<string> = [],
): void {
  if (NATIVE_TOOL_NAMES.has(name)) {
    throw new ScriptError("collides with a native or connection tool name");
  }
  for (const item of extra) {
    if (item === name) {
      throw new ScriptError("collides with a native or connection tool name");
    }
  }
}

export function environmentCatalog(
  secrets: Array<Record<string, unknown>> | null | undefined,
): Array<{ name: string; description: string }> {
  const items: Array<{ name: string; description: string }> = [];
  for (const ref of secrets ?? []) {
    if (!ref || typeof ref !== "object") {
      continue;
    }
    const name = ref.name;
    if (typeof name !== "string" || !name) {
      continue;
    }
    const description = ref.description;
    items.push({
      name,
      description: typeof description === "string" ? description : "",
    });
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return items;
}
