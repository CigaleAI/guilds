import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { jsonObj } from "../db/json.js";
import { formatUtcNow } from "../lib/clock.js";

export {
  isRelativeMemoryArchivePath,
  LEGACY_MEMORY_DIR,
  MEMORY_DIR,
  omitMemoryArchive,
} from "./archive.js";

export const MEMORY_FILE = "memory.md";
export const MEMORY_LIMIT = 12_000;
export const MEMORY_ARCHIVE_KEEP = 50;

export const EMPTY_MEMORY = "";

export const MEMORY_REMINDER =
  "Memory: this wake has not called memory_write. Call it now.";

export const MEMORY_INTRO = `
### Your Memory
Memory is a private place you write whatever you want your future runs to
remember. Rewrite it with memory_write. The Task above is the operator's
standing purpose and stays as written.

There is no required format. Write what will help you next time. Before you
finish, rewrite Memory when this run changed something you want to keep; a
schedule wake-up always writes.
`.trim();

export const MEMORY_INTRO_READONLY = `
### Your Memory
Memory is a private place for whatever your future runs should remember.
The Task above is the operator's standing purpose and stays as written.

There is no required format.
`.trim();

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function readMemory(agentDir: string): string {
  const filePath = path.join(agentDir, MEMORY_FILE);
  if (!existsSync(filePath)) {
    return EMPTY_MEMORY;
  }
  return readFileSync(filePath, "utf8");
}

function trimmedMemoryBody(text: string): string {
  return text.replaceAll("\r\n", "\n").replace(/\s+$/, "");
}

export function renderMemorySection(text: string, writable = true): string {
  const body = trimmedMemoryBody(text);
  const parts = [writable ? MEMORY_INTRO : MEMORY_INTRO_READONLY];
  if (body) {
    parts.push("", body);
  }
  const inner = parts.join("\n").replace(/\s+$/, "");
  return `<memory>\n${inner}\n</memory>\n`;
}

export function validateMemory(content: string): void {
  if (content.length > MEMORY_LIMIT) {
    throw new MemoryError(`memory exceeds ${MEMORY_LIMIT} characters`);
  }
}

export function memoryUtcIso(now: Date): string {
  return formatUtcNow(now);
}

export function memoryUtcStamp(now: Date): string {
  return memoryUtcIso(now).replaceAll(":", "-");
}

const INVALID_ARCHIVE_SOURCE_TOKENS = new Set(["", ".", ".."]);

export function archiveSourceToken(source: string): string {
  const token = (source || "").trim().replaceAll("/", "-").replaceAll(":", "-");
  if (INVALID_ARCHIVE_SOURCE_TOKENS.has(token)) {
    throw new MemoryError("invalid memory source");
  }
  return token;
}

export function archiveFilename(now: Date, source: string): string {
  return `${memoryUtcStamp(now)}-${archiveSourceToken(source)}.md`;
}

export function archiveHeader(args: {
  started: Date;
  ended: Date;
  replacedBy: string;
}): string {
  return (
    `Current: ${memoryUtcIso(args.started)} → ${memoryUtcIso(args.ended)}\n` +
    `Replaced by: ${args.replacedBy}\n`
  );
}

export function memoryReminderMessage(generation: number): [
  { role: string; content: string },
  Record<string, unknown>,
] {
  return [{ role: "system", content: MEMORY_REMINDER }, { source: "memory", generation }];
}

function rowToolName(row: Record<string, unknown>): string | null {
  const record = plainObject(jsonObj(row.metadata));
  return typeof record?.tool_name === "string" ? record.tool_name : null;
}

export function hasMemoryWrite(rows: Array<Record<string, unknown>>): boolean {
  return rows.some((row) => rowToolName(row) === "memory_write");
}

function snapshotToolName(tool: unknown): string {
  const record = plainObject(tool);
  if (!record) {
    return "";
  }
  const fn = plainObject(record.function) ?? {};
  return typeof fn.name === "string" ? fn.name : "";
}

export function offersMemoryWrite(snapshot: Record<string, unknown>): boolean {
  const tools = snapshot.tools;
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => snapshotToolName(tool) === "memory_write");
}

export { MEMORY_DIR as historyArchiveDir, LEGACY_MEMORY_DIR as legacyMemoryDir } from "./archive.js";
