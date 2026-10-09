import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AgentFileError, readAgentFile, writeAgentFile } from "../../src/lib/agent-file.js";
import { tempDir } from "../helpers/env.js";

/**
 * A workspace beside a file that stands in for the orchestrator's own files: the path a planted
 * link names resolves against the orchestrator's filesystem, not the sandbox's.
 */
function workspaceWithHostFile(): { workspace: string; host: string; hostDir: string } {
  const base = tempDir("guilds-agent-file-");
  const workspace = path.join(base, "a_1");
  const hostDir = path.join(base, "host");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hostDir);
  const host = path.join(hostDir, "environ");
  writeFileSync(host, "SECRETS_MASTER_KEY=deadbeef");
  return { workspace, host, hostDir };
}

async function refused(run: () => Promise<unknown>, problem: AgentFileError["problem"], label: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AgentFileError, label);
    assert.equal(error.problem, problem, label);
    return true;
  });
}

test("readAgentFile reads a regular file, and a link that stays in the workspace", async () => {
  const { workspace } = workspaceWithHostFile();
  mkdirSync(path.join(workspace, "reports"));
  writeFileSync(path.join(workspace, "reports", "q3.txt"), "numbers");
  symlinkSync(path.join(workspace, "reports", "q3.txt"), path.join(workspace, "latest.txt"));
  const read = await readAgentFile(workspace, "/home/agent/reports/q3.txt", { maxBytes: 100 });
  assert.equal(read.bytes.toString(), "numbers");
  assert.equal(read.path, path.join(workspace, "reports", "q3.txt"));
  assert.equal((await readAgentFile(workspace, "latest.txt", { maxBytes: 100 })).bytes.toString(), "numbers");
});

test("readAgentFile refuses links out of the workspace, missing files, and large files", async () => {
  const { workspace, host, hostDir } = workspaceWithHostFile();
  symlinkSync(host, path.join(workspace, "report.pdf"));
  symlinkSync(hostDir, path.join(workspace, "shared"));
  symlinkSync("/proc/self/environ", path.join(workspace, "environ.txt"));
  mkdirSync(path.join(workspace, "folder"));
  writeFileSync(path.join(workspace, "big.bin"), "x".repeat(101));
  await refused(() => readAgentFile(workspace, "report.pdf", { maxBytes: 100 }), "outside", "file link");
  await refused(() => readAgentFile(workspace, "shared/environ", { maxBytes: 100 }), "outside", "folder link");
  await refused(() => readAgentFile(workspace, "../host/environ", { maxBytes: 100 }), "outside", "dot-dot");
  await refused(() => readAgentFile(workspace, "/etc/passwd", { maxBytes: 100 }), "outside", "absolute");
  if (existsSync("/proc/self/environ")) {
    await refused(() => readAgentFile(workspace, "environ.txt", { maxBytes: 100 }), "outside", "proc link");
  }
  await refused(() => readAgentFile(workspace, "missing.txt", { maxBytes: 100 }), "missing", "missing");
  await refused(() => readAgentFile(workspace, "folder", { maxBytes: 100 }), "not_file", "folder");
  await refused(() => readAgentFile(workspace, "big.bin", { maxBytes: 100 }), "too_large", "large");
});

test("readAgentFile refuses a FIFO without waiting for a writer", async () => {
  const { workspace } = workspaceWithHostFile();
  execFileSync("mkfifo", [path.join(workspace, "pipe")]);
  await refused(() => readAgentFile(workspace, "pipe", { maxBytes: 100 }), "not_file", "fifo");
});

test("writeAgentFile creates folders and replaces a regular file", async () => {
  const { workspace } = workspaceWithHostFile();
  const written = await writeAgentFile(workspace, "/home/agent/downloads/2026/brief.txt", Buffer.from("one"));
  assert.equal(written, path.join(workspace, "downloads", "2026", "brief.txt"));
  await writeAgentFile(workspace, "downloads/2026/brief.txt", Buffer.from("two"));
  assert.equal(readFileSync(written, "utf8"), "two");
});

test("writeAgentFile never writes through a planted link", async () => {
  const { workspace, host, hostDir } = workspaceWithHostFile();
  symlinkSync(host, path.join(workspace, "brief.txt"));
  symlinkSync(hostDir, path.join(workspace, "downloads"));
  symlinkSync(path.join(hostDir, "planted"), path.join(workspace, "dangling.txt"));
  mkdirSync(path.join(workspace, "folder"));
  execFileSync("mkfifo", [path.join(workspace, "pipe")]);
  await refused(() => writeAgentFile(workspace, "brief.txt", Buffer.from("owned")), "not_file", "file link");
  await refused(() => writeAgentFile(workspace, "downloads/new.txt", Buffer.from("owned")), "outside", "folder link");
  await refused(
    () => writeAgentFile(workspace, "downloads/deeper/new.txt", Buffer.from("owned")),
    "outside",
    "folder link with folders to create",
  );
  await refused(() => writeAgentFile(workspace, "dangling.txt", Buffer.from("owned")), "not_file", "dangling link");
  await refused(() => writeAgentFile(workspace, "folder", Buffer.from("owned")), "not_file", "folder");
  await refused(() => writeAgentFile(workspace, "pipe", Buffer.from("owned")), "not_file", "fifo");
  assert.equal(readFileSync(host, "utf8"), "SECRETS_MASTER_KEY=deadbeef");
  assert.equal(existsSync(path.join(hostDir, "new.txt")), false);
  assert.equal(existsSync(path.join(hostDir, "deeper")), false);
  assert.equal(existsSync(path.join(hostDir, "planted")), false);
});
