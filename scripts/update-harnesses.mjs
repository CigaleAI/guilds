#!/usr/bin/env node
// Moves the runtime image's coding harnesses to their vendors' latest releases: rewrites each
// harness's version, and the checksums of the ones installed from a release tarball, in
// runtime/Dockerfile, and the versions the harnesses page lists. It builds nothing: the image's
// build installs each CLI and runs it, and the check runs the turns recorded from them.
//
//   node scripts/update-harnesses.mjs

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = path.join(ROOT, "runtime/Dockerfile");
const HARNESSES_PAGE = path.join(ROOT, "docs/concepts/coding/harnesses.md");

const CURSOR_INSTALLER = "https://cursor.com/install";
const CURSOR_DOWNLOADS = "https://downloads.cursor.com/lab";
const ANTIGRAVITY_MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

async function fetched(url) {
  const response = await fetch(url, { headers: { "user-agent": "curl/8" } });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response;
}

/** The version npm serves as a package's latest. */
async function npmLatest(name) {
  const { version } = await (await fetched(`https://registry.npmjs.org/${name}/latest`)).json();
  if (typeof version !== "string" || !version) {
    throw new Error(`npm names no latest version of ${name}`);
  }
  return version;
}

async function sha256Of(url) {
  const body = Buffer.from(await (await fetched(url)).arrayBuffer());
  return createHash("sha256").update(body).digest("hex");
}

/** The Cursor CLI release its installer downloads, and the checksum of its tarball for each architecture. */
async function cursorLatest() {
  const installer = await (await fetched(CURSOR_INSTALLER)).text();
  const version = installer.match(/downloads\.cursor\.com\/lab\/([^/"\s]+)\//)?.[1];
  if (version === undefined) {
    throw new Error(`${CURSOR_INSTALLER} names no release`);
  }
  const sum = (asset) => sha256Of(`${CURSOR_DOWNLOADS}/${version}/linux/${asset}/agent-cli-package.tar.gz`);
  return { version, sums: { x64: await sum("x64"), arm64: await sum("arm64") } };
}

/** What Antigravity's release manifest of one platform names: the release in its tarball's URL, and the tarball's checksum. */
async function antigravityManifest(platform) {
  const manifest = await (await fetched(`${ANTIGRAVITY_MANIFESTS}/${platform}.json`)).json();
  const release = typeof manifest.url === "string" ? manifest.url.match(/\/antigravity-cli\/([^/]+)\//)?.[1] : undefined;
  if (release === undefined || typeof manifest.sha512 !== "string") {
    throw new Error(`Antigravity's ${platform} manifest names no release`);
  }
  return { release, sum: manifest.sha512 };
}

/** The Antigravity CLI release its manifests name, the same for each architecture, and each tarball's checksum. */
async function antigravityLatest() {
  const x64 = await antigravityManifest("linux_amd64");
  const arm64 = await antigravityManifest("linux_arm64");
  if (x64.release !== arm64.release) {
    throw new Error(`Antigravity's manifests name two releases: ${x64.release} and ${arm64.release}`);
  }
  return { version: x64.release, sums: { x64: x64.sum, arm64: arm64.sum } };
}

/** `text` with the one match of `pattern` holding `value` in place of its first group; throws unless it matches once. */
function withValue(text, pattern, value) {
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`${pattern} matches ${matches.length} times, not once`);
  }
  const [match] = matches;
  const start = match.index + match[0].indexOf(match[1]);
  return text.slice(0, start) + value + text.slice(start + match[1].length);
}

/** The Dockerfile with a harness's version argument set. */
function withVersion(dockerfile, argument, version) {
  return withValue(dockerfile, new RegExp(`^ARG ${argument}=(\\S+)$`, "m"), version);
}

/** The Dockerfile with the checksum beside each of a harness's two assets set. */
function withSums(dockerfile, assets, sums) {
  const escaped = (asset) => asset.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const amd64 = withValue(dockerfile, new RegExp(`amd64\\) asset=${escaped(assets.x64)}; sum=([0-9a-f]+) ;;`), sums.x64);
  return withValue(amd64, new RegExp(`arm64\\) asset=${escaped(assets.arm64)}; sum=([0-9a-f]+) ;;`), sums.arm64);
}

/** The harnesses page with the version its build arguments table lists for `argument` set. */
function withListedVersion(page, argument, version) {
  return withValue(page, new RegExp(`^\\| \`${argument}\` \\| \`([^\`]+)\` \\|`, "m"), version);
}

const [codex, claudeCode, cursor, antigravity] = await Promise.all([
  npmLatest("@openai/codex"),
  npmLatest("@anthropic-ai/claude-code"),
  cursorLatest(),
  antigravityLatest(),
]);
const versions = {
  CODEX_VERSION: codex,
  CLAUDE_CODE_VERSION: claudeCode,
  CURSOR_VERSION: cursor.version,
  ANTIGRAVITY_VERSION: antigravity.version,
};

const before = await readFile(DOCKERFILE, "utf8");
let dockerfile = before;
let page = await readFile(HARNESSES_PAGE, "utf8");
for (const [argument, version] of Object.entries(versions)) {
  const pinned = before.match(new RegExp(`^ARG ${argument}=(\\S+)$`, "m"))?.[1];
  console.log(pinned === version ? `${argument} ${version} (unchanged)` : `${argument} ${pinned} -> ${version}`);
  dockerfile = withVersion(dockerfile, argument, version);
  page = withListedVersion(page, argument, version);
}
dockerfile = withSums(dockerfile, { x64: "x64", arm64: "arm64" }, cursor.sums);
dockerfile = withSums(dockerfile, { x64: "linux-x64/cli_linux_x64", arm64: "linux-arm/cli_linux_arm64" }, antigravity.sums);

await writeFile(DOCKERFILE, dockerfile);
await writeFile(HARNESSES_PAGE, page);
console.log(dockerfile === before ? "every harness is at its latest release" : "runtime/Dockerfile and the harnesses page are updated: build the runtime image and run the check");
