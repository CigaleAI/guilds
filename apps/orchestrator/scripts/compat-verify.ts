import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const compatRoot = join(repoRoot, "fixtures/compat");
const manifestName = "manifest.json";

type Manifest = {
  generator_version: string;
  fixtures: Array<{
    path: string;
    source: string;
    generator_version: string;
    sha256: string;
  }>;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(relative(root, full).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return files;
}

const manifest = JSON.parse(readFileSync(join(compatRoot, manifestName), "utf8")) as Manifest;
const errors: string[] = [];
const seen = new Set<string>();
for (const item of manifest.fixtures) {
  seen.add(item.path);
  const path = join(compatRoot, item.path);
  try {
    const digest = sha256File(path);
    if (digest !== item.sha256) {
      errors.push(`digest mismatch ${item.path}`);
    }
  } catch {
    errors.push(`missing ${item.path}`);
    continue;
  }
  if (item.generator_version !== manifest.generator_version) {
    errors.push(`generator_version mismatch ${item.path}`);
  }
}
for (const relativePath of listFiles(compatRoot)) {
  if (relativePath === manifestName) {
    continue;
  }
  if (!seen.has(relativePath)) {
    errors.push(`unlisted ${relativePath}`);
  }
}
if (errors.length > 0) {
  process.stderr.write(`compat-verify failed:\n${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("compat-verify ok\n");
