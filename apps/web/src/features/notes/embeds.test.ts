import assert from "node:assert/strict";
import { test } from "node:test";
import type { ItemSections } from "../../api/types/access";
import type { EmbeddableNote, ListedEmbeddableNote } from "../../api/types/notes";
import type { Collection } from "../../api/types/tables";
import { embedIsBroken, insertMarkup, noteEmbed } from "./embeds";

function note(key: string): EmbeddableNote {
  return {
    display_path: `org/org_a/${key}`,
    kind: "note",
    key,
    title: null,
    author: null,
    version: 1,
    updated_at: "2026-09-26T09:00:00+00:00",
    content: "",
  };
}

test("an embed is broken when the server says so or nothing visible matches it", () => {
  const notes = [note("scoring.md")];
  const collections = [
    { id: "c_1", name: "orders", purpose: "" } satisfies Pick<
      Collection,
      "id" | "name" | "purpose"
    >,
  ];
  const known = { serverBroken: [], notes, collections, orgId: "org_a" };
  assert.equal(embedIsBroken("org/org_a/scoring.md", known), false);
  assert.equal(embedIsBroken("org/org_a/gone.md", known), true);
  assert.equal(embedIsBroken("org/org_a/collections/orders", known), false);
  assert.equal(embedIsBroken("org/org_a/collections/gone", known), true);
  assert.equal(
    embedIsBroken("org/org_a/scoring.md", {
      ...known,
      serverBroken: ["org/org_a/scoring.md"],
    }),
    true,
  );
  assert.equal(embedIsBroken("org/org_a/gone.md", { ...known, notes: undefined }), false);
});

test("past the operator's list cap, a note missing from it is not called broken", () => {
  const notes = Array.from({ length: 500 }, (_, index) => note(`n${index}.md`));
  const known = { serverBroken: [], notes, collections: [], orgId: "org_a" };
  assert.equal(embedIsBroken("org/org_a/gone.md", known), false);
  assert.equal(embedIsBroken("org/org_a/gone.md", { ...known, notes: notes.slice(1) }), true);
  assert.deepEqual(noteEmbed("org/org_a/gone.md", notes), { state: "unknown" });
});

function listed(key: string, mode: ListedEmbeddableNote["viewer_mode"]): ListedEmbeddableNote {
  return { ...note(key), id: `n_${key}`, home: null, viewer_mode: mode };
}

test("with an agent's sections, an embed is broken unless a row reaches the agent", () => {
  const notes: ItemSections<ListedEmbeddableNote> = {
    own: [listed("process.md", "write"), listed("vault.md", "none")],
    shared: [listed("sources.md", "read")],
  };
  const known = { serverBroken: [], notes, collections: [], orgId: "org_a" };
  assert.equal(embedIsBroken("org/org_a/process.md", known), false);
  assert.equal(embedIsBroken("org/org_a/sources.md", known), false);
  assert.equal(embedIsBroken("org/org_a/vault.md", known), true);
  assert.equal(embedIsBroken("org/org_a/gone.md", known), true);
  assert.equal(noteEmbed("org/org_a/sources.md", notes).state, "readable");
  assert.deepEqual(noteEmbed("org/org_a/vault.md", notes), { state: "unreadable" });
});

const pick = {
  path: "org/org_a/scoring.md",
  table: "",
  column: null,
  mode: "embed" as const,
};

test("a picked note is embedded or referenced as the operator chose", () => {
  assert.equal(insertMarkup("note", pick), "![[org/org_a/scoring.md]]");
  assert.equal(insertMarkup("note", { ...pick, mode: "reference" }), "[[org/org_a/scoring.md]]");
});

test("a picked table is always embedded", () => {
  const table = { ...pick, path: "org/org_a/collections/orders", mode: "reference" as const };
  assert.equal(insertMarkup("table", table), "![[org/org_a/collections/orders]]");
});

test("a picked column is named with its table, and nothing is inserted without a column", () => {
  const table = { ...pick, path: "org/org_a/collections/orders", table: "orders" };
  assert.equal(insertMarkup("column", { ...table, column: "status" }), "`orders.status`");
  assert.equal(insertMarkup("column", table), null);
});
