// Rewrites the sha256 digests in fixtures/compat/manifest.json for fixtures
// that were changed on purpose. `pnpm compat:verify` remains the gate: this
// script never adds or removes fixture entries, so an unlisted or missing
// file still fails verification.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const compatRoot = join(repoRoot, "fixtures/compat");
const manifestPath = join(compatRoot, "manifest.json");

type Manifest = {
  generator_version: string;
  fixtures: Array<{
    path: string;
    source: string;
    generator_version: string;
    sha256: string;
  }>;
};

const only = new Set(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const updated: string[] = [];
for (const item of manifest.fixtures) {
  if (only.size && !only.has(item.path)) {
    continue;
  }
  const digest = createHash("sha256").update(readFileSync(join(compatRoot, item.path))).digest("hex");
  if (digest !== item.sha256) {
    item.sha256 = digest;
    updated.push(item.path);
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  updated.length ? `compat-digest updated:\n${updated.join("\n")}\n` : "compat-digest: no changes\n",
);
