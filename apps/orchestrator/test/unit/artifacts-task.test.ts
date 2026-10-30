import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentActor } from "../../src/artifacts/actors.js";
import type { EmbedSource } from "../../src/artifacts/embeds.js";
import { ArtifactError } from "../../src/artifacts/errors.js";
import { artifactStore } from "../../src/artifacts/store.js";
import { expandTaskEmbeds, resolveTaskContent, taskSnapshot } from "../../src/artifacts/task.js";
import { EMBED_BUDGET } from "../../src/artifacts/types.js";
import type { Queryable } from "../../src/db/pg.js";
import { noteRowAt } from "../helpers/artifacts.js";
import { agentRow } from "../helpers/generation.js";

const FALLBACK_TASK = "Assist the user and collaborate with the guild members.\n";

const actor = agentActor({ orgId: "org_1", guildId: "guild_1", agentId: "a_1", agentName: "researcher" });

function templatesRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "guilds-task-template-"));
}

/** An embed source whose every display path holds the note `content`. */
function noteSource(content: string): EmbedSource {
  return {
    async getByDisplayPath(_actor, href) {
      return { row: noteRowAt(href, content) };
    },
    async describeCollection() {
      return null;
    },
  };
}

test("resolveTaskContent takes the focus over any template", () => {
  assert.equal(resolveTaskContent("  Watch the inbox  ", templatesRoot()), "Watch the inbox\n");
});

test("resolveTaskContent reads task.md from the templates root", () => {
  const root = templatesRoot();
  writeFileSync(path.join(root, "task.md"), "Template task\n");
  assert.equal(resolveTaskContent("", root), "Template task\n");
});

test("resolveTaskContent falls back to the default without a templates root or a task.md in it", () => {
  assert.equal(resolveTaskContent(""), FALLBACK_TASK);
  assert.equal(resolveTaskContent("", templatesRoot()), FALLBACK_TASK);
});

test("resolveTaskContent throws when task.md exists but cannot be read", () => {
  const root = templatesRoot();
  mkdirSync(path.join(root, "task.md"));
  assert.throws(() => resolveTaskContent("", root), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error);
    assert.equal(error.code, "EISDIR");
    return true;
  });
});

test("expandTaskEmbeds inlines the notes a Task embeds", async () => {
  const expanded = await expandTaskEmbeds(noteSource("Rules"), actor, "Follow ![[org/org_1/rules.md]]");
  assert.deepEqual(expanded, { ok: true, text: 'Follow <rules path="org/org_1/rules.md" level="org">\nRules\n</rules>' });
});

test("expandTaskEmbeds returns the refusal when the embeds pass the embed budget", async () => {
  const expanded = await expandTaskEmbeds(noteSource("x".repeat(EMBED_BUDGET + 1)), actor, "![[org/org_1/big.md]]");
  assert.deepEqual(expanded, { ok: false, error: "embed budget exceeded" });
});

test("expandTaskEmbeds throws a failure that is not a store refusal", async () => {
  const source: EmbedSource = {
    async getByDisplayPath() {
      throw new Error("connection lost");
    },
    async describeCollection() {
      return null;
    },
  };
  await assert.rejects(expandTaskEmbeds(source, actor, "![[org/org_1/rules.md]]"), /connection lost/);
});

test("taskSnapshot throws the store's refusal of a collection the Task embeds", async () => {
  const db = {
    async query() {
      throw new ArtifactError("collection lookup refused", 403);
    },
  };
  const store = artifactStore(db as unknown as Queryable);
  const agent = agentRow({ task: "Write to ![[org/org_1/collections/leads]]" });
  await assert.rejects(taskSnapshot(store, agent), (error: unknown) => {
    assert.ok(error instanceof ArtifactError);
    assert.equal(error.message, "collection lookup refused");
    return true;
  });
});
