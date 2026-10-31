import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIRECT_NODE,
  MESSAGE_NODE,
  OPERATOR_NODE,
  agentActivity,
  buildActivityMap,
  buildChains,
  chainLines,
  chainMatches,
  clock,
  clockWithDay,
  clockWithSeconds,
  formatActivityDuration,
  formatUsd,
  indexActivity,
  isActivityTriggerReason,
  routineNode,
  sameSelection,
  selectionExists,
  selectionFromItem,
  selectionItem,
  operatorAuthor,
  triggerReasonLabel,
  toMs,
  wakeBucket,
  windowLabel,
  type Chain,
  type MapSelection,
} from "./activityModel";
import { MIN, T0, agent, at, byRow, pipeline, row, view, wake } from "./activityFixtures";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);

const agentsOf = (chain: Chain | undefined) =>
  chain ? chainLines(chain).map((line) => line.steps.map((item) => item.wake.agent_id)) : [];

test("windowLabel uses hours below a day and days at full-day multiples except 24h", () => {
  assert.deepEqual([1, 6, 24, 72, 168].map(windowLabel), ["1h", "6h", "24h", "3d", "7d"]);
});

test("a clock reads hours and minutes, to the second or after the day when named, and a dash when unreadable", () => {
  const at = new Date(2026, 0, 5, 9, 7, 3).getTime();
  assert.match(clock(at), /^09\D07$/);
  assert.match(clockWithSeconds(at), /^09\D07\D03$/);
  assert.ok(clockWithDay(at).endsWith(` ${clock(at)}`));
  assert.match(clockWithDay(at), /5/);
  for (const unreadable of [null, "", "not a time"]) {
    assert.deepEqual(
      [clock(unreadable), clockWithSeconds(unreadable), clockWithDay(unreadable)],
      ["—", "—", "—"],
    );
  }
});

test("toMs reads epoch numbers and ISO strings and rejects empty or unreadable values", () => {
  assert.equal(toMs(T0), T0);
  assert.equal(toMs(at(0)), T0);
  assert.equal(toMs(""), null);
  assert.equal(toMs(null), null);
  assert.equal(toMs("not a date"), null);
});

test("the index maps rows, wakes, and the wakes each public row started", () => {
  const index = indexActivity(pipeline());
  assert.equal(index.messages.get(11)?.author_agent_id, "a_intake");
  assert.equal(index.wakes.get("w_editor")?.agent_id, "a_editor");
  assert.deepEqual(index.wokenBy.get(12), ["w_editor"]);
  assert.equal(index.routines.get("sch_1")?.label, "Every hour (UTC)");
});

test("a running wake counts as running, then a post wins over a failure, and a failure over writes", () => {
  assert.equal(wakeBucket({ running: true, outcome: "posted", failed: true }), "running");
  assert.equal(wakeBucket({ running: false, outcome: "posted", failed: true }), "posted");
  assert.equal(wakeBucket({ running: false, outcome: "wrote", failed: true }), "failed");
  assert.equal(wakeBucket({ running: false, outcome: "wrote", failed: false }), "wrote");
  assert.equal(wakeBucket({ running: false, outcome: "silent", failed: false }), "silent");
});

test("a chain follows each post to the wake it started, newest chain first", () => {
  const chains = buildChains(pipeline());
  assert.deepEqual(
    chains.map((chain) => [chain.start.kind, chain.source, chain.id]),
    [
      ["direct", DIRECT_NODE, "w_direct"],
      ["routine", routineNode("sch_1"), "w_routine"],
      ["operator", OPERATOR_NODE, "w_intake"],
    ],
  );
  const pipelineChain = chains[2];
  assert.deepEqual(agentsOf(pipelineChain), [["a_intake", "a_writer", "a_editor"]]);
  const [intake] = pipelineChain?.steps ?? [];
  assert.equal(intake?.from, OPERATOR_NODE);
  assert.equal(intake?.post, null);
  assert.equal(intake?.next[0]?.from, "a_intake");
  assert.equal(intake?.next[0]?.post?.seq, 11);
  assert.equal(pipelineChain?.wakes, 3);
  close(pipelineChain?.cost ?? Number.NaN, 0.08);
  assert.equal(pipelineChain?.end, toMs(at(12)));
  assert.equal(pipelineChain?.quiet, false);
  assert.equal(chains[1]?.start.kind === "routine" && chains[1].start.scheduleId, "sch_1");
});

test("a message that woke two agents is one chain, and a post that woke two starts a branch", () => {
  const data = view({
    agents: [agent("a_scout"), agent("a_desk"), agent("a_risk")],
    messages: [row(1, 1, null), row(2, 3, "a_scout", "w_scout")],
    wakes: [
      wake("w_scout", "a_scout", [1, 3], {
        trigger: byRow(1),
        outcome: "posted",
        posts: [{ seq: 2, call_id: null, at: at(3) }],
      }),
      wake("w_desk_1", "a_desk", [1, 2], { trigger: byRow(1) }),
      wake("w_desk_2", "a_desk", [4, 5], { trigger: byRow(2) }),
      wake("w_risk", "a_risk", [4, 6], { trigger: byRow(2) }),
    ],
  });
  const [chain] = buildChains(data);
  assert.equal(buildChains(data).length, 1);
  const lines = chain ? chainLines(chain) : [];
  assert.deepEqual(
    lines.map((line) => [
      line.lead,
      line.from?.wake.run_id ?? null,
      line.steps.map((item) => item.wake.run_id),
    ]),
    [
      ["start", null, ["w_scout", "w_desk_2"]],
      ["sibling", null, ["w_desk_1"]],
      ["branch", "w_scout", ["w_risk"]],
    ],
  );
});

test("an agent's post from before the window starts a chain from that agent", () => {
  const data = view({
    agents: [agent("a_scout"), agent("a_desk")],
    messages: [row(1, -30, "a_scout", "w_gone"), row(2, 5, "a_ghost", "w_ghost")],
    wakes: [
      wake("w_desk", "a_desk", [1, 2], { trigger: byRow(1) }),
      wake("w_late", "a_desk", [6, 7], { trigger: byRow(2) }),
    ],
  });
  const chains = buildChains(data);
  assert.deepEqual(
    chains.map((chain) => [chain.start.kind, chain.source]),
    [
      ["unknown", MESSAGE_NODE],
      ["earlier", "a_scout"],
    ],
  );
  assert.equal(chains[1]?.quiet, true);
});

test("a selection names a link or a node, round-trips through the URL, and picks the chains that pass through it", () => {
  const chains = buildChains(pipeline());
  const link: MapSelection = { kind: "link", from: "a_intake", to: "a_writer" };
  const routine: MapSelection = { kind: "node", id: routineNode("sch_1") };
  for (const selection of [link, routine]) {
    assert.deepEqual(selectionFromItem(selectionItem(selection)), selection);
  }
  assert.equal(selectionItem(link), "link:a_intake>a_writer");
  assert.equal(selectionFromItem("link:broken"), null);
  assert.equal(selectionFromItem("run_1"), null);
  assert.ok(sameSelection(link, { kind: "link", from: "a_intake", to: "a_writer" }));
  assert.ok(!sameSelection(link, null));
  assert.deepEqual(
    chains.filter((chain) => chainMatches(chain, link)).map((chain) => chain.id),
    ["w_intake"],
  );
  assert.deepEqual(
    chains.filter((chain) => chainMatches(chain, routine)).map((chain) => chain.id),
    ["w_routine"],
  );
  assert.deepEqual(
    chains
      .filter((chain) => chainMatches(chain, { kind: "node", id: "a_writer" }))
      .map((chain) => chain.id),
    ["w_direct", "w_intake"],
  );
  assert.equal(chains.filter((chain) => chainMatches(chain, null)).length, 3);
});

test("the map lists every routine of its agents, the sources that started chains, and who woke whom", () => {
  const data = pipeline();
  const map = buildActivityMap(data, buildChains(data));
  assert.deepEqual(
    map.agents.map((node) => [node.id, node.count]),
    [
      ["a_editor", 2],
      ["a_writer", 2],
      ["a_intake", 1],
    ],
  );
  assert.deepEqual(map.agents[0]?.counts, {
    posted: 0,
    wrote: 1,
    silent: 0,
    failed: 1,
    running: 0,
  });
  assert.deepEqual(
    map.sources.map((node) => [node.id, node.kind, node.count, node.agentId]),
    [
      [routineNode("sch_1"), "routine", 1, "a_editor"],
      [routineNode("sch_2"), "routine", 0, "a_writer"],
      [DIRECT_NODE, "direct", 1, null],
      [OPERATOR_NODE, "operator", 1, null],
    ],
  );
  assert.ok(selectionExists(map, { kind: "link", from: "a_intake", to: "a_writer" }));
  assert.ok(selectionExists(map, { kind: "node", id: routineNode("sch_2") }));
  assert.ok(!selectionExists(map, { kind: "link", from: "a_writer", to: "a_intake" }));
  assert.deepEqual(map.links.map((link) => [link.from, link.to, link.count]).sort(), [
    ["a_intake", "a_writer", 1],
    ["a_writer", "a_editor", 1],
    ["direct", "a_writer", 1],
    ["operator", "a_intake", 1],
    ["routine:sch_1", "a_editor", 1],
  ]);
});

test("each agent's inputs name what woke it, idle routines included, and its outputs add up what it did", () => {
  const data = pipeline();
  const chains = buildChains(data);
  const activity = agentActivity(data, chains, buildActivityMap(data, chains));
  const writer = activity.find((item) => item.agent.id === "a_writer");
  assert.deepEqual(
    writer?.inputs.map((input) => [input.id, input.kind, input.count, input.reasons]),
    [
      [routineNode("sch_2"), "routine", 0, {}],
      ["a_intake", "agent", 1, { jev: 1 }],
      [DIRECT_NODE, "direct", 1, {}],
    ],
  );
  assert.equal(writer?.outputs.wakes, 2);
  assert.equal(writer?.outputs.posts, 1);
  assert.deepEqual(writer?.outputs.woke, [{ value: "a_editor", count: 1 }]);
  const editor = activity.find((item) => item.agent.id === "a_editor");
  assert.deepEqual(editor?.outputs.records, [{ value: "projects", count: 1 }]);
  assert.deepEqual(editor?.outputs.recordOperations, { update: 1 });
  assert.deepEqual(editor?.outputs.errors, [{ value: "Out of budget.", count: 1 }]);
});

test("durations and costs read compactly", () => {
  assert.equal(formatActivityDuration(0), "0s");
  assert.equal(formatActivityDuration(53_000), "53s");
  assert.equal(formatActivityDuration(59_600), "1m");
  assert.equal(formatActivityDuration(85_000), "1m25s");
  assert.equal(formatActivityDuration(3_600_000), "1h00m");
  assert.equal(formatActivityDuration(2 * 3_600_000 + 4 * MIN), "2h04m");
  assert.equal(formatActivityDuration(-1), "—");
  assert.equal(formatActivityDuration(Number.NaN), "—");
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(null), "$0");
  assert.equal(formatUsd(Number.NaN), "$0");
  assert.equal(formatUsd(0.0004), "<$0.001");
  assert.equal(formatUsd(0.0213), "$0.021");
  assert.equal(formatUsd(1), "$1.00");
  assert.equal(formatUsd(3.456), "$3.46");
});

test("a stored waking row reads as fact, and one found from tags says it was inferred", () => {
  assert.equal(triggerReasonLabel(byRow(4)), "tagged");
  assert.equal(
    triggerReasonLabel({
      type: "message",
      seq: 4,
      through_seq: 4,
      reason: "jev",
      routing: null,
      inferred: true,
    }),
    "routed, inferred",
  );
  assert.equal(triggerReasonLabel({ type: "routine", schedule_id: null }), null);
});

test("an operator row is the viewer's own, or names the person who posted it", () => {
  assert.equal(operatorAuthor(row(1, 0, null), "user_operator"), "your");
  assert.equal(operatorAuthor({ ...row(1, 0, null), author_name: "sam" }, "user_other"), "sam's");
  assert.equal(operatorAuthor({ ...row(1, 0, null), author_user_id: null }, "user_other"), "your");
});

test("a reason key names why a message woke an agent only when it is one of the ledger's reasons", () => {
  assert.equal(isActivityTriggerReason("jev"), true);
  assert.equal(isActivityTriggerReason("fallback"), true);
  assert.equal(isActivityTriggerReason("routine"), false);
});
