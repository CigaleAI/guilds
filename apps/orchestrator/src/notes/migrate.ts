import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LEGACY_MEMORY_DIR, MEMORY_DIR } from "../memory/index.js";
import { isDir, resolved, ROUTINES_DIR, statIfFile } from "./paths.js";

export function migrateAgentLayout(agentDir: string): void {
  const notesDir = path.join(agentDir, "notes");
  liftDir(path.join(notesDir, ROUTINES_DIR), path.join(agentDir, ROUTINES_DIR));
  liftDir(path.join(notesDir, MEMORY_DIR), path.join(agentDir, MEMORY_DIR));
  liftDir(path.join(notesDir, LEGACY_MEMORY_DIR), path.join(agentDir, MEMORY_DIR));
  liftDir(path.join(agentDir, LEGACY_MEMORY_DIR), path.join(agentDir, MEMORY_DIR));
}

function liftDir(source: string, dest: string): void {
  if (!isDir(source)) {
    return;
  }
  if (resolved(source) === resolved(dest)) {
    return;
  }
  if (!existsSync(dest)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(source, dest);
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(source)) {
    const child = path.join(source, name);
    if (!statIfFile(child)) {
      continue;
    }
    const target = path.join(dest, name);
    if (existsSync(target)) {
      unlinkSync(child);
    } else {
      renameSync(child, target);
    }
  }
  if (isDir(source) && readdirSync(source).length === 0) {
    rmdirSync(source);
  }
}
