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
  display_path: "/guild/notes.md",
  name: "notes.md",
  description: "Meeting notes",
  mime: "text/markdown",
  bytes: 120,
  level: "guild",
  owner_id: "g1",
  version: 3,
  author: "Ada",
  updated_at: "2026-01-01T00:00:00Z",
};

test("isFileItem admits a stored file, with or without its access", () => {
  assert.equal(isFileItem(item), true);
  assert.equal(isFileItem({ ...item, access: "write" }), true);
});

test("isFileItem refuses a reply missing a field or naming another level or access", () => {
  assert.equal(isFileItem({ ...item, name: undefined }), false);
  assert.equal(isFileItem({ ...item, version: "3" }), false);
  assert.equal(isFileItem({ ...item, level: "world" }), false);
  assert.equal(isFileItem({ ...item, access: "admin" }), false);
  assert.equal(isFileItem([]), false);
});

test("uploadFile returns the stored file", async () => {
  globalThis.fetch = async () => Response.json(item);
  assert.deepEqual(
    await uploadFile("/api/guilds/g1/files", new File(["x"], "notes.md"), "Notes"),
    item,
  );
});

test("uploadFile fails with an ApiError on a reply that is not a file", async () => {
  globalThis.fetch = async () => Response.json({ stored: true });
  await assert.rejects(
    uploadFile("/api/guilds/g1/files", new File(["x"], "notes.md"), "Notes"),
    ApiError,
  );
});
