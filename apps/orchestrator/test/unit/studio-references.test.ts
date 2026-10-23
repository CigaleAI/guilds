import assert from "node:assert/strict";
import { test } from "node:test";
import { EMBED_BUDGET, walkTaskEmbeds, type EmbedStep } from "../../src/artifacts/index.js";
import {
  buildReferences,
  namedPaths,
  noteTexts,
  type ReferenceFile,
  type ReferenceInput,
  type ReferenceTask,
} from "../../src/studio/references.js";

const path = (name: string) => `org/o/guilds/g/${name}.md`;
const LEADS = "org/o/collections/leads";
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function note(name: string, text: string | null, inState = true): ReferenceFile {
  return {
    display_path: path(name),
    kind: "note",
    label: name,
    level: "guild",
    agent_id: null,
    collection_id: null,
    in_state: inState,
    text,
  };
}

function task(agentId: string, text: string): ReferenceTask {
  return {
    agent_id: agentId,
    label: agentId,
    display_path: `org/o/agents/${agentId}/task.md`,
    text,
  };
}

/** The input as loading builds it: each agent walks its Task reading only what it can reach. */
async function input(
  tasks: ReferenceTask[],
  files: ReferenceFile[],
  unresolved: ReferenceInput["unresolved"] = [],
  blocked: Record<string, string[]> = {},
): Promise<ReferenceInput> {
  const texts = noteTexts(files);
  const walks = new Map<string, EmbedStep[]>();
  const unreachable = new Map<string, Set<string>>();
  for (const item of tasks) {
    const cannotRead = new Set(blocked[item.agent_id] ?? []);
    const read = async (href: string) => (cannotRead.has(href) ? null : (texts.get(href) ?? null));
    walks.set(item.agent_id, await walkTaskEmbeds(item.text, read, 3));
    unreachable.set(item.agent_id, cannotRead);
  }
  return { guild_id: "g", tasks, files, unresolved, walks, unreachable };
}

const leads: ReferenceFile = {
  display_path: LEADS,
  kind: "table",
  label: "leads",
  level: "org",
  agent_id: null,
  collection_id: "col_1",
  in_state: true,
  text: null,
};

async function sample() {
  return buildReferences(
    await input(
      [
        task("a", `![[${path("one")}]] ![[${LEADS}]] ![[org/o/gone.md]] See ${path("named")}.`),
        task("b", `![[${path("one")}]]`),
      ],
      [
        note("one", `![[${path("two")}]]`),
        note("two", `![[${path("three")}]]`),
        note("three", `![[${path("four")}]]`),
        note("four", "end"),
        note("named", "named only"),
        note("lonely", `![[${path("stray")}]]`),
        note("stray", "never reached"),
        leads,
      ],
      [{ href: "org/o/gone.md", reason: "missing" }],
    ),
  );
}

test("buildReferences gives each file the hop each agent's run meets it at", async () => {
  const references = await sample();
  const hops = Object.fromEntries(references.nodes.map((node) => [node.id, node.hops]));
  assert.deepEqual(hops[path("one")], { a: 1, b: 1 });
  assert.deepEqual(hops[path("two")], { a: 2, b: 2 });
  assert.deepEqual(hops[path("three")], { a: 3, b: 3 });
  assert.deepEqual(hops[LEADS], { a: 1 });
  assert.deepEqual(hops["org/o/agents/a/task.md"], { a: 0 });
});

test("buildReferences sets the depth past the walked levels and leaves unreached files without one", async () => {
  const references = await sample();
  const depth = Object.fromEntries(references.nodes.map((node) => [node.id, node.depth]));
  assert.equal(depth["org/o/agents/a/task.md"], 0);
  assert.equal(depth[path("one")], 1);
  assert.equal(depth[path("three")], 3);
  assert.equal(depth[path("four")], 4);
  assert.equal(depth[path("lonely")], null);
  assert.equal(depth[path("stray")], null);
  assert.equal(depth[path("named")], null);
});

test("buildReferences marks each embed inlined, too deep, unreached, or broken, and names apart", async () => {
  const references = await sample();
  const status = (from: string, to: string) =>
    references.edges.find((edge) => edge.from === from && edge.to === to)?.status;
  const taskA = "org/o/agents/a/task.md";
  assert.equal(status(taskA, path("one")), "inlined");
  assert.equal(status(taskA, LEADS), "inlined");
  assert.equal(status(taskA, "org/o/gone.md"), "broken");
  assert.equal(status(taskA, path("named")), "named");
  assert.equal(status(path("one"), path("two")), "inlined");
  assert.equal(status(path("two"), path("three")), "too_deep");
  assert.equal(status(path("lonely"), path("stray")), "unreached");
  assert.equal(references.edges.find((edge) => edge.to === path("named"))?.kind, "name");
});

test("buildReferences keeps why a link does not resolve on its node", async () => {
  const references = await sample();
  const gone = references.nodes.find((node) => node.id === "org/o/gone.md");
  assert.equal(gone?.kind, "unresolved");
  assert.equal(gone?.reason, "missing");
  assert.deepEqual(gone?.hops, { a: 1 });
});

test("buildReferences counts the note text each Task inlines against the budget", async () => {
  const big = "x".repeat(EMBED_BUDGET);
  const references = buildReferences(
    await input(
      [task("a", `![[${path("one")}]] ![[${path("big")}]]`), task("b", `![[${path("one")}]]`)],
      [note("one", `12345![[${path("two")}]]`), note("two", "abc"), note("big", big)],
    ),
  );
  const inlined = (agentId: string) =>
    references.nodes.find((node) => node.id === `org/o/agents/${agentId}/task.md`)?.inlined_bytes;
  const one = Buffer.byteLength(`12345![[${path("two")}]]`, "utf8");
  assert.equal(inlined("b"), one + 3);
  assert.equal(inlined("a"), one + 3 + EMBED_BUDGET);
  assert.equal(references.budget, EMBED_BUDGET);
  assert.equal(references.depth, 2);
});

test("buildReferences marks an embed broken for the run whose agent cannot read the target", async () => {
  const references = buildReferences(
    await input(
      [task("a", `![[${path("one")}]] ![[${path("shut")}]]`), task("b", `![[${path("one")}]]`)],
      [note("one", `![[${path("two")}]]`), note("two", "two"), note("shut", "secret text")],
      [],
      { a: [path("shut")], b: [path("two")] },
    ),
  );
  const status = (from: string, to: string) =>
    references.edges.find((edge) => edge.from === from && edge.to === to)?.status;
  const node = (id: string) => references.nodes.find((item) => item.id === id);
  assert.equal(status("org/o/agents/a/task.md", path("shut")), "broken");
  assert.equal(status("org/o/agents/a/task.md", path("one")), "inlined");
  assert.equal(status(path("one"), path("two")), "broken");
  assert.deepEqual(node(path("shut"))?.unreachable_for, ["a"]);
  assert.deepEqual(node(path("two"))?.unreachable_for, ["b"]);
  assert.deepEqual(node(path("one"))?.unreachable_for, []);
  assert.equal(
    node("org/o/agents/a/task.md")?.inlined_bytes,
    byteLength(`![[${path("two")}]]`) + 3,
  );
  assert.equal(node("org/o/agents/b/task.md")?.inlined_bytes, byteLength(`![[${path("two")}]]`));
});

test("buildReferences draws no edges out of a note it did not read", async () => {
  const references = buildReferences(
    await input([task("a", `![[${path("far")}]]`)], [note("far", null, false)]),
  );
  assert.deepEqual(
    references.edges.map((edge) => edge.from),
    ["org/o/agents/a/task.md"],
  );
  assert.equal(references.nodes.find((node) => node.id === path("far"))?.in_state, false);
});

test("buildReferences draws no name edge beside an embed of the same file or to the file itself", async () => {
  const references = buildReferences(
    await input(
      [task("a", `![[${path("one")}]] as ${path("one")} says`)],
      [note("one", `This is ${path("one")}.`)],
    ),
  );
  assert.deepEqual(
    references.edges.map((edge) => [edge.from, edge.to, edge.kind]),
    [["org/o/agents/a/task.md", path("one"), "embed"]],
  );
});

test("namedPaths finds known paths in prose, trims punctuation, and skips embeds", () => {
  const known = new Set([path("one"), path("two"), path("three")]);
  assert.deepEqual(
    namedPaths(
      `Read ${path("one")}, then (${path("two")}). Not ![[${path("three")}]] or org/o/guilds/g/else.md`,
      known,
    ),
    [path("one"), path("two")],
  );
});

test("namedPaths names a path once however often it appears", () => {
  assert.deepEqual(namedPaths(`${path("one")} and ${path("one")}`, new Set([path("one")])), [
    path("one"),
  ]);
});

test("namedPaths counts a [[…]] reference as a named path", () => {
  assert.deepEqual(namedPaths(`Read [[${path("one")}]] when needed.`, new Set([path("one")])), [path("one")]);
});
