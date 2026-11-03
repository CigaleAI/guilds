import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EmbeddableNote,
  EmbeddableNoteList,
  EmbeddableNoteSections,
  ListedEmbeddableNote,
} from "../../api/types/notes";
import type { Collection } from "../../api/types/tables";
import { choiceGroups, holdsNoChoice, isInsertable, selectedChoice } from "./insertChoices";

function note(key: string, title: string | null = null): EmbeddableNote {
  return {
    display_path: `org/org_a/${key}`,
    kind: "note",
    key,
    title,
    author: null,
    version: 1,
    updated_at: "2026-09-26T09:00:00+00:00",
    content: "",
  };
}

function listed(
  key: string,
  mode: ListedEmbeddableNote["viewer_mode"],
  home: ListedEmbeddableNote["home"] = null,
): ListedEmbeddableNote {
  return { ...note(key, `About ${key}`), id: `n_${key}`, home, viewer_mode: mode };
}

function noteList(notes: EmbeddableNote[]): EmbeddableNoteList {
  return { kind: "list", notes };
}

const sections: EmbeddableNoteSections = {
  kind: "sections",
  sections: {
    own: [listed("process.md", "write"), listed("vault.md", "none")],
    shared: [listed("sources.md", "read", { id: "g_ops", name: "ops" }), listed("org.md", "read")],
  },
};

const noCollections = { collections: undefined, orgId: "org_a" };

const paths = (groups: ReturnType<typeof choiceGroups>) =>
  groups?.groups.map((group) => [group.label, group.choices.map((choice) => choice.title)]);

test("the operator's notes are one list of every note, without a mode", () => {
  const groups = choiceGroups(
    "note",
    { notes: noteList([note("a.md"), note("b.md")]), ...noCollections },
    "",
  );
  assert.equal(groups?.layout, "list");
  assert.deepEqual(paths(groups), [["Notes", ["a.md", "b.md"]]]);
  assert.equal(groups?.groups[0]?.choices[0]?.mode, undefined);
});

test("an agent's notes are its two sections, each note with the agent's mode", () => {
  const groups = choiceGroups("note", { notes: sections, ...noCollections }, "");
  assert.equal(groups?.layout, "sections");
  assert.deepEqual(paths(groups), [
    ["Guild notes", ["process.md", "vault.md"]],
    ["Shared with this guild", ["sources.md", "org.md"]],
  ]);
  assert.deepEqual(
    groups?.groups.flatMap((group) => group.choices.map((choice) => choice.mode)),
    ["write", "none", "read", "read"],
  );
});

test("a shared note names its home beside its title; a note of the guild names only its title", () => {
  const groups = choiceGroups("note", { notes: sections, ...noCollections }, "");
  assert.deepEqual(
    groups?.groups.map((group) => group.choices.map((choice) => choice.meta)),
    [
      ["About process.md", "About vault.md"],
      ["About sources.md · ops", "About org.md · Organisation"],
    ],
  );
});

test("a search keeps both sections, empty or not, and drops an empty group of a list", () => {
  const found = choiceGroups("note", { notes: sections, ...noCollections }, "sources");
  assert.deepEqual(paths(found), [
    ["Guild notes", []],
    ["Shared with this guild", ["sources.md"]],
  ]);
  const none = choiceGroups("note", { notes: noteList([note("a.md")]), ...noCollections }, "zzz");
  assert.deepEqual(none?.groups, []);
  assert.ok(none && holdsNoChoice(none));
});

test("an empty section says what it lists, or that no note matches a typed search", () => {
  const empty: EmbeddableNoteSections = { kind: "sections", sections: { own: [], shared: [] } };
  const listedEmpties = (query: string) =>
    choiceGroups("note", { notes: empty, ...noCollections }, query)?.groups.map((group) => group.empty);
  assert.deepEqual(listedEmpties(""), [
    "Notes made in this agent's guild appear here.",
    "Notes from elsewhere that a row for this guild, its agents or the organisation reaches appear here.",
  ]);
  assert.deepEqual(listedEmpties("   "), listedEmpties(""));
  assert.deepEqual(listedEmpties("zzz"), ["No notes match.", "No notes match."]);
});

test("tables are listed for a table or a column, and nothing loads until the list does", () => {
  const orders: Collection = {
    id: "c_1",
    name: "orders",
    purpose: "Every order",
    columns: [],
    display_path: "org/org_a/collections/orders",
    scope: "org",
    guild: null,
    created_at: "2026-09-26T09:00:00+00:00",
    updated_at: "2026-09-26T09:00:00+00:00",
  };
  assert.equal(choiceGroups("note", { notes: undefined, ...noCollections }, ""), undefined);
  assert.equal(choiceGroups("table", { notes: sections, ...noCollections }, ""), undefined);
  const groups = choiceGroups(
    "column",
    { notes: undefined, collections: [orders], orgId: "org_a" },
    "",
  );
  assert.deepEqual(paths(groups), [["Tables", ["orders"]]]);
  assert.equal(groups?.groups[0]?.choices[0]?.path, "org/org_a/collections/orders");
});

test("a note the agent does not reach cannot be inserted, even when selected", () => {
  const groups = choiceGroups("note", { notes: sections, ...noCollections }, "");
  const choices = groups?.groups.flatMap((group) => group.choices) ?? [];
  assert.deepEqual(
    choices.map((choice) => [choice.title, isInsertable(choice)]),
    [
      ["process.md", true],
      ["vault.md", false],
      ["sources.md", true],
      ["org.md", true],
    ],
  );
  assert.equal(selectedChoice(groups, "org/org_a/vault.md"), undefined);
  assert.equal(selectedChoice(groups, "org/org_a/sources.md")?.title, "sources.md");
  assert.equal(selectedChoice(groups, null), undefined);
});
