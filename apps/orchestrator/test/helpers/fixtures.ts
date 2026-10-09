import { readFileSync } from "node:fs";
import path from "node:path";
import { defaultTemplatesRoot } from "../../src/config/index.js";
import { repoRoot } from "../../src/lib/paths.js";

export function fixturePath(relative: string): string {
  return path.join(repoRoot(import.meta.url), "fixtures/compat", relative);
}

export function loadJsonFixture<T>(relative: string): T {
  return JSON.parse(readFileSync(fixturePath(relative), "utf8")) as T;
}

export function loadTextFixture(relative: string): string {
  return readFileSync(fixturePath(relative), "utf8");
}

export function templatesRoot(): string {
  return defaultTemplatesRoot();
}
