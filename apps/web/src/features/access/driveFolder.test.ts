import assert from "node:assert/strict";
import { test } from "node:test";
import { driveFolderUrl } from "./driveFolder";

test("a folder's Drive link is its encoded id under Drive's folders page", () => {
  assert.equal(
    driveFolderUrl("1AbC_d-9"),
    "https://drive.google.com/drive/folders/1AbC_d-9",
  );
  assert.equal(
    driveFolderUrl("a/../b?x=1#y"),
    "https://drive.google.com/drive/folders/a%2F..%2Fb%3Fx%3D1%23y",
  );
});
