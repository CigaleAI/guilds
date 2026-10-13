import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type SweepArgs = {
  ageDays: number;
  apply: boolean;
};

/** A folder no live machine or agent owns: a machine's directory, or an agent's home in one. */
export type SweepEntry = {
  path: string;
  machineId: string;
  /** The agent whose home this is; null for a whole machine directory. */
  agentId: string | null;
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
      const parsed = raw ? Number(raw) : Number.NaN;
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

/**
 * The folders under the workspace root, laid out `<machine id>/<agent id>`, that no live machine or
 * agent owns and that nothing changed for `ageDays`: a directory whose machine is gone, and an
 * agent's home in a live machine's directory that the agent no longer sits on. A folder at the
 * root named for a live agent is its home before the boot step moves it into its machine, and
 * stays.
 */
export function planWorkspaceSweep(
  workspaceRoot: string,
  machines: Map<string, Set<string>>,
  ageDays: number,
  now = new Date(),
): SweepEntry[] {
  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    return [];
  }
  const cutoff = now.getTime() - ageDays * MS_PER_DAY;
  const liveAgents = new Set([...machines.values()].flatMap((agents) => [...agents]));
  const entries: SweepEntry[] = [];
  const stale = (full: string): number | null => {
    const stat = statSync(full);
    if (!stat.isDirectory() || stat.mtimeMs > cutoff) {
      return null;
    }
    return Math.floor((now.getTime() - stat.mtimeMs) / MS_PER_DAY);
  };
  for (const machineId of readdirSync(workspaceRoot)) {
    const machineDir = path.join(workspaceRoot, machineId);
    const agents = machines.get(machineId);
    if (agents === undefined) {
      if (liveAgents.has(machineId)) {
        continue;
      }
      const age = stale(machineDir);
      if (age !== null) {
        entries.push({ path: machineDir, machineId, agentId: null, ageDays: age });
      }
      continue;
    }
    if (!statSync(machineDir).isDirectory()) {
      continue;
    }
    for (const agentId of readdirSync(machineDir)) {
      if (agents.has(agentId)) {
        continue;
      }
      const home = path.join(machineDir, agentId);
      const age = stale(home);
      if (age !== null) {
        entries.push({ path: home, machineId, agentId, ageDays: age });
      }
    }
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
