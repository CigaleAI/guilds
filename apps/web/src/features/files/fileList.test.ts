import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileItem } from "../../api/types/files";
import { fileMeta, filterFiles, uploadProblem } from "./fileList";

const item = (name: string, description: string): FileItem => ({
  id: `f_${name}`,
  display_path: `org/o/guilds/g/files/${name}`,
  name,
  description,
  mime: "application/pdf",
  bytes: 2048,
  level: "guild",
  owner_id: "g",
  version: 1,
  author: "operator",
  updated_at: "2026-10-26T09:00:00Z",
});

test("files match the search by name or description, and all show without one", () => {
  const items = [item("report.pdf", "Quarterly figures"), item("logo.png", "The brand mark")];
  assert.deepEqual(filterFiles(items, "").map((file) => file.name), ["report.pdf", "logo.png"]);
  assert.deepEqual(filterFiles(items, "FIGURES").map((file) => file.name), ["report.pdf"]);
  assert.deepEqual(filterFiles(items, "logo").map((file) => file.name), ["logo.png"]);
  assert.deepEqual(filterFiles(items, "nothing"), []);
});

test("an upload needs a non-empty file under the cap and a description", () => {
  assert.equal(uploadProblem(null, "d"), "Choose a file.");
  assert.equal(uploadProblem({ size: 0 }, "d"), "The file is empty.");
  assert.equal(uploadProblem({ size: 11 * 1024 * 1024 }, "d"), "A file is at most 10 MB.");
  assert.equal(uploadProblem({ size: 10 }, "  "), "Say what the file is.");
  assert.equal(uploadProblem({ size: 10 }, "The report"), null);
});

test("a file's meta line names its size, type, author, and time", () => {
  assert.equal(fileMeta(item("a.pdf", "d"), "2 min ago"), "2.0 KB · application/pdf · operator · 2 min ago");
});
