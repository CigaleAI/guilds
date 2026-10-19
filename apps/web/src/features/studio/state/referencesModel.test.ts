import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReferenceEdge, ReferenceNode, StudioReferences } from "../../../api/types";
import {
  formatSize,
  isOverBudget,
  layoutReferences,
  linkLabel,
  linkPath,
  litIds,
  nodeHop,
  reachedAgents,
  referenceColumnLabels,
  referenceLinks,
  referenceMapView,
  referenceMeta,
  referenceStandouts,
  shownIds,
  standoutGroups,
  stateListLocation,
  taskPulls,
} from "./referencesModel";

function node(id: string, fields: Partial<ReferenceNode> = {}): ReferenceNode {
  return {
    id,
    kind: "note",
    label: id,
    level: "guild",
    agent_id: null,
    collection_id: null,
    in_state: true,
    bytes: 10,
    inlined_bytes: null,
    hops: {},
    depth: null,
    reason: null,
    ...fields,
  };
}

const embed = (
  from: string,
  to: string,
  status: ReferenceEdge["status"] = "inlined",
): ReferenceEdge => ({
  from,
  to,
  kind: "embed",
  status,
});

/**
 * Two Tasks share `rules`, which embeds `style`, which embeds `glossary` (left as text), which
 * embeds `deep`. `b`'s Task names `aside` and embeds a link that does not resolve. `lonely` and
 * b's own `draft` are reached by no Task.
 */
const data: StudioReferences = {
  guild_id: "g",
  budget: 100,
  depth: 2,
  nodes: [
    node("task-a", {
      kind: "task",
      label: "Alpha",
      level: "agent",
      agent_id: "a",
      hops: { a: 0 },
      depth: 0,
      inlined_bytes: 30,
    }),
    node("task-b", {
      kind: "task",
      label: "Beta",
      level: "agent",
      agent_id: "b",
      hops: { b: 0 },
      depth: 0,
      inlined_bytes: 120,
    }),
    node("rules", { hops: { a: 1, b: 1 }, depth: 1 }),
    node("style", { hops: { a: 2, b: 2 }, depth: 2 }),
    node("glossary", { hops: { a: 3, b: 3 }, depth: 3 }),
    node("deep", { depth: 4 }),
    node("aside", {}),
    node("lonely", {}),
    node("draft", { level: "agent", agent_id: "b" }),
    node("leads", { kind: "table", collection_id: "col_1", hops: { a: 1 }, depth: 1 }),
    node("gone", {
      kind: "unresolved",
      in_state: false,
      hops: { b: 1 },
      depth: 1,
      reason: "missing",
    }),
  ],
  edges: [
    embed("task-a", "rules"),
    embed("task-a", "leads"),
    embed("task-b", "rules"),
    embed("task-b", "gone", "broken"),
    { from: "task-b", to: "aside", kind: "name", status: "named" },
    embed("rules", "style"),
    embed("style", "glossary", "too_deep"),
    embed("glossary", "deep", "too_deep"),
  ],
};

const ids = (nodes: ReferenceNode[]) => nodes.map((item) => item.id);

test("the map has a column for the Tasks, each inlined level, and the level left as text", () => {
  assert.deepEqual(referenceColumnLabels(2), [
    "Tasks",
    "Embedded in a Task",
    "One hop further",
    "Too deep",
  ]);
  assert.deepEqual(referenceColumnLabels(3).slice(3), ["2 hops further", "Too deep"]);
});

test("without an agent, each node sits at its depth, unreached ones in the band, deeper ones listed", () => {
  const view = referenceMapView(data);
  assert.deepEqual(view.columns.map(ids), [
    ["task-a", "task-b"],
    ["gone", "leads", "rules"],
    ["style"],
    ["glossary"],
  ]);
  assert.deepEqual(ids(view.band), ["aside", "draft", "lonely"]);
  assert.deepEqual(ids(view.deeper), ["deep"]);
});

test("with an agent, the map shows what its run meets and its own unreached notes", () => {
  const view = referenceMapView(data, "b");
  assert.deepEqual(view.columns.map(ids), [["task-b"], ["gone", "rules"], ["style"], ["glossary"]]);
  assert.deepEqual(ids(view.band), ["draft"]);
  assert.deepEqual(ids(view.deeper), []);
  assert.equal(shownIds(view).has("task-a"), false);
});

test("nodeHop reads the agent's hop, or the depth without one", () => {
  const rules = data.nodes[2] as ReferenceNode;
  assert.equal(nodeHop(rules, "a"), 1);
  assert.equal(nodeHop(rules, "zzz"), null);
  assert.equal(nodeHop(rules), 1);
});

test("a file reaches the prompts of the agents whose runs inline it, not those that leave it as text", () => {
  assert.deepEqual(reachedAgents(data.nodes[2] as ReferenceNode, 2), ["a", "b"]);
  assert.deepEqual(reachedAgents(data.nodes[4] as ReferenceNode, 2), []);
  assert.deepEqual(reachedAgents(data.nodes[0] as ReferenceNode, 2), []);
});

test("what stands out: broken links, Tasks over budget, shared notes, notes too deep, files nothing points to", () => {
  const standouts = referenceStandouts(data, shownIds(referenceMapView(data)), new Set());
  assert.deepEqual(ids(standouts.broken), ["gone"]);
  assert.deepEqual(ids(standouts.overBudget), ["task-b"]);
  assert.deepEqual(ids(standouts.shared), ["rules", "style"]);
  assert.deepEqual(ids(standouts.tooDeep), ["glossary", "deep"]);
  assert.deepEqual(ids(standouts.unpointed), ["lonely", "draft"]);
  const read = referenceStandouts(data, shownIds(referenceMapView(data)), new Set(["lonely"]));
  assert.deepEqual(ids(read.unpointed), ["draft"]);
});

test("what stands out keeps to the nodes the map shows", () => {
  const standouts = referenceStandouts(data, shownIds(referenceMapView(data, "a")), new Set());
  assert.deepEqual(ids(standouts.broken), []);
  assert.deepEqual(ids(standouts.overBudget), []);
});

test("a Task is over budget only past the budget", () => {
  assert.equal(isOverBudget(node("t", { inlined_bytes: 100 }), 100), false);
  assert.equal(isOverBudget(node("t", { inlined_bytes: 101 }), 100), true);
  assert.equal(isOverBudget(node("t"), 100), false);
});

test("referenceLinks lists what a node embeds or names and what points at it", () => {
  const links = referenceLinks(data, "rules");
  assert.deepEqual(
    links.out.map((link) => link.id),
    ["style"],
  );
  assert.deepEqual(
    links.in.map((link) => link.id),
    ["task-a", "task-b"],
  );
  assert.equal(links.in[0]?.node?.label, "Alpha");
});

test("taskPulls lists everything a Task's runs meet, nearest first, marking what stays text", () => {
  const pulls = taskPulls(data, data.nodes[1] as ReferenceNode);
  assert.deepEqual(
    pulls.map((pull) => [pull.node.id, pull.hop, pull.inlined]),
    [
      ["gone", 1, true],
      ["rules", 1, true],
      ["style", 2, true],
      ["glossary", 3, false],
    ],
  );
});

test("selecting a node lights what it pulls in, what pulls it in, and what it names", () => {
  assert.deepEqual([...litIds(data, "style")].sort(), [
    "deep",
    "glossary",
    "rules",
    "style",
    "task-a",
    "task-b",
  ]);
  assert.deepEqual([...litIds(data, "aside")].sort(), ["aside", "task-b"]);
});

test("selection follows an embed loop without walking forever", () => {
  const loop: StudioReferences = { ...data, edges: [embed("x", "y"), embed("y", "x")] };
  assert.deepEqual([...litIds(loop, "x")].sort(), ["x", "y"]);
});

test("formatSize reads bytes and kilobytes", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(64 * 1024), "64 KB");
});

test("layoutReferences places columns across the width and the band below them", () => {
  const view = referenceMapView(data);
  const layout = layoutReferences(view, data, 1000);
  const at = (id: string) => layout.nodes.find((item) => item.node.id === id);
  assert.equal(layout.columnX.length, 4);
  assert.equal(at("task-a")?.x, 0);
  assert.ok((at("rules")?.x ?? 0) > (at("task-a")?.x ?? 0));
  assert.ok((at("lonely")?.y ?? 0) > (at("gone")?.y ?? 0) + 2 * 52);
  assert.ok(layout.bandY !== null);
  assert.equal(at("deep"), undefined);
  assert.ok(layout.links.some((link) => link.edge.from === "rules" && link.edge.to === "style"));
  assert.ok(!layout.links.some((link) => link.edge.to === "deep"));
});

test("layoutReferences keeps a minimum gap on a narrow pane and has no band when every file is reached", () => {
  const reached: StudioReferences = {
    ...data,
    nodes: data.nodes.filter((item) => item.depth !== null),
  };
  const layout = layoutReferences(referenceMapView(reached), reached, 200);
  assert.equal(layout.bandY, null);
  assert.equal(layout.columnX[1], 184 + 48);
});

test("linkPath runs side to side toward the right, and top to bottom otherwise", () => {
  const box = (x: number, y: number) => ({ node: node("n"), x, y, w: 100, h: 40 });
  assert.equal(linkPath(box(0, 0), box(200, 0)), "M100,20 C150,20 150,20 200,20");
  assert.equal(linkPath(box(0, 0), box(0, 100)), "M50,40 C50,70 50,70 50,100");
  assert.equal(linkPath(box(0, 100), box(0, 0)), "M50,100 C50,70 50,70 50,40");
});

test("referenceMeta reads a Task's budget, a file's level and size, and why a link fails", () => {
  assert.equal(referenceMeta(data.nodes[1] as ReferenceNode, data), "120 B of 100 B inlined");
  assert.equal(referenceMeta(node("n", { bytes: 2048 }), data), "guild · 2.0 KB");
  assert.equal(referenceMeta(node("t", { kind: "table" }), data), "guild · table");
  assert.equal(
    referenceMeta(node("u", { kind: "unresolved", level: null, reason: "missing" }), data),
    "missing",
  );
  assert.equal(
    referenceMeta(node("u", { kind: "unresolved", level: null }), data),
    "does not resolve",
  );
});

test("stateListLocation opens a note or a table by path, under its agent, and nothing else", () => {
  assert.deepEqual(stateListLocation(node("org/o/guilds/g/a.md")), {
    section: "state",
    tab: "list",
    item: "org/o/guilds/g/a.md",
  });
  assert.deepEqual(stateListLocation(node("org/o/agents/b/a.md", { agent_id: "b" })), {
    section: "state",
    agent: "b",
    tab: "list",
    item: "org/o/agents/b/a.md",
  });
  assert.deepEqual(
    stateListLocation(node("org/o/collections/leads", { kind: "table", collection_id: "col_1" })),
    { section: "state", tab: "list", item: "org/o/collections/leads" },
  );
  assert.equal(stateListLocation(node("gone", { kind: "unresolved" })), null);
  assert.equal(stateListLocation(node("task", { kind: "task" })), null);
});

test("standoutGroups titles each kind of standout and leaves out the empty ones", () => {
  const groups = standoutGroups(data, shownIds(referenceMapView(data)), new Set());
  assert.deepEqual(
    groups.map((group) => [group.title, group.rows.map((row) => row.meta)]),
    [
      ["Broken embeds", ["missing · in Beta", "inlines 120 B, over the 100 B budget"]],
      ["Shared by several prompts", ["inlined for 2 agents", "inlined for 2 agents"]],
      ["Too deep to be inlined", ["3 hops from a Task", "4 hops from a Task"]],
      ["Nothing points here", ["guild", "agent"]],
    ],
  );
  assert.deepEqual(standoutGroups({ ...data, nodes: [], edges: [] }, new Set(), new Set()), []);
});

test("linkLabel says what becomes of an embed, or that a path is only named", () => {
  assert.equal(linkLabel(embed("a", "b")), "embed");
  assert.equal(linkLabel(embed("a", "b", "too_deep")), "embed · stays text");
  assert.equal(
    linkLabel({ from: "a", to: "b", kind: "name", status: "named" }),
    "named, not embedded",
  );
});
