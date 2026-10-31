import assert from "node:assert/strict";
import { test } from "node:test";
import { isRfb } from "./AgentBrowser";

test("a connection with every method the clipboard bridge calls is noVNC's RFB", () => {
  const call = () => undefined;
  const rfb = { focus: call, sendKey: call, clipboardPasteFrom: call, addEventListener: call };
  assert.equal(isRfb(rfb), true);
});

test("a connection missing a method the clipboard bridge calls is not noVNC's RFB", () => {
  const call = () => undefined;
  assert.equal(isRfb({ focus: call, sendKey: call, addEventListener: call }), false);
  assert.equal(
    isRfb({ focus: call, sendKey: call, clipboardPasteFrom: "x", addEventListener: call }),
    false,
  );
  assert.equal(isRfb(null), false);
});
