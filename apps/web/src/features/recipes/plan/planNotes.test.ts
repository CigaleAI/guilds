import assert from "node:assert/strict";
import { test } from "node:test";
import { noteAccessLabel, noteCard, noteSnippet, noteTitle } from "./planNotes";
import { planFromRecipe } from "./planModel";
import { deskRecipe } from "./planFixtures";

test("apply notes keep the recipe body matched by id or key", () => {
  const recipe = deskRecipe();
  const plan = planFromRecipe(recipe, {
    creates: {
      notes: [
        { key: "style.md", guild: null, writers: [] },
        { key: "new.md", guild: "read", writers: ["writer"] },
      ],
    },
  });
  assert.equal(plan.notes[0]?.body, "# Style\n\nKeep replies short.");
  assert.equal(plan.notes[0]?.id, "style");
  assert.equal(plan.notes[1]?.body, "");
  assert.equal(planFromRecipe(recipe).notes[0], recipe.notes?.[0]);
});

test("noteCard shows the title, who reaches it, first line, and the key apply writes the note at", () => {
  const card = noteCard({ key: "style.md", body: "\n## Style\r\nKeep it short." });
  assert.deepEqual(card, {
    title: "style.md",
    access: "guild write",
    snippet: "Style",
    destination: "style.md",
    body: "\n## Style\r\nKeep it short.",
  });
  const writersNote = noteCard({ key: "k.md", writers: ["writer"], body: "" });
  assert.equal(writersNote.access, "@writer write");
  assert.equal(writersNote.destination, "k.md");
  assert.equal(writersNote.snippet, "Empty note");
  assert.equal(noteTitle({ id: "  " }), "note");
  assert.equal(noteSnippet("x".repeat(100)), `${"x".repeat(85)}…`);
});

test("noteAccessLabel shows the guild's mode with the roles that write, the writers alone, or the guild writing it", () => {
  assert.equal(noteAccessLabel({ guild: "read" }), "guild read");
  assert.equal(noteAccessLabel({ guild: "read", writers: ["reader"] }), "guild read · writers: @reader");
  assert.equal(noteAccessLabel({ writers: ["reader", "writer"] }), "@reader, @writer write");
  assert.equal(noteAccessLabel({}), "guild write");
  assert.equal(noteAccessLabel({ writers: [] }), "guild write");
});
