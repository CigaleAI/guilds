import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyText } from "./clipboard";

function useClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

test("text the browser takes is copied", async () => {
  const written: string[] = [];
  useClipboard(async (text) => {
    written.push(text);
  });
  assert.equal(await copyText("# Notes"), "copied");
  assert.deepEqual(written, ["# Notes"]);
});

test("a copy the browser refuses is unavailable", async () => {
  useClipboard(() => Promise.reject(new Error("not allowed")));
  assert.equal(await copyText("# Notes"), "unavailable");
});

test("a copy without a clipboard is unavailable", async () => {
  assert.equal(await copyText("# Notes"), "unavailable");
});
