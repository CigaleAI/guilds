import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectTaskEmbeds,
  embedTagName,
  inspectEmbed,
  inspectTaskEmbeds,
  inlineTaskEmbeds,
  snapshotTaskCollections,
  snapshotTaskEmbeds,
  unreachableMarker,
  walkTaskEmbeds,
  withoutEmbeds,
  type EmbedReader,
} from "../../src/artifacts/embeds.js";
import { ArtifactError } from "../../src/artifacts/errors.js";
import { EMBED_BUDGET } from "../../src/artifacts/types.js";
import { agentActor, operatorActor } from "../../src/artifacts/actors.js";
import type { ArtifactStore } from "../../src/artifacts/store.js";

test("collectTaskEmbeds keeps unique hrefs in order", () => {
  assert.deepEqual(
    collectTaskEmbeds("See ![[org/org_1/a.md]] and ![[org/org_1/a.md]] then ![[org/org_1/b.md]]"),
    ["org/org_1/a.md", "org/org_1/b.md"],
  );
});

test("inlineTaskEmbeds expands one nested hop", async () => {
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

test("inlineTaskEmbeds puts the unreachable marker in place of a nested note it cannot read", async () => {
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
  const inlined = await inlineTaskEmbeds(
    store as unknown as ArtifactStore,
    operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
    "![[org/org_1/schema.md]]",
  );
  assert.equal(
    inlined,
    `<schema path="org/org_1/schema.md" level="org">\nBody ${unreachableMarker("org/org_1/secret.md")}\n</schema>`,
  );
});

test("inlineTaskEmbeds replaces a nested collection path with the table name", async () => {
  const store = {
    async describeCollection() {
      return { name: "leads" };
    },
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
  assert.equal(embedTagName("unreachable.md"), "note-unreachable");
  assert.equal(embedTagName("---.md"), "note");
});

test("inlineTaskEmbeds marks every embed that does not resolve to a readable note the same way", async () => {
  const store = {
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/record") return { row: { kind: "object", level: "org", key: "x", content_json: {} } };
      if (href === "org/org_1/gone.md") return { tombstone: true, row: { kind: "note" } };
      throw new ArtifactError("artifact not found", 404);
    },
  };
  const hrefs = ["org/org_1/record", "org/org_1/gone.md", "org/org_1/hidden.md", "recipe:desk", "notes/plan.md"];
  const inlined = await inlineTaskEmbeds(
    store as unknown as ArtifactStore,
    operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
    hrefs.map((href) => `![[${href}]]`).join("\n"),
  );
  assert.equal(inlined, hrefs.map(unreachableMarker).join("\n"));
});

test("unreachableMarker names the path and says the file is not reachable", () => {
  assert.equal(
    unreachableMarker('org/o/a "b".md'),
    '<unreachable path="org/o/a &quot;b&quot;.md" message="This file is not reachable." />',
  );
});

test("inlineTaskEmbeds still refuses a Task past the embed budget", async () => {
  const store = {
    async getByDisplayPath() {
      return { row: { kind: "note", level: "org", key: "big.md", content_text: "x".repeat(EMBED_BUDGET + 1) } };
    },
  };
  await assert.rejects(
    () =>
      inlineTaskEmbeds(
        store as unknown as ArtifactStore,
        operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
        "![[org/org_1/big.md]]",
      ),
    /embed budget exceeded/,
  );
});

test("inlineTaskEmbeds marks a collection the actor cannot read and names one it can", async () => {
  const store = {
    async describeCollection(_actor: unknown, name: string) {
      return name === "leads" ? { name: "leads" } : null;
    },
  };
  const inlined = await inlineTaskEmbeds(
    store as unknown as ArtifactStore,
    operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" }),
    "![[org/org_1/collections/leads]] ![[org/org_1/collections/shut]] ![[org/org_2/collections/leads]]",
  );
  assert.equal(
    inlined,
    `leads ${unreachableMarker("org/org_1/collections/shut")} ${unreachableMarker("org/org_2/collections/leads")}`,
  );
});

test("inlineTaskEmbeds reads each embed as the actor it is given", async () => {
  const seen: unknown[] = [];
  const store = {
    async getByDisplayPath(actor: { operator: boolean }) {
      seen.push(actor.operator);
      if (actor.operator) return { row: { kind: "note", level: "org", key: "rules.md", content_text: "secret rules" } };
      throw new ArtifactError("artifact not found", 404);
    },
  };
  const agent = agentActor({ orgId: "org_1", guildId: "g_1", agentId: "a_1", agentName: "Ada" });
  const inlined = await inlineTaskEmbeds(store as unknown as ArtifactStore, agent, "Follow ![[org/org_1/rules.md]]");
  assert.equal(inlined, `Follow ${unreachableMarker("org/org_1/rules.md")}`);
  assert.deepEqual(seen, [false]);
});

test("snapshotTaskEmbeds and snapshotTaskCollections keep only what the actor can read", async () => {
  const store = {
    async describeCollection(_actor: unknown, name: string) {
      return name === "leads" ? { name: "leads" } : null;
    },
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/a.md") return { row: { kind: "note", level: "org", key: "a.md", version: 2, content_text: "a" } };
      throw new ArtifactError("artifact not found", 404);
    },
  };
  const actor = operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" });
  const task = "![[org/org_1/a.md]] ![[org/org_1/b.md]] ![[org/org_1/collections/leads]] ![[org/org_1/collections/shut]]";
  const notes = await snapshotTaskEmbeds(store as unknown as ArtifactStore, actor, task);
  assert.deepEqual(notes.map((item) => [item.display_path, item.version]), [["org/org_1/a.md", 2]]);
  assert.deepEqual(await snapshotTaskCollections(store as unknown as ArtifactStore, actor, task), [
    "org/org_1/collections/leads",
  ]);
});

test("inlineTaskEmbeds replaces a collection path with the table name", async () => {
  const store = {
    async describeCollection() {
      return { name: "leads" };
    },
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

test("inspectTaskEmbeds accepts a readable collection and flags one that is not reachable", async () => {
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

test("inspectTaskEmbeds flags leftover recipe links and files that are not reachable", async () => {
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

const notesReader = (notes: Record<string, string>): EmbedReader => async (href) => notes[href] ?? null;

test("walkTaskEmbeds inlines two levels and marks the third as staying text", async () => {
  const steps = await walkTaskEmbeds(
    "![[org/o/a.md]]",
    notesReader({ "org/o/a.md": "![[org/o/b.md]]", "org/o/b.md": "![[org/o/c.md]]", "org/o/c.md": "![[org/o/d.md]]" }),
    3,
  );
  assert.deepEqual(steps, [
    { from: null, href: "org/o/a.md", depth: 1, inlined: true },
    { from: "org/o/a.md", href: "org/o/b.md", depth: 2, inlined: true },
    { from: "org/o/b.md", href: "org/o/c.md", depth: 3, inlined: false },
  ]);
});

test("walkTaskEmbeds stops at the inlined levels by default", async () => {
  const steps = await walkTaskEmbeds(
    "![[org/o/a.md]]",
    notesReader({ "org/o/a.md": "![[org/o/b.md]]", "org/o/b.md": "![[org/o/c.md]]" }),
  );
  assert.deepEqual(steps.map((step) => step.href), ["org/o/a.md", "org/o/b.md"]);
});

test("walkTaskEmbeds meets a note once, at the depth the run first inlines it", async () => {
  const steps = await walkTaskEmbeds(
    "![[org/o/a.md]] then ![[org/o/b.md]]",
    notesReader({ "org/o/a.md": "![[org/o/b.md]]", "org/o/b.md": "![[org/o/c.md]]" }),
    3,
  );
  assert.deepEqual(
    steps.map((step) => [step.href, step.depth, step.inlined]),
    [
      ["org/o/a.md", 1, true],
      ["org/o/b.md", 2, true],
      ["org/o/c.md", 3, false],
    ],
  );
});

test("walkTaskEmbeds still inlines a note it first met too deep", async () => {
  const steps = await walkTaskEmbeds(
    "![[org/o/a.md]] then ![[org/o/c.md]]",
    notesReader({ "org/o/a.md": "![[org/o/b.md]]", "org/o/b.md": "![[org/o/c.md]]", "org/o/c.md": "end" }),
    3,
  );
  assert.deepEqual(
    steps.map((step) => [step.href, step.depth, step.inlined]),
    [
      ["org/o/a.md", 1, true],
      ["org/o/b.md", 2, true],
      ["org/o/c.md", 3, false],
      ["org/o/c.md", 1, true],
    ],
  );
});

test("withoutEmbeds leaves only the prose", () => {
  assert.equal(withoutEmbeds("See ![[org/o/a.md]] and org/o/b.md"), "See   and org/o/b.md");
});

test("inspectEmbed names why a link does not resolve", async () => {
  const store = {
    async describeCollection() {
      return { name: "leads" };
    },
    async getByDisplayPath(_actor: unknown, href: string) {
      if (href === "org/org_1/agents/a_1/memory.md") return { row: { kind: "memory" } };
      if (href === "org/org_1/gone.md") return { tombstone: true, row: { kind: "note" } };
      throw new ArtifactError("artifact not found", 404);
    },
  } as unknown as ArtifactStore;
  const actor = operatorActor({ orgId: "org_1", actorId: "u", actorName: "op" });
  const reasons = await Promise.all(
    [
      "notes/plan.md",
      "org/org_1/agents/a_1/memory.md",
      "org/org_1/gone.md",
      "org/org_1/hidden.md",
      "org/org_2/collections/leads",
    ].map(async (href) => (await inspectEmbed(store, actor, href)).reason),
  );
  assert.deepEqual(reasons, ["not a file path", "not a note", "not reachable", "not reachable", "not reachable"]);
});
