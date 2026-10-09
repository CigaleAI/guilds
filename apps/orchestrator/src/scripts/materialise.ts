import { randomBytes } from "node:crypto";
import type { RunScriptSnapshot } from "./snapshot.js";

export const MANAGED_SCRIPTS_DIR = "/home/agent/scripts";
export const SCRIPT_LAUNCHER = "/usr/local/bin/guilds-script-run";
export const SCRIPT_ARGS_ENV = "GUILDS_SCRIPT_ARGS";

export type ScriptFiles = {
  writeFiles(entries: Array<{ path: string; data: string }>): Promise<void>;
  moveFiles(entries: Array<{ src: string; dest: string }>): Promise<void>;
  listDirectory?(entry: { path: string; depth?: number }): Promise<Array<{ path: string; type?: string }>>;
  deleteFiles(paths: string[]): Promise<void>;
};

export function managedScriptPath(name: string): string {
  return `${MANAGED_SCRIPTS_DIR}/${name}.py`;
}

export function launcherCommand(name: string): string {
  return `python3 ${SCRIPT_LAUNCHER} ${managedScriptPath(name)}`;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function managedName(path: string): string | null {
  const name = basename(path);
  if (!name.endsWith(".py") || name.startsWith(".")) {
    return null;
  }
  return name.slice(0, -3);
}

export async function materialiseScripts(
  files: ScriptFiles,
  snapshot: RunScriptSnapshot[],
  liveExtra: Array<{ name: unknown; source: unknown }> = [],
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const row of snapshot) {
    wanted.set(row.name, row.source);
  }
  for (const row of liveExtra) {
    const name = typeof row.name === "string" ? row.name : "";
    const source = typeof row.source === "string" ? row.source : "";
    if (name && !wanted.has(name)) {
      wanted.set(name, source);
    }
  }
  const listed = files.listDirectory
    ? await files.listDirectory({ path: MANAGED_SCRIPTS_DIR, depth: 1 })
    : [];
  const existing = new Set<string>();
  for (const entry of listed) {
    const name = managedName(entry.path);
    if (name) {
      existing.add(name);
    }
  }
  for (const [name, source] of wanted) {
    const dest = managedScriptPath(name);
    const temp = `${MANAGED_SCRIPTS_DIR}/.${name}.${randomBytes(6).toString("hex")}.tmp`;
    await files.writeFiles([{ path: temp, data: source }]);
    if (existing.has(name)) {
      await files.deleteFiles([dest]);
    }
    try {
      await files.moveFiles([{ src: temp, dest }]);
    } catch (error) {
      if (!isDestinationExists(error)) {
        throw error;
      }
      await files.deleteFiles([dest]);
      await files.moveFiles([{ src: temp, dest }]);
    }
  }
  const stale = [...existing].filter((name) => !wanted.has(name)).map((name) => managedScriptPath(name));
  if (stale.length) {
    await files.deleteFiles(stale);
  }
}

export async function writeThroughLiveExtra(
  files: ScriptFiles,
  name: string,
  source: string,
  snapshot: RunScriptSnapshot[],
): Promise<boolean> {
  if (snapshotNamePinned(snapshot, name)) {
    return false;
  }
  await materialiseScripts(files, snapshot, [{ name, source }]);
  return true;
}

/** Removes `/home/agent/scripts/<name>.py` from a running sandbox. Missing is fine. */
export async function removeManagedScript(files: ScriptFiles, name: string): Promise<void> {
  try {
    await files.deleteFiles([managedScriptPath(name)]);
  } catch {
    // The catalog is already the source of truth; the next materialise drops leftovers.
  }
}

function snapshotNamePinned(snapshot: RunScriptSnapshot[], name: string): boolean {
  return snapshot.some((row) => row.name === name);
}

function isDestinationExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("destination path already exists");
}
