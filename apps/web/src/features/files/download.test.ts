import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { attemptFileDownload } from "./download";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, "document");
  mock.timers.reset();
});

test("a file the server sends is saved under its name", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async () => new Response("bytes", { status: 200 });
  const clicked: string[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        const anchor = { href: "", download: "", click: () => clicked.push(anchor.download) };
        return anchor;
      },
    },
  });
  assert.deepEqual(await attemptFileDownload("f_1", "report.pdf"), { kind: "saved" });
  assert.deepEqual(clicked, ["report.pdf"]);
});

test("a download the server refuses fails with the server's reason", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "No such file" }), { status: 404 });
  assert.deepEqual(await attemptFileDownload("f_1", "report.pdf"), {
    kind: "failed",
    reason: "No such file",
  });
});

test("a download that cannot reach the server fails with the network's reason", async () => {
  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  assert.deepEqual(await attemptFileDownload("f_1", "report.pdf"), {
    kind: "failed",
    reason: "Failed to fetch",
  });
});
