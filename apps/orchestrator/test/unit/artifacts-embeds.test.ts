import assert from "node:assert/strict";
import { test } from "node:test";
import { collectTaskEmbeds, embedTagName, inspectTaskEmbeds, inlineTaskEmbeds } from "../../src/artifacts/embeds.js";
import { ArtifactError } from "../../src/artifacts/errors.js";
import { operatorActor } from "../../src/artifacts/grants.js";
import type { ArtifactStore } from "../../src/artifacts/store.js";

test("collectTaskEmbeds keeps unique hrefs in order", () => {
  assert.deepEqual(
    collectTaskEmbeds("See ![[org/org_1/a.md]] and ![[org/org_1/a.md]] then ![[org/org_1/b.md]]"),
    ["org/org_1/a.md", "org/org_1/b.md"],
  );
});

test("inlineTaskEmbeds loads as operator and expands one nested hop", async () => {
  const store = {
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/schema.md") {
        return {
          row: {
            kind: "note",
            level: "org",
            title: "schema",
            key: "schema.md",
            content_text: "Body ![[org/org_1/secret.md]]",
          },
        };
      }
      if (href === "org/org_1/secret.md") {
        return {
          row: {
            kind: "note",
            level: "org",
            title: "secret",
            key: "secret.md",
            content_text: "secret was loaded ![[org/org_1/third.md]]",
          },
        };
      }
      throw new ArtifactError("artifact not found", 404);
    },
  };
  const actor = operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" });
  const inlined = await inlineTaskEmbeds(
    store as unknown as ArtifactStore,
    actor,
    "Follow ![[org/org_1/schema.md]] and again ![[org/org_1/schema.md]]\n",
  );
  assert.equal(
    inlined,
    "Follow <schema path=\"org/org_1/schema.md\" level=\"org\">\nBody <secret path=\"org/org_1/secret.md\" level=\"org\">\nsecret was loaded ![[org/org_1/third.md]]\n</secret>\n</schema> and again schema\n",
  );
  assert.ok(!inlined.includes("![[org/org_1/schema.md]]"));
  assert.ok(!inlined.includes("![[org/org_1/secret.md]]"));
  assert.ok(inlined.includes("secret was loaded"));
  assert.ok(inlined.includes("![[org/org_1/third.md]]"));
});

test("inlineTaskEmbeds fails a missing nested note", async () => {
  const store = {
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/schema.md") {
        return {
          row: {
            kind: "note",
            level: "org",
            title: "schema",
            key: "schema.md",
            content_text: "Body ![[org/org_1/secret.md]]",
          },
        };
      }
      throw new ArtifactError("artifact not found", 404);
    },
  };
  await assert.rejects(
    () =>
      inlineTaskEmbeds(
        store as unknown as ArtifactStore,
        operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
        "![[org/org_1/schema.md]]",
      ),
    /embed failed: org\/org_1\/secret\.md/,
  );
});

test("inlineTaskEmbeds replaces a nested collection path with the table name", async () => {
  const store = {
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/process.md") {
        return {
          row: {
            kind: "note",
            level: "agent",
            title: "process",
            key: "process.md",
            content_text: "Write ![[org/org_1/collections/leads]]",
          },
        };
      }
      throw new ArtifactError("should not load a collection as an artifact", 404);
    },
  };
  const inlined = await inlineTaskEmbeds(
    store as unknown as ArtifactStore,
    operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
    "Follow ![[org/org_1/process.md]]\n",
  );
  assert.equal(
    inlined,
    "Follow <process path=\"org/org_1/process.md\" level=\"agent\">\nWrite leads\n</process>\n",
  );
});

test("inlineTaskEmbeds replaces each unique embed in place", async () => {
  const store = {
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/a.md") {
        return { row: { kind: "note", level: "org", title: "A", key: "a.md", content_text: "alpha" } };
      }
      if (href === "org/org_1/b.md") {
        return { row: { kind: "note", level: "guild", title: "B", key: "b.md", content_text: "beta" } };
      }
      throw new ArtifactError("artifact not found", 404);
    },
  };
  const inlined = await inlineTaskEmbeds(
    store as unknown as ArtifactStore,
    operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
    "Start ![[org/org_1/a.md]] middle ![[org/org_1/b.md]] end\n",
  );
  assert.equal(
    inlined,
    "Start <a path=\"org/org_1/a.md\" level=\"org\">\nalpha\n</a> middle <b path=\"org/org_1/b.md\" level=\"guild\">\nbeta\n</b> end\n",
  );
});

test("embedTagName names the element after the file", () => {
  assert.equal(embedTagName("trading-rules.md"), "trading-rules");
  assert.equal(embedTagName("Desk Protocol v1.2.md"), "Desk-Protocol-v1-2");
  assert.equal(embedTagName("2026-plan.md"), "note-2026-plan");
  assert.equal(embedTagName("task.md"), "note-task");
  assert.equal(embedTagName("Memory.md"), "note-Memory");
  assert.equal(embedTagName("---.md"), "note");
});

test("inlineTaskEmbeds fails a missing or non-note target", async () => {
  const store = {
    async getByDisplayPath() {
      return { row: { kind: "object", level: "org", title: "x", key: "x", content_json: {} } };
    },
  };
  await assert.rejects(
    () =>
      inlineTaskEmbeds(
        store as unknown as ArtifactStore,
        operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
        "![[org/org_1/x]]",
      ),
    /not a note/,
  );
});

test("inlineTaskEmbeds replaces a collection path with the table name", async () => {
  const store = {
    async getByDisplayPath() {
      throw new ArtifactError("should not load a collection as an artifact", 404);
    },
  };
  const inlined = await inlineTaskEmbeds(
    store as unknown as ArtifactStore,
    operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
    "Write to ![[org/org_1/collections/leads]] then list ![[org/org_1/collections/leads]]\n",
  );
  assert.equal(inlined, "Write to leads then list leads\n");
});

test("inspectTaskEmbeds accepts a live collection and flags a missing one", async () => {
  const store = {
    async describeCollection(_actor: unknown, name: string) {
      return name === "leads" ? { name: "leads" } : null;
    },
    async getByDisplayPath() {
      return { row: null };
    },
  };
  const actor = operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" });
  const inspected = await inspectTaskEmbeds(
    store as unknown as ArtifactStore,
    actor,
    "See ![[org/org_1/collections/leads]] and ![[org/org_1/collections/missing]]",
  );
  assert.deepEqual(
    inspected.map((item) => ({ href: item.href, ok: item.ok })),
    [
      { href: "org/org_1/collections/leads", ok: true },
      { href: "org/org_1/collections/missing", ok: false },
    ],
  );
});

test("inspectTaskEmbeds flags leftover recipe links and missing files", async () => {
  const store = {
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/schema.md") {
        return { row: { kind: "note", level: "org", title: "schema", key: "schema.md", content_text: "ok" } };
      }
      return { row: null };
    },
  };
  const actor = operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" });
  const inspected = await inspectTaskEmbeds(
    store as unknown as ArtifactStore,
    actor,
    "See ![[recipe:desk-protocol]] and ![[org/org_1/schema.md]] and ![[org/org_1/missing.md]]",
  );
  assert.deepEqual(
    inspected.map((item) => ({ href: item.href, ok: item.ok })),
    [
      { href: "recipe:desk-protocol", ok: false },
      { href: "org/org_1/schema.md", ok: true },
      { href: "org/org_1/missing.md", ok: false },
    ],
  );
});

test("inspectTaskEmbeds walks one nested hop", async () => {
  const store = {
    async describeCollection(_actor: unknown, name: string) {
      return name === "leads" ? { name: "leads" } : null;
    },
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/process.md") {
        return {
          row: {
            kind: "note",
            level: "agent",
            title: "process",
            key: "process.md",
            content_text: "See ![[org/org_1/schema.md]] and ![[org/org_1/collections/leads]]",
          },
        };
      }
      if (href === "org/org_1/schema.md") {
        return { row: { kind: "note", level: "org", title: "schema", key: "schema.md", content_text: "ok" } };
      }
      return { row: null };
    },
  };
  const inspected = await inspectTaskEmbeds(
    store as unknown as ArtifactStore,
    operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
    "Follow ![[org/org_1/process.md]]",
  );
  assert.deepEqual(
    inspected.map((item) => ({ href: item.href, ok: item.ok })),
    [
      { href: "org/org_1/process.md", ok: true },
      { href: "org/org_1/schema.md", ok: true },
      { href: "org/org_1/collections/leads", ok: true },
    ],
  );
});
