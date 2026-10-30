import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isRelativeTo } from "../lib/contain.js";
import { LEGACY_MEMORY_DIR, MEMORY_DIR, MEMORY_FILE } from "../memory/index.js";
import { NotesError } from "./errors.js";

export const FIXED_AGENT_FILES = ["task.md", MEMORY_FILE] as const;
export const ROUTINES_DIR = "routines";
export const HOST_FOLDERS = ["notes", ROUTINES_DIR, MEMORY_DIR, LEGACY_MEMORY_DIR] as const;

export function resolved(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    try {
      return path.join(realpathSync(parent), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** A note's relative path as posix: not empty, inside its root, ending in `.md`. */
export function notePosix(relative: string): string {
  if (relative.startsWith("/") || path.isAbsolute(relative)) {
    throw new NotesError("invalid path");
  }
  const posix = relativePosix(relative.replace(/\/+$/, ""));
  if (!posix.endsWith(".md")) {
    throw new NotesError("path must end in .md");
  }
  return posix;
}

/** A listing prefix as posix: `""` for the root, else a folder or a note inside it. */
export function prefixPosix(prefix: string): string {
  if (prefix.startsWith("/") || path.isAbsolute(prefix)) {
    throw new NotesError("invalid path");
  }
  const trimmed = prefix.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") {
    return "";
  }
  return relativePosix(trimmed);
}

export function isInAgentFolder(agentDir: string, folder: string, filePath: string): boolean {
  const root = resolved(path.join(agentDir, folder));
  const value = resolved(filePath);
  return value === root || isRelativeTo(value, root);
}

export function mapHostRel(posix: string): string {
  for (const name of [ROUTINES_DIR, MEMORY_DIR, LEGACY_MEMORY_DIR]) {
    const old = `notes/${name}`;
    if (posix === old) {
      return name;
    }
    if (posix.startsWith(`${old}/`)) {
      return `${name}${posix.slice(old.length)}`;
    }
  }
  return posix;
}

export function rewriteLegacyPrivate(value: string, agentDir: string): string {
  const notesDir = resolved(path.join(agentDir, "notes"));
  if (!isRelativeTo(value, notesDir)) {
    return value;
  }
  const rel = posixRel(notesDir, value);
  const mapped = mapHostRel(rel);
  if (mapped === rel) {
    return value;
  }
  return resolved(path.join(agentDir, mapped));
}

export function isPrivateAllowed(value: string, agentDir: string, notesRoot: string): boolean {
  if (isRelativeTo(value, notesRoot)) {
    return true;
  }
  for (const name of [ROUTINES_DIR, MEMORY_DIR, LEGACY_MEMORY_DIR]) {
    const special = resolved(path.join(agentDir, name));
    if (value === special || isRelativeTo(value, special)) {
      return true;
    }
  }
  return false;
}

export function isRoutineRel(posix: string): boolean {
  const mapped = mapHostRel(posix);
  return mapped === ROUTINES_DIR || mapped.startsWith(`${ROUTINES_DIR}/`);
}

export function resolveAgentFile(agentDir: string, relative: string): string {
  const posix = mapHostRel(relativePosix(relative));
  const first = posix.split("/", 1)[0];
  if (!(FIXED_AGENT_FILES as readonly string[]).includes(posix) && !(HOST_FOLDERS as readonly string[]).includes(first ?? "")) {
    throw new NotesError("invalid path");
  }
  return contained(agentDir, posix);
}

export function resolveSharedFile(sharedDir: string, relative: string): string {
  const posix = relativePosix(relative);
  if (!posix.endsWith(".md")) {
    throw new NotesError("invalid path");
  }
  return contained(sharedDir, posix);
}

export function relativePosix(relative: string): string {
  if (!relative || relative.startsWith("/") || path.isAbsolute(relative)) {
    throw new NotesError("invalid path");
  }
  const parts = posixParts(relative);
  if (!parts.length || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new NotesError("invalid path");
  }
  return parts.join("/");
}

function contained(root: string, posix: string): string {
  const candidate = resolved(path.join(root, posix));
  if (!isRelativeTo(candidate, resolved(root))) {
    throw new NotesError("invalid path");
  }
  return candidate;
}

export function isDir(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function statIfFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

export function posixParts(relative: string): string[] {
  return relative.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
}

export function posixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

export function rglobAll(root: string): string[] {
  const items: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const child = path.join(dir, name);
      items.push(child);
      if (isDir(child)) {
        walk(child);
      }
    }
  };
  walk(root);
  return items;
}

export function rglobFiles(root: string): string[] {
  return rglobAll(root).filter((item) => statIfFile(item));
}
