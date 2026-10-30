import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { attachmentImageUrl, messageAttachments } from "./Transcript";

test("a user message's attachments are the references it stores", () => {
  const image = { id: "att_1", filename: "a.png", mime: "image/png", kind: "image" };
  assert.deepEqual(messageAttachments({ attachments: [{ ...image, size: 3 }] }), [image]);
});

test("a malformed attachment reference is left out", () => {
  const file = { id: "att_2", filename: "a.pdf", mime: "application/pdf", kind: "file" };
  const attachments = [{ ...file, kind: "video" }, { ...file, id: "" }, "att_3", null, file];
  assert.deepEqual(messageAttachments({ attachments }), [file]);
  assert.deepEqual(messageAttachments({ attachments: "att_1" }), []);
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an attached image the server returns reads as a blob URL", async () => {
  globalThis.fetch = async () => new Response(new Blob(["png"], { type: "image/png" }));
  const url = await attachmentImageUrl("att_1");
  assert.ok(url?.startsWith("blob:"));
  if (url) URL.revokeObjectURL(url);
});

test("an attached image the server refuses reads as no image", async () => {
  globalThis.fetch = async () => new Response("gone", { status: 404, statusText: "Not Found" });
  assert.equal(await attachmentImageUrl("att_gone"), null);
});

test("an attached image that cannot be fetched reads as no image", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await attachmentImageUrl("att_1"), null);
});
