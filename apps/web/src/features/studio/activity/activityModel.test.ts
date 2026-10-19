import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIRECT_NODE,
  MESSAGE_NODE,
  OPERATOR_NODE,
  agentActivity,
  agentColumns,
  buildActivityMap,
  buildChains,
  chainLines,
  chainMatches,
  formatActivityDuration,
  formatUsd,
  groupWrites,
  indexActivity,
  layoutActivityMap,
  recordIdFromPath,
  routineNode,
  sameSelection,
  selectionExists,
  selectionFromItem,
  selectionItem,
  operatorAuthor,
  triggerReasonLabel,
  toMs,
  wakeBucket,
  wakeEffects,
  windowLabel,
  type Chain,
  type MapSelection,
} from "./activityModel";
import type {
  ActivityAgent,
  ActivityMessage,
  ActivityToolCall,
  ActivityTrigger,
  ActivityView,
  ActivityWake,
  ActivityWrite,
} from "../../../api/types";

const MIN = 60_000;
const T0 = Date.parse("2026-09-26T09:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

function agent(id: string): ActivityAgent {
  return { id, name: id.slice(2), avatar_color: "#888888", avatar_shape: "" };
}

/** A public row; a null author is the operator. */
function row(
  seq: number,
  minutes: number,
  author: string | null,
  sourceRun: string | null = null,
): ActivityMessage {
  return {
    seq,
    created_at: at(minutes),
    author_type: author === null ? "user" : "agent",
    author_name: author ?? "operator",
    author_agent_id: author,
    author_user_id: author === null ? "user_operator" : null,
    source_run_id: sourceRun,
    tagged: [],
    preview: `row ${seq}`,
    length: 5,
  };
}

function byRow(seq: number | null, reason: "tag" | "jev" = "tag"): ActivityTrigger {
  return { type: "message", seq, through_seq: seq, reason, routing: null, inferred: false };
}

function wake(
  runId: string,
  agentId: string,
  [start, end]: [number, number],
  overrides: Partial<ActivityWake> = {},
): ActivityWake {
  return {
    run_id: runId,
    agent_id: agentId,
    kind: "group",
    started_at: at(start),
    ended_at: at(end),
    running: false,
    trigger: { type: "direct", user_id: "user_operator" },
    outcome: "silent",
    failed: false,
    errors: [],
    posts: [],
    writes: [],
    tool_calls: [],
    tool_call_count: 0,
    reply: null,
    opening: null,
    last_seq: null,
    cost_usd: 0,
    ...overrides,
  };
}

function write(kind: ActivityWrite["kind"], target: string, path: string, operation: string) {
  return {
    kind,
    target,
    display_path: path,
    operation,
    tool_name: null,
    call_id: null,
    at: at(5),
  } satisfies ActivityWrite;
}

function call(name: string, args = "{}", error: string | null = null): ActivityToolCall {
  return { call_id: `c_${name}`, name, arguments: args, error, duration_ms: 10, at: at(5) };
}

function view(overrides: Partial<ActivityView> = {}): ActivityView {
  return {
    guild_id: "g_1",
    since: at(0),
    until: at(60),
    agents: [],
    routines: [],
    messages: [],
    wakes: [],
    ...overrides,
  };
}

/**
 * The operator's row #10 wakes intake, whose #11 wakes writer, whose #12 wakes editor (which fails).
 * A routine wakes editor later, and the operator chats with writer directly. Writer has a routine
 * that did not fire.
 */
function pipeline(): ActivityView {
  return view({
    agents: [agent("a_editor"), agent("a_writer"), agent("a_intake")],
    routines: [
      {
        id: "sch_1",
        agent_id: "a_editor",
        description: "Hourly review",
        label: "Every hour (UTC)",
        instruction: "Review.",
      },
      {
        id: "sch_2",
        agent_id: "a_writer",
        description: "Daily draft",
        label: "Every day at 09:00 (UTC)",
        instruction: "Draft.",
      },
    ],
    messages: [
      row(10, 1, null),
      row(11, 3, "a_intake", "w_intake"),
      row(12, 8, "a_writer", "w_writer"),
    ],
    wakes: [
      wake("w_intake", "a_intake", [1.5, 4], {
        trigger: byRow(10),
        outcome: "posted",
        posts: [{ seq: 11, call_id: "c_11", at: at(3) }],
        cost_usd: 0.02,
      }),
      wake("w_writer", "a_writer", [4.5, 9], {
        trigger: byRow(11, "jev"),
        outcome: "posted",
        posts: [{ seq: 12, call_id: "c_12", at: at(8) }],
        cost_usd: 0.05,
      }),
      wake("w_editor", "a_editor", [9, 12], {
        trigger: byRow(12),
        failed: true,
        errors: [{ operation: "generation", message: "Out of budget.", at: at(12) }],
        cost_usd: 0.01,
      }),
      wake("w_routine", "a_editor", [40, 41], {
        kind: "schedule",
        trigger: { type: "routine", schedule_id: "sch_1" },
        outcome: "wrote",
        writes: [write("record", "projects", "org/o/collections/projects/7", "update")],
      }),
      wake("w_direct", "a_writer", [50, 55], { kind: "direct", running: true, cost_usd: 0.03 }),
    ],
  });
}

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);

const agentsOf = (chain: Chain | undefined) =>
  chain ? chainLines(chain).map((line) => line.steps.map((item) => item.wake.agent_id)) : [];

test("windowLabel uses hours below a day and days at full-day multiples except 24h", () => {
  assert.deepEqual([1, 6, 24, 72, 168].map(windowLabel), ["1h", "6h", "24h", "3d", "7d"]);
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

test("a wake's effects split tool calls from posts, writes, script runs and issue reports", () => {
  const effects = wakeEffects(
    wake("w_1", "a_wallet", [0, 1], {
      tool_calls: [
        call("wallet_get_balance", '{"chain":"base"}', "wallet credentials are missing"),
        call("coingecko_prices"),
        call("script_run", '{"name":"rh-balance"}'),
        call("script_run", '{"name":"rh-balance"}'),
        call("report_issue", '{"kind":"api","detail":"Keys are missing"}'),
        call("group_post", '{"content":"hi"}'),
        call("memory_write"),
      ],
      writes: [
        write("note", "valuation.md", "org/o/notes/valuation.md", "update"),
        write("memory", "memory.md", "org/o/agents/a/memory.md", "update"),
        write("script", "calc", "org/o/agents/a/scripts/calc", "create"),
      ],
    }),
  );
  assert.deepEqual(
    effects.calls.map((item) => item.name),
    ["wallet_get_balance", "coingecko_prices"],
  );
  assert.deepEqual(effects.scriptRuns, [{ value: "rh-balance", count: 2 }]);
  assert.deepEqual(effects.issues, ["Keys are missing"]);
  assert.deepEqual(
    effects.failedCalls.map((item) => item.error),
    ["wallet credentials are missing"],
  );
  assert.deepEqual(
    [
      effects.records.length,
      effects.notes.map((group) => group.target),
      effects.scripts.map((group) => group.target),
    ],
    [0, ["valuation.md"], ["calc"]],
  );
  assert.equal(effects.memory, true);
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

test("writes group by what they touched, with record ids and the first write", () => {
  const writes = [
    write("record", "projects", "org/o/collections/projects/7", "update"),
    write("record", "projects", "org/o/collections/projects/8", "create"),
    write("memory", "memory.md", "org/o/agents/a/memory.md", "update"),
    write("record", "projects", "org/o/collections/projects/7", "update"),
    write("note", "42", "org/o/notes/42", "create"),
  ];
  assert.deepEqual(groupWrites(writes), [
    {
      kind: "record",
      target: "projects",
      count: 3,
      operations: { update: 2, create: 1 },
      ids: ["7", "8"],
      first: writes[0],
    },
    {
      kind: "memory",
      target: "memory.md",
      count: 1,
      operations: { update: 1 },
      ids: [],
      first: writes[2],
    },
    { kind: "note", target: "42", count: 1, operations: { create: 1 }, ids: [], first: writes[4] },
  ]);
  assert.deepEqual(groupWrites(null), []);
});

test("a record id is the numeric last part of a display path", () => {
  assert.equal(recordIdFromPath("org/o/collections/projects/42"), "42");
  assert.equal(recordIdFromPath("org/o/notes/plan.md"), null);
  assert.equal(recordIdFromPath("org/o/collections/projects/42/"), null);
  assert.equal(recordIdFromPath(""), null);
  assert.equal(recordIdFromPath(null), null);
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
