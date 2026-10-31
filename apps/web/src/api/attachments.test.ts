import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { isChatAttachment, uploadAttachment } from "./attachments";
import { ApiError } from "./client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const attachment = {
  id: "att_1",
  filename: "shot.png",
  mime: "image/png",
  bytes: 2048,
  kind: "image",
  url: "/api/attachments/att_1",
  created_at: "2026-01-01T00:00:00Z",
};

test("isChatAttachment admits a stored attachment", () => {
  assert.equal(isChatAttachment(attachment), true);
});

test("isChatAttachment refuses a reply missing a field or of another kind", () => {
  assert.equal(isChatAttachment({ ...attachment, url: undefined }), false);
  assert.equal(isChatAttachment({ ...attachment, kind: "video" }), false);
  assert.equal(isChatAttachment({ ...attachment, bytes: "2048" }), false);
  assert.equal(isChatAttachment(null), false);
});

test("uploadAttachment returns the stored attachment", async () => {
  globalThis.fetch = async () => Response.json(attachment, { status: 201 });
  assert.deepEqual(await uploadAttachment(new File(["x"], "shot.png")), attachment);
});

test("uploadAttachment fails with an ApiError on a reply that is not an attachment", async () => {
  globalThis.fetch = async () => Response.json({ ok: true }, { status: 201 });
  await assert.rejects(uploadAttachment(new File(["x"], "shot.png")), ApiError);
});
