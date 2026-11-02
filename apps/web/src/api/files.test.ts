import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiError } from "./client";
import { isFileItem, uploadFile } from "./files";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const item = {
  id: "file_1",
  display_path: "org/o1/files/notes.md",
  name: "notes.md",
  description: "Meeting notes",
  mime: "text/markdown",
  bytes: 120,
  version: 3,
  author: "Ada",
  updated_at: "2026-01-01T00:00:00Z",
};

test("isFileItem admits a stored file, with or without its access", () => {
  assert.equal(isFileItem(item), true);
  assert.equal(isFileItem({ ...item, access: "write" }), true);
});

test("isFileItem refuses a reply missing a field or naming another access", () => {
  assert.equal(isFileItem({ ...item, name: undefined }), false);
  assert.equal(isFileItem({ ...item, version: "3" }), false);
  assert.equal(isFileItem({ ...item, access: "admin" }), false);
  assert.equal(isFileItem([]), false);
});

const upload = {
  file: new File(["x"], "notes.md"),
  description: "Notes",
  access: { type: "guild" as const, id: "g1", mode: "write" as const },
};

test("uploadFile sends the file to the organisation with its first access row, and returns the stored file", async () => {
  const sent: { url: string; headers: Headers }[] = [];
  globalThis.fetch = async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json(item);
  };
  assert.deepEqual(await uploadFile(upload), item);
  assert.equal(sent[0]?.url, "/api/org/files");
  assert.equal(sent[0]?.headers.get("X-Access-Type"), "guild");
  assert.equal(sent[0]?.headers.get("X-Access-Id"), "g1");
  assert.equal(sent[0]?.headers.get("X-Access-Mode"), "write");
  assert.equal(sent[0]?.headers.get("X-Expected-Version"), null);
});

test("uploadFile sends the version it expects: 0 to only create, the loaded one to replace", async () => {
  const sent: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    sent.push(new Headers(init?.headers));
    return Response.json(item);
  };
  await uploadFile({ ...upload, expectedVersion: 0 });
  await uploadFile({ ...upload, expectedVersion: 3 });
  assert.deepEqual(
    sent.map((headers) => headers.get("X-Expected-Version")),
    ["0", "3"],
  );
});

test("uploadFile fails with an ApiError on a reply that is not a file", async () => {
  globalThis.fetch = async () => Response.json({ stored: true });
  await assert.rejects(uploadFile(upload), ApiError);
});
