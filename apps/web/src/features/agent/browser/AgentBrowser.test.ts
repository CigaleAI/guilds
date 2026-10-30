import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyToHostClipboard } from "./AgentBrowser";

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, "clipboard");
});

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

test("text the host clipboard takes is copied", async () => {
  const written: string[] = [];
  stubClipboard(async (text) => {
    written.push(text);
  });
  assert.equal(await copyToHostClipboard("selection"), true);
  assert.deepEqual(written, ["selection"]);
});

test("text the page may not write to the clipboard is not copied", async () => {
  stubClipboard(async () => {
    throw new DOMException("Write permission denied.", "NotAllowedError");
  });
  assert.equal(await copyToHostClipboard("selection"), false);
});
