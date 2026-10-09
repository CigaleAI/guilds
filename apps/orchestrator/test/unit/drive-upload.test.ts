import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DriveFolderError } from "../../src/connectors/drive/folder.js";
import { attachDriveCreateFile, createDriveFile } from "../../src/connectors/drive/upload.js";
import { mockFetch } from "../helpers/http.js";
import { rewriteDescriptions } from "../../src/connectors/drive/adapter.js";

test("Drive's listing hides create_file and download bytes fields", () => {
  const listed = rewriteDescriptions([
    {
      name: "create_file",
      description: "upload base64",
      input_schema: { type: "object", properties: { base64Content: { type: "string" } } },
    },
    {
      name: "download_file_content",
      description: "download base64",
      input_schema: { type: "object", properties: { content: { type: "string" } } },
    },
    { name: "search_files", description: "search", input_schema: { type: "object" } },
  ]);
  assert.equal(listed[2]?.name, "search_files");
  const create = listed[0];
  assert.ok(create);
  assert.match(create.description, /file_path/);
  const properties = (create.input_schema.properties ?? {}) as Record<string, unknown>;
  assert.ok(properties.file_path);
  assert.equal(properties.base64Content, undefined);
  const download = listed[1];
  assert.ok(download);
  assert.match(download.description, /file_path/);
  const downloadProps = (download.input_schema.properties ?? {}) as Record<string, unknown>;
  assert.ok(downloadProps.file_path);
  assert.equal(downloadProps.content, undefined);
});

test("attachDriveCreateFile reads a workspace file and encodes it", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "drive-upload-"));
  await writeFile(path.join(workspace, "notes.txt"), "hello drive");
  const attached = await attachDriveCreateFile(
    { file_path: "/home/agent/notes.txt", parentId: "folder_1" },
    workspace,
  );
  assert.equal(attached.title, "notes.txt");
  assert.equal(attached.contentMimeType, "text/plain");
  assert.equal(attached.base64Content, Buffer.from("hello drive").toString("base64"));
  assert.equal(attached.parentId, "folder_1");
  assert.equal(attached.file_path, undefined);
});

test("attachDriveCreateFile rejects a path outside the workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "drive-upload-"));
  await assert.rejects(
    () => attachDriveCreateFile({ file_path: "../secret.bin" }, workspace),
    DriveFolderError,
  );
  await assert.rejects(
    () => attachDriveCreateFile({ file_path: "missing.bin" }, workspace),
    /not found/,
  );
  await assert.rejects(
    () => attachDriveCreateFile({ file_path: "notes.txt" }),
    /agent run/,
  );
});

test("attachDriveCreateFile refuses a link out of the workspace", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "drive-upload-"));
  const workspace = path.join(base, "a_1");
  await mkdir(workspace);
  const host = path.join(base, "environ");
  await writeFile(host, "SECRETS_MASTER_KEY=deadbeef");
  await symlink(host, path.join(workspace, "report.pdf"));
  await assert.rejects(
    () => attachDriveCreateFile({ file_path: "/home/agent/report.pdf" }, workspace),
    /not a link out of it/,
  );
});

test("createDriveFile uploads with Shared drive flags", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "drive-upload-"));
  await writeFile(path.join(workspace, "notes.txt"), "hello drive");
  let uploaded: RequestInit | undefined;
  const text = await createDriveFile(
    "tok",
    { file_path: "notes.txt", parentId: "folder_1" },
    {
      workspaceDir: workspace,
      client: mockFetch((url, init) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("supportsAllDrives"), "true");
        assert.ok(parsed.pathname.includes("/upload/drive/v3/files"));
        uploaded = init;
        return {
          status: 200,
          json: { id: "file_1", name: "notes.txt", mimeType: "application/vnd.google-apps.document", parents: ["folder_1"] },
        };
      }),
    },
  );
  assert.equal(uploaded?.method, "POST");
  assert.match(String(uploaded?.headers && (uploaded.headers as Record<string, string>)["Content-Type"]), /multipart\/related/);
  assert.deepEqual(JSON.parse(text), {
    id: "file_1",
    title: "notes.txt",
    parentId: "folder_1",
    mimeType: "application/vnd.google-apps.document",
  });
});

test("createDriveFile posts a folder metadata-only", async () => {
  const text = await createDriveFile(
    "tok",
    { title: "Inbox", contentMimeType: "application/vnd.google-apps.folder", parentId: "folder_1" },
    {
      client: mockFetch((url, init) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("supportsAllDrives"), "true");
        assert.ok(!parsed.pathname.includes("/upload/"));
        assert.equal(init?.method, "POST");
        return {
          status: 200,
          json: { id: "fold_2", name: "Inbox", mimeType: "application/vnd.google-apps.folder", parents: ["folder_1"] },
        };
      }),
    },
  );
  assert.deepEqual(JSON.parse(text), {
    id: "fold_2",
    title: "Inbox",
    parentId: "folder_1",
    mimeType: "application/vnd.google-apps.folder",
  });
});
