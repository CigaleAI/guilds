import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemSections } from "../../api/types/access";
import type { FileItem } from "../../api/types/files";
import { ApiError } from "../../api/client";
import { fileMeta, searchFiles, uploadExpectedVersion, uploadFailure, uploadProblem } from "./fileList";

const item = (name: string, description: string): FileItem => ({
  id: `f_${name}`,
  display_path: `org/o/files/${name}`,
  name,
  description,
  mime: "application/pdf",
  bytes: 2048,
  version: 1,
  author: "operator",
  updated_at: "2026-10-26T09:00:00Z",
  home: null,
  viewer_mode: "all_read",
});

const names = (sections: ItemSections<FileItem>) => ({
  own: sections.own.map((file) => file.name),
  shared: sections.shared.map((file) => file.name),
});

test("files match the search by name or description in each section, and all show without one", () => {
  const files = {
    own: [item("report.pdf", "Quarterly figures")],
    shared: [item("logo.png", "The brand mark"), item("figures.csv", "Raw data")],
  };
  assert.deepEqual(searchFiles(files, ""), files);
  assert.deepEqual(names(searchFiles(files, "FIGURES")), { own: ["report.pdf"], shared: ["figures.csv"] });
  assert.deepEqual(names(searchFiles(files, "logo")), { own: [], shared: ["logo.png"] });
  assert.deepEqual(names(searchFiles(files, "nothing")), { own: [], shared: [] });
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

test("an upload replaces the listed file of its name over the version loaded, and otherwise only creates", () => {
  const listed = [{ ...item("report.pdf", "Figures"), version: 3 }, item("logo.png", "Mark")];
  assert.equal(uploadExpectedVersion("report.pdf", listed), 3);
  assert.equal(uploadExpectedVersion("new.csv", listed), 0);
  assert.equal(uploadExpectedVersion("report.pdf", []), 0);
});

test("a refused upload says whether the name was taken or the file moved on, and other failures keep the server's words", () => {
  assert.equal(
    uploadFailure(new ApiError(409, "artifact already exists"), 0),
    "A file with this name already exists in the organisation, outside this list.",
  );
  assert.equal(
    uploadFailure(new ApiError(409, "version conflict"), 3),
    "The file was replaced since this list loaded. Upload again to replace the new version.",
  );
  assert.equal(uploadFailure(new ApiError(422, "file storage limit reached"), 0), "file storage limit reached");
});
