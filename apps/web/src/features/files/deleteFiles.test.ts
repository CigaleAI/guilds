import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileItem } from "../../api/types/files";
import { deleteFilesInTurn, fileDeletionFailureToast } from "./deleteFiles";

const item = (name: string): FileItem => ({
  id: `f_${name}`,
  display_path: `org/o/files/${name}`,
  name,
  description: name,
  mime: "text/plain",
  bytes: 1,
  version: 1,
  author: "operator",
  updated_at: "2026-10-26T09:00:00Z",
  home: null,
  viewer_mode: "write",
});

test("files are deleted one at a time in order, and a refused one is recorded while the rest still go", async () => {
  const files = [item("a.txt"), item("b.txt"), item("c.txt")];
  const sent: string[] = [];
  let inFlight = 0;
  const outcome = await deleteFilesInTurn(files, async (id) => {
    inFlight += 1;
    assert.equal(inFlight, 1, "one request in flight at most");
    sent.push(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    if (id === "f_b.txt") throw new Error("write not allowed");
    return undefined;
  });
  assert.deepEqual(sent, ["f_a.txt", "f_b.txt", "f_c.txt"]);
  assert.deepEqual(outcome.deleted, [files[0], files[2]]);
  assert.deepEqual(outcome.failed, [{ file: files[1], reason: "write not allowed" }]);
});

test("a delete that every file refuses deletes none", async () => {
  const outcome = await deleteFilesInTurn([item("a.txt")], () => Promise.reject(new Error("artifact not found")));
  assert.deepEqual(outcome.deleted, []);
  assert.equal(outcome.failed.length, 1);
});

test("the failure toast counts the refused files and names each with its reason", () => {
  assert.deepEqual(fileDeletionFailureToast([{ file: item("a.txt"), reason: "artifact not found" }]), {
    kind: "error",
    title: "Couldn't delete 1 file",
    description: "a.txt: artifact not found",
  });
  assert.deepEqual(
    fileDeletionFailureToast([
      { file: item("a.txt"), reason: "artifact not found" },
      { file: item("b.txt"), reason: "write not allowed" },
    ]),
    {
      kind: "error",
      title: "Couldn't delete 2 files",
      description: "a.txt: artifact not found\nb.txt: write not allowed",
    },
  );
});
