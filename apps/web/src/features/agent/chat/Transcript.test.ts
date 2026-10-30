import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { attachmentImageUrl } from "./Transcript";

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
