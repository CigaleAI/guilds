import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BlobMissing, FileBlobStore } from "../../src/lib/blob-store.js";
import { tempDir } from "../helpers/env.js";

const notFound = (error: unknown) => error instanceof BlobMissing;

test("the file store keeps an object across instances, as a file under its root", async () => {
  const root = tempDir("guilds-blobs-");
  const store = new FileBlobStore(root);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await store.put("org_home/att_1", bytes, "image/png");
  assert.deepEqual(await store.get("org_home/att_1"), bytes);
  assert.deepEqual(readFileSync(path.join(root, "org_home", "att_1")), bytes);
  assert.equal(statSync(path.join(root, "org_home", "att_1")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.join(root, "org_home")), ["att_1"], "no partial file is left behind");

  // Another process on the same directory reads what this one wrote.
  assert.deepEqual(await new FileBlobStore(root).get("org_home/att_1"), bytes);

  await store.put("org_home/att_1", Buffer.from("replaced"), "image/png");
  assert.equal((await store.get("org_home/att_1")).toString(), "replaced");

  assert.equal(await store.signedReadUrl("org_home/att_1", 60_000), null);
});

test("the file store answers a missing object, and deleting one twice, without failing", async () => {
  const store = new FileBlobStore(tempDir("guilds-blobs-"));
  await assert.rejects(() => store.get("org_home/att_none"), notFound);
  await store.put("org_home/att_2", Buffer.from("x"), "image/png");
  await store.delete("org_home/att_2");
  await assert.rejects(() => store.get("org_home/att_2"), notFound);
  await store.delete("org_home/att_2");
});

test("a key cannot name a file outside the store", async () => {
  const root = tempDir("guilds-blobs-");
  const store = new FileBlobStore(path.join(root, "store"));
  for (const key of ["../escape", "org_home/../../escape", "/etc/passwd", "org_home//att", "org_home/.", "", "org\\..\\escape", "org_home/a\0b"]) {
    await assert.rejects(() => store.put(key, Buffer.from("x"), "image/png"), notFound, JSON.stringify(key));
    await assert.rejects(() => store.get(key), notFound, JSON.stringify(key));
    await assert.rejects(() => store.delete(key), notFound, JSON.stringify(key));
  }
  assert.equal(existsSync(path.join(root, "escape")), false);
  assert.deepEqual(readdirSync(root), [], "nothing was written, not even the store's own directory");
});
