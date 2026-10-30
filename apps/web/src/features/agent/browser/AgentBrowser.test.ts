import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyToHostClipboard, isRfb } from "./AgentBrowser";

test("a connection with every method the clipboard bridge calls is noVNC's RFB", () => {
  const call = () => undefined;
  const rfb = { focus: call, sendKey: call, clipboardPasteFrom: call, addEventListener: call };
  assert.equal(isRfb(rfb), true);
});

test("a connection missing a method the clipboard bridge calls is not noVNC's RFB", () => {
  const call = () => undefined;
  assert.equal(isRfb({ focus: call, sendKey: call, addEventListener: call }), false);
  assert.equal(isRfb({ focus: call, sendKey: call, clipboardPasteFrom: "x", addEventListener: call }), false);
  assert.equal(isRfb(null), false);
});

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
