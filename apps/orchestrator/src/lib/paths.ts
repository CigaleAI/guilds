import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function hereDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}

export function findUp(fromDir: string, marker: string): string {
  let dir = fromDir;
  while (true) {
    if (existsSync(path.join(dir, marker))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot find ${marker} from ${fromDir}`);
    }
    dir = parent;
  }
}

export function orchestratorRoot(metaUrl: string): string {
  return findUp(hereDir(metaUrl), "drizzle.config.ts");
}

export function repoRoot(metaUrl: string): string {
  return findUp(hereDir(metaUrl), "pnpm-workspace.yaml");
}
