import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { planNote } from "../../src/artifacts/notes.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("planNote places a draft directly under its organisation", () => {
  assert.equal(planNote("org_1", { key: " plan.md ", content: "body\n" }).href, "org/org_1/plan.md");
});

test("planNote returns the file name as a write stores it", () => {
  assert.equal(planNote("org_1", { key: " plan.md ", content: "" }).key, "plan.md");
});

test("planNote refuses a key that is not a note file name", () => {
  assert.throws(() => planNote("org_1", { key: "research/plan.md", content: "" }), {
    name: "ArtifactError",
    message: "note key must be a .md file name; notes have no folders",
  });
});

test("planNote places task.md and memory.md like any other note, apart from an agent's own", () => {
  assert.equal(planNote("org_1", { key: "task.md", content: "" }).href, "org/org_1/task.md");
  assert.equal(planNote("org_1", { key: "memory.md", content: "" }).href, "org/org_1/memory.md");
});

test("planNote hashes the title with the hash of the text, an absent title as null", () => {
  const titled = planNote("org_1", { key: "plan.md", title: "Plan", content: "body\n" });
  const untitled = planNote("org_1", { key: "plan.md", content: "body\n" });
  assert.equal(titled.hash, sha256(JSON.stringify(["Plan", sha256("body\n")])));
  assert.equal(untitled.hash, sha256(JSON.stringify([null, sha256("body\n")])));
});
