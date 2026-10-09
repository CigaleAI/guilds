import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadManifest } from "../src/connectors/manifest.js";
import { packTarball } from "../src/registry/tar.js";

/**
 * A connector folder as the files of its registry package: `connector.json` checked by the
 * loader, `logo.svg` when there is one, and `adapter.ts` bundled into `adapter.js`, one
 * self-contained ESM file whose only runtime input is the context the pool passes it.
 */
export async function connectorFiles(folder: string): Promise<Array<readonly [string, Buffer]>> {
  const slug = path.basename(path.resolve(folder));
  const manifest = loadManifest(JSON.parse(readFileSync(path.join(folder, "connector.json"), "utf8")), slug);
  const files: Array<readonly [string, Buffer]> = [[`${slug}/connector.json`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]];
  if (existsSync(path.join(folder, "logo.svg"))) {
    files.push([`${slug}/logo.svg`, readFileSync(path.join(folder, "logo.svg"))]);
  }
  const entry = path.join(folder, "adapter.ts");
  if (existsSync(entry)) {
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
    files.push([`${slug}/adapter.js`, Buffer.from(output.contents)]);
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
