import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactError } from "../../src/artifacts/errors.js";
import { fileBlobKey, mimeForName, normalizeMime, validateFileDescription } from "../../src/artifacts/files.js";
import { fileDisplayPath, normalizeFileName, parseDisplayPath } from "../../src/artifacts/paths.js";

test("a file name is one path segment without folders, dots, or control characters", () => {
  assert.equal(normalizeFileName(" report.pdf "), "report.pdf");
  assert.equal(normalizeFileName("README"), "README");
  for (const bad of ["", " ", ".", "..", "a/b.pdf", "a\\b.pdf", "a\u0000b", "a\nb", "x".repeat(256)]) {
    assert.throws(() => normalizeFileName(bad), ArtifactError, JSON.stringify(bad));
  }
});

test("a file sits under files/ in its owner, and its display path parses back", () => {
  assert.equal(fileDisplayPath("org_1", "agent", "a_1", "report.pdf"), "org/org_1/agents/a_1/files/report.pdf");
  assert.equal(fileDisplayPath("org_1", "guild", "guild_1", "data.csv"), "org/org_1/guilds/guild_1/files/data.csv");
  assert.equal(fileDisplayPath("org_1", "org", "org_1", "logo.png"), "org/org_1/files/logo.png");
  assert.deepEqual(parseDisplayPath("org/org_1/guilds/guild_1/files/data.csv"), {
    kind: "artifact",
    orgId: "org_1",
    level: "guild",
    ownerId: "guild_1",
    path: "files",
    key: "data.csv",
  });
});

test("the media type follows the name when the client sends none, and is checked when it does", () => {
  assert.equal(mimeForName("report.PDF"), "application/pdf");
  assert.equal(mimeForName("notes.md"), "text/markdown");
  assert.equal(mimeForName("blob"), "application/octet-stream");
  assert.equal(normalizeMime("", "data.csv"), "text/csv");
  assert.equal(normalizeMime("Application/JSON; charset=utf-8", "x"), "application/json");
  assert.throws(() => normalizeMime("not a mime", "x"), /media type/);
});

test("a description is required and bounded", () => {
  assert.equal(validateFileDescription("  Quarterly figures  "), "Quarterly figures");
  assert.throws(() => validateFileDescription("   "), /description is required/);
  assert.throws(() => validateFileDescription("x".repeat(401)), /at most 400/);
});

test("each version of a file has its own object in the blob store", () => {
  assert.equal(fileBlobKey("org_1", "art_1", 1), "org_1/files/art_1/v1");
  assert.notEqual(fileBlobKey("org_1", "art_1", 1), fileBlobKey("org_1", "art_1", 2));
});
