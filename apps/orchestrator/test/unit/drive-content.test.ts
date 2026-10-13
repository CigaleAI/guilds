import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { downloadDriveFileContent, getDriveFileMetadata } from "../../src/connectors/drive/content.js";
import { mockFetch } from "../helpers/http.js";

/** A temporary host directory named after agent a_1, as its home sits on its machine. */
async function agentWorkspace(prefix: string): Promise<string> {
  const workspace = path.join(await mkdtemp(path.join(os.tmpdir(), prefix)), "a_1");
  await mkdir(workspace);
  return workspace;
}

test("getDriveFileMetadata uses Shared drive flags", async () => {
  const text = await getDriveFileMetadata(
    "tok",
    { fileId: "file_1" },
    {
      client: mockFetch((url) => {
        const parsed = new URL(url);
        assert.ok(parsed.pathname.endsWith("/files/file_1"));
        assert.equal(parsed.searchParams.get("supportsAllDrives"), "true");
        return {
          status: 200,
          json: { id: "file_1", name: "Notes", mimeType: "text/plain", parents: ["folder_1"] },
        };
      }),
    },
  );
  assert.deepEqual(JSON.parse(text), {
    id: "file_1",
    title: "Notes",
    parentId: "folder_1",
    mimeType: "text/plain",
  });
});

test("downloadDriveFileContent writes the file under the workspace", async () => {
  const workspace = await agentWorkspace("drive-download-");
  const text = await downloadDriveFileContent(
    "tok",
    { fileId: "file_1" },
    {
      workspaceDir: workspace,
      client: mockFetch((url) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("supportsAllDrives"), "true");
        if (parsed.searchParams.get("alt") === "media") {
          return { status: 200, text: "hello", headers: { "content-type": "text/plain" } };
        }
        return {
          status: 200,
          json: { id: "file_1", name: "notes.txt", mimeType: "text/plain", parents: ["folder_1"] },
        };
      }),
    },
  );
  assert.deepEqual(JSON.parse(text), {
    id: "file_1",
    title: "notes.txt",
    mimeType: "text/plain",
    file_path: "/home/a_1/notes.txt",
    bytes: 5,
  });
  assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "hello");
});

test("downloadDriveFileContent never writes through a link the agent planted", async () => {
  const base = await agentWorkspace("drive-download-");
  const workspace = path.join(base, "a_1");
  await mkdir(workspace);
  const host = path.join(base, "config.json");
  await writeFile(host, "orchestrator config");
  await symlink(host, path.join(workspace, "notes.txt"));
  await symlink(base, path.join(workspace, "downloads"));
  const client = mockFetch((url) => {
    if (new URL(url).searchParams.get("alt") === "media") {
      return { status: 200, text: "attacker bytes", headers: { "content-type": "text/plain" } };
    }
    return { status: 200, json: { id: "file_1", name: "notes.txt", mimeType: "text/plain" } };
  });
  await assert.rejects(
    () => downloadDriveFileContent("tok", { fileId: "file_1" }, { workspaceDir: workspace, client }),
    /regular file, not a link/,
  );
  await assert.rejects(
    () =>
      downloadDriveFileContent(
        "tok",
        { fileId: "file_1", file_path: "downloads/config.json" },
        { workspaceDir: workspace, client },
      ),
    /through folders, not links/,
  );
  assert.equal(await readFile(host, "utf8"), "orchestrator config");
});

test("downloadDriveFileContent exports a Google Doc to a workspace path", async () => {
  const workspace = await agentWorkspace("drive-download-");
  const text = await downloadDriveFileContent(
    "tok",
    { fileId: "doc_1" },
    {
      workspaceDir: workspace,
      client: mockFetch((url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/export")) {
          assert.equal(parsed.searchParams.get("supportsAllDrives"), "true");
          assert.equal(parsed.searchParams.get("mimeType"), "text/plain");
          return { status: 200, text: "doc body", headers: { "content-type": "text/plain" } };
        }
        return {
          status: 200,
          json: {
            id: "doc_1",
            name: "Brief",
            mimeType: "application/vnd.google-apps.document",
            parents: ["folder_1"],
          },
        };
      }),
    },
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.file_path, "/home/a_1/Brief.txt");
  assert.equal(parsed.mimeType, "text/plain");
  assert.equal(parsed.content, undefined);
  assert.equal(await readFile(path.join(workspace, "Brief.txt"), "utf8"), "doc body");
});
