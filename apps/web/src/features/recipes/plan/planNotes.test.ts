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
        { key: "style.md", level: "guild", role: null },
        { key: "new.md", level: "agent", role: "writer" },
      ],
    },
  });
  assert.equal(plan.notes[0]?.body, "# Style\n\nKeep replies short.");
  assert.equal(plan.notes[0]?.id, "style");
  assert.equal(plan.notes[1]?.body, "");
  assert.equal(planFromRecipe(recipe).notes[0], recipe.notes?.[0]);
});

test("noteCard shows the title, owner, first line, and where apply writes the note", () => {
  const card = noteCard({
    key: "style.md",
    level: "guild",
    body: "\n## Style\r\nKeep it short.",
  });
  assert.deepEqual(card, {
    title: "style.md",
    owner: "guild",
    access: "guild write",
    snippet: "Style",
    destination: "guild/style.md",
    body: "\n## Style\r\nKeep it short.",
  });
  const agentNote = noteCard({
    key: "k.md",
    level: "agent",
    role: "writer",
    body: "",
  });
  assert.equal(agentNote.owner, "agent · writer");
  assert.equal(agentNote.access, "@writer only");
  assert.equal(agentNote.destination, "agent/writer/k.md");
  assert.equal(agentNote.snippet, "Empty note");
  assert.equal(noteTitle({ id: "  " }), "note");
  assert.equal(noteSnippet("x".repeat(100)), `${"x".repeat(85)}…`);
});

test("noteAccessLabel shows the guild's mode, or the role alone, with the roles that write", () => {
  assert.equal(noteAccessLabel({ level: "org" }), "guild read");
  assert.equal(noteAccessLabel({ level: "org", guild: "write" }), "guild write");
  assert.equal(noteAccessLabel({ level: "guild" }), "guild write");
  assert.equal(
    noteAccessLabel({ level: "agent", role: "writer", guild: "read", writers: ["reader"] }),
    "guild read · writers: @reader",
  );
  assert.equal(
    noteAccessLabel({ level: "agent", role: "writer", writers: ["reader"] }),
    "@writer · writers: @reader",
  );
});
