import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { EMPTY_MEMORY } from "../artifacts/memory.js";
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

export const MEMORY_INTRO = `
### Your Memory
Memory is a private place for what your future runs should know and could not
easily find again. Rewrite it with memory_write. The Task above is the
operator's standing purpose and stays as written.

Most runs do not need to write. Before you finish, ask whether the next run
would make a mistake, repeat work, or waste steps without something this run
learned. Write only when it would. What earns a place:
- how to do the job better: an approach that worked or failed, a quirk of a
  tool or source, a preference the operator stated
- where to resume: unfinished work, a commitment you made, a position the
  next run cannot recover from records or history
- where things live: a pointer to the note, record, or collection that holds
  the detail, never the detail itself

Leave out a log of this run, anything the Task, State, notes, records, or
history already hold, anything one tool call finds again, and secrets. A write
replaces the whole file: keep what still holds, drop what is done or stale,
and keep it short. There is no required format.
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

export { MEMORY_DIR as historyArchiveDir, LEGACY_MEMORY_DIR as legacyMemoryDir } from "./archive.js";
