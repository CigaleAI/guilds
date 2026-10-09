import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type SweepArgs = {
  ageDays: number;
  apply: boolean;
};

export type SweepEntry = {
  path: string;
  agentId: string;
  ageDays: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseSweepArgs(argv: string[]): SweepArgs {
  let ageDays: number | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--age-days") {
      const raw = argv[index + 1];
      index += 1;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        throw new Error("usage: sweep-workspaces.ts --age-days N [--apply]");
      }
      ageDays = parsed;
      continue;
    }
    throw new Error("usage: sweep-workspaces.ts --age-days N [--apply]");
  }
  if (ageDays === undefined) {
    throw new Error("usage: sweep-workspaces.ts --age-days N [--apply]");
  }
  return { ageDays, apply };
}

export function planWorkspaceSweep(
  workspaceRoot: string,
  liveAgentIds: Set<string>,
  ageDays: number,
  now = new Date(),
): SweepEntry[] {
  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    return [];
  }
  const cutoff = now.getTime() - ageDays * MS_PER_DAY;
  const entries: SweepEntry[] = [];
  for (const name of readdirSync(workspaceRoot)) {
    if (liveAgentIds.has(name)) {
      continue;
    }
    const full = path.join(workspaceRoot, name);
    const stat = statSync(full);
    if (!stat.isDirectory()) {
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      continue;
    }
    entries.push({
      path: full,
      agentId: name,
      ageDays: Math.floor((now.getTime() - stat.mtimeMs) / MS_PER_DAY),
    });
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : 1));
}

export function applyWorkspaceSweep(entries: SweepEntry[]): string[] {
  const removed: string[] = [];
  for (const entry of entries) {
    rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  return removed;
}
