import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoteKeyFree,
  collectionDisplayPath,
  displayPathFor,
  hostFileDisplayPath,
  normalizeNoteKey,
  parseDisplayPath,
  recordDisplayPath,
} from "../../src/artifacts/paths.js";
import { ArtifactError } from "../../src/artifacts/errors.js";

test("display paths put notes under their owner and records under the organisation", () => {
  assert.equal(
    displayPathFor({
      orgId: "org_1",
      level: "org",
      ownerId: "org_1",
      kind: "note",
      path: "",
      key: "schema.md",
    }),
    "org/org_1/schema.md",
  );
  assert.equal(
    displayPathFor({
      orgId: "org_1",
      level: "org",
      ownerId: "org_1",
      kind: "object",
      collectionName: "papers",
      path: "",
      key: "12",
    }),
    "org/org_1/collections/papers/12",
  );
  assert.equal(collectionDisplayPath("org_1", "papers"), "org/org_1/collections/papers");
  assert.equal(recordDisplayPath("org_1", "papers", 12), "org/org_1/collections/papers/12");
  assert.throws(
    () =>
      displayPathFor({
        orgId: "org_1",
        level: "org",
        ownerId: "org_1",
        kind: "object",
        collectionName: null,
        path: "",
        key: "1",
      }),
    /missing its collection name/,
  );
});

test("host file names map to display paths directly under the owner", () => {
  assert.equal(hostFileDisplayPath("org_1", "agent", "a_1", "task.md"), "org/org_1/agents/a_1/task.md");
  assert.equal(hostFileDisplayPath("org_1", "agent", "a_1", "memory.md"), "org/org_1/agents/a_1/memory.md");
  assert.equal(hostFileDisplayPath("org_1", "guild", "guild_1", "brief.md"), "org/org_1/guilds/guild_1/brief.md");
  assert.equal(hostFileDisplayPath("org_1", "org", "org_1", "schema.md"), "org/org_1/schema.md");
  assert.throws(() => hostFileDisplayPath("org_1", "agent", "a_1", "research/queries.md"), ArtifactError);
  assert.throws(() => hostFileDisplayPath("org_1", "agent", "a_1", "history-archive/20260101T000000Z-user.md"), ArtifactError);
  assert.throws(() => hostFileDisplayPath("org_1", "org", "org_1", "collections/papers"), ArtifactError);
});

test("a note key is one .md file name, and task.md and memory.md stay the agent's", () => {
  assert.equal(normalizeNoteKey(" queries.md "), "queries.md");
  assert.throws(() => normalizeNoteKey("queries"), /notes have no folders/);
  assert.throws(() => normalizeNoteKey("notes/queries.md"), /notes have no folders/);
  assert.throws(() => normalizeNoteKey("../queries.md"), ArtifactError);
  assert.throws(() => assertNoteKeyFree("agent", "memory.md"), /reserved/);
  assert.throws(() => assertNoteKeyFree("agent", "task.md"), /reserved/);
  assertNoteKeyFree("guild", "task.md");
  assertNoteKeyFree("agent", "queries.md");
});

test("parseDisplayPath tells notes, collections, records, and revisions apart", () => {
  assert.throws(() => parseDisplayPath("org/org_1/agents"), ArtifactError);
  const parsed = parseDisplayPath("org/org_1/hello.md");
  assert.equal(parsed.kind, "artifact");
  if (parsed.kind === "artifact") {
    assert.equal(parsed.level, "org");
    assert.equal(parsed.key, "hello.md");
  }
  assert.deepEqual(parseDisplayPath("org/org_1/collections/papers"), {
    kind: "collection",
    orgId: "org_1",
    collectionName: "papers",
  });
  assert.deepEqual(parseDisplayPath("org/org_1/collections/papers/12"), {
    kind: "record",
    orgId: "org_1",
    collectionName: "papers",
    recordId: "12",
  });
  assert.throws(() => parseDisplayPath("org/org_1/collections/papers/sub/12"), ArtifactError);
  assert.throws(() => parseDisplayPath("org/org_1/guilds/guild_1/collections/papers/12"), ArtifactError);
  assert.throws(() => parseDisplayPath("org/org_1/agents/a_1/collections/papers"), ArtifactError);
  assert.equal(parseDisplayPath("org/org_1/agents/a_1/history-archive/20260101T000000Z-user.md").kind, "revision");
});
