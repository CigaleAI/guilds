import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadManifest } from "../src/connectors/manifest.js";
import type { AdapterTool } from "../src/connectors/types.js";
import { importAdapter } from "../src/registry/code.js";
import { packTarball } from "../src/registry/tar.js";

/** `adapter.ts` bundled into one self-contained ESM file whose only runtime input is the context the pool passes it. */
async function bundleAdapter(folder: string, entry: string): Promise<Buffer> {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const output = bundled.outputFiles[0];
  if (!output) {
    throw new Error(`${folder}: adapter.ts bundled to nothing`);
  }
  return Buffer.from(output.contents);
}

/** The tools a bundled adapter runs, as the box imports it. */
async function bundledTools(adapter: Buffer): Promise<readonly AdapterTool[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "guilds-connector-"));
  try {
    const file = path.join(dir, "adapter.js");
    writeFileSync(file, adapter);
    return (await importAdapter(file, createHash("sha256").update(adapter).digest("hex"))).tools ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A connector folder as the files of its registry package: `adapter.ts` bundled into
 * `adapter.js`, `connector.json` as the loader loads it, each tool the bundled adapter runs with
 * the input schema its parameters declare, and `logo.svg` when there is one.
 */
export async function connectorFiles(folder: string): Promise<Array<readonly [string, Buffer]>> {
  const slug = path.basename(path.resolve(folder));
  const entry = path.join(folder, "adapter.ts");
  const adapter = existsSync(entry) ? await bundleAdapter(folder, entry) : null;
  const code = adapter === null ? [] : await bundledTools(adapter);
  const manifest = loadManifest(JSON.parse(readFileSync(path.join(folder, "connector.json"), "utf8")), slug, code);
  const files: Array<readonly [string, Buffer]> = [[`${slug}/connector.json`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]];
  if (existsSync(path.join(folder, "logo.svg"))) {
    files.push([`${slug}/logo.svg`, readFileSync(path.join(folder, "logo.svg"))]);
  }
  if (adapter !== null) {
    files.push([`${slug}/adapter.js`, adapter]);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [folder, out] = process.argv.slice(2);
  if (!folder || !out) {
    throw new Error("usage: build-connector.ts <connector folder> <package.tgz>");
  }
  const body = packTarball(await connectorFiles(folder));
  writeFileSync(out, body);
  console.log(`${out}\tsha256 ${createHash("sha256").update(body).digest("hex")}\tsize ${body.length}`);
}
