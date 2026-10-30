import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyText } from "./clipboard";

const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText } },
    configurable: true,
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "navigator", original);
});

test("copied_when_the_clipboard_takes_the_text", async () => {
  const written: string[] = [];
  stubClipboard(async (text) => {
    written.push(text);
  });
  assert.equal(await copyText("https://example.com/sign-in"), "copied");
  assert.deepEqual(written, ["https://example.com/sign-in"]);
});

test("unavailable_when_the_browser_refuses_the_write", async () => {
  stubClipboard(() => Promise.reject(new DOMException("Denied", "NotAllowedError")));
  assert.equal(await copyText("https://example.com/sign-in"), "unavailable");
});

test("unavailable_when_the_browser_has_no_clipboard", async () => {
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  assert.equal(await copyText("https://example.com/sign-in"), "unavailable");
});
