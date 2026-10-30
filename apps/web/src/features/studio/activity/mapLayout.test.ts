import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATOR_NODE, buildActivityMap, buildChains } from "./activityModel";
import { pipeline } from "./activityFixtures";
import { agentColumns, layoutActivityMap } from "./mapLayout";

test("agents sit one column past the agent that wakes them most", () => {
  const data = pipeline();
  const map = buildActivityMap(data, buildChains(data));
  assert.deepEqual(Object.fromEntries(agentColumns(map)), {
    a_editor: 1,
    a_writer: 1,
    a_intake: 1,
  });
  const piped = {
    ...map,
    links: [
      {
        id: "routine:x>a_wallet",
        from: "routine:x",
        to: "a_wallet",
        count: 50,
        counts: map.agents[0]!.counts,
        cost: 0,
      },
      {
        id: "a_wallet>a_desk",
        from: "a_wallet",
        to: "a_desk",
        count: 54,
        counts: map.agents[0]!.counts,
        cost: 0,
      },
      {
        id: "operator>a_desk",
        from: "operator",
        to: "a_desk",
        count: 1,
        counts: map.agents[0]!.counts,
        cost: 0,
      },
      {
        id: "a_desk>a_wallet",
        from: "a_desk",
        to: "a_wallet",
        count: 13,
        counts: map.agents[0]!.counts,
        cost: 0,
      },
    ],
    agents: ["a_wallet", "a_desk", "a_idle"].map((id) => ({ ...map.agents[0]!, id, agentId: id })),
  };
  assert.deepEqual(Object.fromEntries(agentColumns(piped)), { a_wallet: 1, a_desk: 2, a_idle: 1 });
});

test("the map layout runs links left to right, loops links back under the boxes, and widens busier links", () => {
  const map = {
    sources: [
      {
        id: "routine:x",
        kind: "routine" as const,
        count: 50,
        counts: { posted: 0, wrote: 0, silent: 0, failed: 0, running: 0 },
        agentId: "a_wallet",
      },
      {
        id: OPERATOR_NODE,
        kind: "operator" as const,
        count: 1,
        counts: { posted: 0, wrote: 0, silent: 0, failed: 0, running: 0 },
        agentId: null,
      },
    ],
    agents: ["a_wallet", "a_desk"].map((id) => ({
      id,
      kind: "agent" as const,
      count: 10,
      counts: { posted: 10, wrote: 0, silent: 0, failed: 0, running: 0 },
      agentId: id,
    })),
    links: [
      ["routine:x", "a_wallet", 50],
      ["a_wallet", "a_desk", 54],
      [OPERATOR_NODE, "a_desk", 1],
      ["a_desk", "a_wallet", 13],
    ].map(([from, to, count]) => ({
      id: `${from}>${to}`,
      from: String(from),
      to: String(to),
      count: Number(count),
      counts: { posted: Number(count), wrote: 0, silent: 0, failed: 0, running: 0 },
      cost: 0,
    })),
  };
  const layout = layoutActivityMap(map, { width: 800 });
  const node = (id: string) => layout.nodes.find((item) => item.id === id);
  const link = (id: string) => layout.links.find((item) => item.id === id);
  assert.equal(node("routine:x")?.x, 0);
  assert.ok((node("a_desk")?.x ?? 0) > (node("a_wallet")?.x ?? 0));
  assert.ok(
    (node("routine:x")?.y ?? 0) < (node(OPERATOR_NODE)?.y ?? 0),
    "each source sits beside the agent it wakes most",
  );
  assert.equal(link("a_wallet>a_desk")?.loop, false);
  assert.equal(link("a_wallet>a_desk")?.fromAgent, true);
  assert.equal(link("routine:x>a_wallet")?.fromAgent, false);
  assert.equal(link("a_desk>a_wallet")?.loop, true);
  assert.ok(
    (link("a_desk>a_wallet")?.label.y ?? 0) >
      Math.max(...layout.nodes.map((item) => item.y + item.h)),
  );
  assert.equal(link("a_wallet>a_desk")?.width, 9);
  assert.ok((link(`${OPERATOR_NODE}>a_desk`)?.width ?? 0) < 2);
  assert.ok(layout.height > Math.max(...layout.links.map((item) => item.label.y)));
  assert.ok(layout.width >= 800 - 8);
});
