import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionCopy } from "./sectionCopy";

test("a guild page's note sections are its guild notes and those shared with it", () => {
  assert.deepEqual(sectionCopy("note", "guild"), {
    ownLabel: "Guild notes",
    ownEmpty: "Notes made in this guild appear here.",
    sharedLabel: "Shared with this guild",
    sharedEmpty:
      "Notes from elsewhere that a row for this guild, its agents or the organisation reaches appear here.",
    noMatch: "No notes match.",
  });
});

test("an agent page's own section names the agent's guild, and files are named as files", () => {
  const copy = sectionCopy("file", "agent");
  assert.equal(copy.ownLabel, "Guild files");
  assert.equal(copy.ownEmpty, "Files made in this agent's guild appear here.");
  assert.equal(copy.sharedLabel, "Shared with this guild");
  assert.equal(copy.noMatch, "No files match.");
});
