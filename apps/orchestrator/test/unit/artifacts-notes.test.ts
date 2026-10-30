import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { planNote } from "../../src/artifacts/notes.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("planNote places a draft directly under the owner its level names", () => {
  const draft = { key: " plan.md ", content: "body\n" };
  assert.equal(planNote({ orgId: "org_1", ownerId: "a_1" }, { ...draft, level: "agent" }).href, "org/org_1/agents/a_1/plan.md");
  assert.equal(planNote({ orgId: "org_1", ownerId: "guild_1" }, { ...draft, level: "guild" }).href, "org/org_1/guilds/guild_1/plan.md");
  assert.equal(planNote({ orgId: "org_1", ownerId: "org_1" }, { ...draft, level: "org" }).href, "org/org_1/plan.md");
});

test("planNote returns the file name as a write stores it", () => {
  assert.equal(planNote({ orgId: "org_1", ownerId: "org_1" }, { level: "org", key: " plan.md ", content: "" }).key, "plan.md");
});

test("planNote refuses a key that is not a note file name, and the Task and Memory names at agent level", () => {
  const owner = { orgId: "org_1", ownerId: "a_1" };
  assert.throws(() => planNote(owner, { level: "agent", key: "research/plan.md", content: "" }), {
    name: "ArtifactError",
    message: "note key must be a .md file name; notes have no folders",
  });
  assert.throws(() => planNote(owner, { level: "agent", key: "task.md", content: "" }), {
    name: "ArtifactError",
    message: "task.md is reserved",
  });
  assert.equal(planNote({ orgId: "org_1", ownerId: "org_1" }, { level: "org", key: "task.md", content: "" }).href, "org/org_1/task.md");
});

test("planNote hashes the title with the hash of the text, an absent title as null", () => {
  const owner = { orgId: "org_1", ownerId: "org_1" };
  const titled = planNote(owner, { level: "org", key: "plan.md", title: "Plan", content: "body\n" });
  const untitled = planNote(owner, { level: "org", key: "plan.md", content: "body\n" });
  assert.equal(titled.hash, sha256(JSON.stringify(["Plan", sha256("body\n")])));
  assert.equal(untitled.hash, sha256(JSON.stringify([null, sha256("body\n")])));
});
