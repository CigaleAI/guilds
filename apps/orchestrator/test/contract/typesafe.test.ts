import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GroupMessageRow } from "../../src/db/group-chat.js";
import { groupMessageRow } from "../helpers/group-chat.js";
import { createTypeSafeClient } from "../../src/typesafe/client.js";
import { RECIPIENT_CONFIDENCE_MIN, createGroupRouter } from "../../src/typesafe/group.js";

// Live Jev contract for recipient Choice and history Noul. The desk is
// inline so a change to the wording is judged on many message shapes,
// never on one guild's Task files. Gated: the wording pin in
// test/unit/typesafe.test.ts stays the source of truth until this suite
// is run on the full case set.
const gated =
  (process.env.RUN_MODEL_CONTRACT !== "1" && process.env.RUN_TYPESAFE_CONTRACT !== "1") ||
  !process.env.TYPESAFE_API_KEY
    ? "set RUN_TYPESAFE_CONTRACT=1 and TYPESAFE_API_KEY to run the live Jev contract"
    : false;

const DESK = [
  {
    id: "a_scout",
    name: "scout",
    focus: "finds new names",
    task: "Hunt new metas and projects. Report leads. Do not research or trade.",
  },
  {
    id: "a_researcher",
    name: "researcher",
    focus: "deep-dives named projects",
    task: "Research projects the scout or manager names. Do not hunt or trade.",
  },
  {
    id: "a_manager",
    name: "manager",
    focus: "portfolio calls",
    task: "Decide buy, sell, watch, or hold. Do not hunt, research, or sign.",
  },
  {
    id: "a_wallet",
    name: "wallet",
    focus: "onchain lookups and signing",
    task: "Look up chain state and sign explicit orders. Do not decide what to buy.",
  },
];

function userRow(seq: number, content: string): GroupMessageRow {
  return groupMessageRow(seq, { content });
}

function agentRow(seq: number, name: string, content: string): GroupMessageRow {
  return groupMessageRow(seq, { author_type: "agent", author_name: name, author_agent_id: `a_${name}`, content });
}

function chatterRows(count: number, startSeq = 1): GroupMessageRow[] {
  const phrases = ["gm", "lol", "solid day", "ty", "brb", "nice", "ok", "sure", "cool", "yep", "gm again"];
  return Array.from({ length: count }, (_, index) =>
    userRow(startSeq + index, phrases[index % phrases.length] ?? "gm"),
  );
}

function router() {
  return createGroupRouter({ client: createTypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY ?? "" }) });
}

async function routeRows(rows: Array<Record<string, unknown>>) {
  return router().recipients({
    rows,
    members: DESK,
    pending: DESK,
    taggedNames: new Set(),
    ruleNames: new Set(DESK.map((member) => member.name)),
  });
}

async function route(content: string) {
  return routeRows([userRow(1, content)]);
}

function assertRouted(decision: Awaited<ReturnType<typeof route>>, expected: string[], content: string) {
  assert.equal(decision.model?.startsWith("jev-"), true, "model id is reported");
  const confidence = decision.confidence ?? 0;
  const line = `${decision.source.padEnd(14)} ${String(decision.choice).padEnd(15)} ${confidence.toFixed(2)}  ${content.slice(0, 70)}`;
  process.stdout.write(`${line}\n`);
  if (!expected.length) {
    assert.equal(decision.choice, "none", `expected none: ${line}`);
    assert.ok(confidence >= RECIPIENT_CONFIDENCE_MIN, `expected confident none: ${line}`);
    return;
  }
  const confidentPick =
    decision.source === "typesafe" && expected.includes(String(decision.choice));
  assert.ok(
    confidentPick || decision.source === "low_confidence",
    `expected ${expected.join("|")} or low_confidence: ${line}`,
  );
}

function assertOutranks(
  decision: Awaited<ReturnType<ReturnType<typeof router>["history"]>>,
  highSeq: number,
  lowSeqs: number[],
) {
  assert.equal(decision.source, "typesafe");
  assert.equal(decision.model?.startsWith("jev-"), true, "model id is reported");
  const keep = decision.keep ?? {};
  const high = keep[String(highSeq)];
  const low = Math.max(...lowSeqs.map((seq) => keep[String(seq)] ?? 0));
  process.stdout.write(`keep ${highSeq}=${high?.toFixed(2) ?? "—"} chatter=${low.toFixed(2)}\n`);
  assert.ok(high !== undefined && high > low, `seq ${highSeq} should outrank chatter`);
  assert.ok(
    decision.rows.some((row) => Number(row.seq) === highSeq),
    `seq ${highSeq} is in the kept rows`,
  );
}

describe("jev recipient routing", { concurrency: 1, skip: gated }, () => {
  test("praise plus a manager request wakes the manager", async () => {
    const content =
      "good job so far, one good try with $JEANPHIL we didn't pay too much for the test and exited in time. manager make sure to include in retrospect";
    assertRouted(await route(content), ["manager"], content);
  });

  test("a wallet ops ask wakes the wallet", async () => {
    const content =
      "we got sandwiched on that last fill, not the end of the world. wallet check the slippage setting before the next one";
    assertRouted(await route(content), ["wallet"], content);
  });

  test("a scout watch ask wakes the scout", async () => {
    const content = "board was fire today. scout keep an eye on the base ai-agent names this week";
    assertRouted(await route(content), ["scout"], content);
  });

  test("a research follow-up wakes the researcher", async () => {
    const content = "solid packet on $JEANPHIL. researcher can you also cover the team wallets";
    assertRouted(await route(content), ["researcher", "wallet"], content);
  });

  test("a portfolio question wakes the manager", async () => {
    const content = "are we still risk-on after today?";
    assertRouted(await route(content), ["manager"], content);
  });

  test("a sell order wakes the manager or the wallet", async () => {
    const content = "sell half the JEANPHIL bag at market";
    assertRouted(await route(content), ["manager", "wallet"], content);
  });

  test("a new-names question wakes the scout", async () => {
    const content = "anyone seen new metas popping on base today?";
    assertRouted(await route(content), ["scout"], content);
  });

  test("a balance lookup wakes the wallet", async () => {
    const content = "wallet what's the spendable sol balance right now";
    assertRouted(await route(content), ["wallet"], content);
  });

  test("a greeting does not wake anyone", async () => {
    assertRouted(await route("gm"), [], "gm");
  });

  test("thanks without a request does not wake anyone", async () => {
    const content = "ty scout, that board was exactly what i needed";
    assertRouted(await route(content), [], content);
  });

  test("status with no ask does not wake anyone", async () => {
    const content = "SCOUT BOARD posted. 3 new names, none promoted. No action needed.";
    assertRouted(await route(content), [], content);
  });

  test("an offline note does not wake anyone", async () => {
    const content = "fyi i'll be offline tomorrow, no changes needed";
    assertRouted(await route(content), [], content);
  });

  test("praise alone does not wake anyone", async () => {
    const content = "nice work everyone, solid day";
    assertRouted(await route(content), [], content);
  });

  test("a referring follow-up after a research packet wakes the researcher", async () => {
    const content = "can you unpack that last point";
    assertRouted(
      await routeRows([
        agentRow(
          1,
          "researcher",
          "RESEARCH PACKET — JEANPHIL. Holdability: thin bids under 40k. Team wallets clustered. Decision needed: watch or pass.",
        ),
        userRow(2, content),
      ]),
      ["researcher"],
      content,
    );
  });

  test("a referring follow-up after a fill wakes the wallet", async () => {
    const content = "why that size";
    assertRouted(
      await routeRows([
        agentRow(1, "wallet", "filled JEANPHIL buy 2 SOL at market"),
        userRow(2, content),
      ]),
      ["wallet"],
      content,
    );
  });

  test("thanks after a packet still does not wake anyone", async () => {
    const content = "ty, that's enough for now";
    assertRouted(
      await routeRows([
        agentRow(
          1,
          "researcher",
          "RESEARCH PACKET — JEANPHIL. Holdability: thin bids under 40k. Team wallets clustered. Decision needed: watch or pass.",
        ),
        userRow(2, content),
      ]),
      [],
      content,
    );
  });

  test("a new-names ask after a packet still wakes the scout", async () => {
    const content = "anyone seen new metas popping on base today?";
    assertRouted(
      await routeRows([
        agentRow(
          1,
          "researcher",
          "RESEARCH PACKET — JEANPHIL. Holdability: thin bids under 40k. Team wallets clustered. Decision needed: watch or pass.",
        ),
        userRow(2, content),
      ]),
      ["scout"],
      content,
    );
  });
});

describe("jev history filtering", { concurrency: 1, skip: gated }, () => {
  test("keeps a wallet order above chatter when the latest asks about the fill", async () => {
    const chatter = chatterRows(11);
    const orderSeq = 12;
    const rows = [
      ...chatter,
      userRow(
        orderSeq,
        "wallet order: JEANPHIL · solana · side: buy · size: 2 SOL · limit: market · kill: -30% from fill",
      ),
      userRow(13, "did that fill go through?"),
    ];
    const decision = await router().history({
      rows,
      agentName: "wallet",
      agentFocus: "onchain lookups and signing",
    });
    assertOutranks(
      decision,
      orderSeq,
      chatter.slice(0, 5).map((row) => Number(row.seq)),
    );
  });

  test("keeps a hunt ask above chatter for the scout", async () => {
    const chatter = chatterRows(11);
    const huntSeq = 12;
    const rows = [
      ...chatter,
      userRow(huntSeq, "scout hunt new metas and mints on sol launchpads this hour"),
      userRow(13, "anyone seen something loud in the last hour?"),
    ];
    const decision = await router().history({
      rows,
      agentName: "scout",
      agentFocus: "finds new names",
    });
    assertOutranks(
      decision,
      huntSeq,
      chatter.slice(0, 5).map((row) => Number(row.seq)),
    );
  });

  test("keeps a research packet above chatter when the latest asks about that name", async () => {
    const chatter = chatterRows(11);
    const packetSeq = 12;
    const rows = [
      ...chatter,
      agentRow(
        packetSeq,
        "researcher",
        "RESEARCH PACKET — JEANPHIL. Holdability: thin bids under 40k. Team wallets clustered. Decision needed: watch or pass.",
      ),
      userRow(13, "what's the holdability on JEANPHIL?"),
    ];
    const decision = await router().history({
      rows,
      agentName: "researcher",
      agentFocus: "deep-dives named projects",
    });
    assertOutranks(
      decision,
      packetSeq,
      chatter.slice(0, 5).map((row) => Number(row.seq)),
    );
  });

  test("keeps a venue fact the wallet still needs above chatter", async () => {
    const chatter = chatterRows(11);
    const factSeq = 12;
    const rows = [
      ...chatter,
      userRow(factSeq, "JEANPHIL contract is on solana. Last fill used 2% slippage."),
      userRow(13, "wallet send the next JEANPHIL buy, same size as last time"),
    ];
    const decision = await router().history({
      rows,
      agentName: "wallet",
      agentFocus: "onchain lookups and signing",
    });
    assertOutranks(
      decision,
      factSeq,
      chatter.slice(0, 5).map((row) => Number(row.seq)),
    );
  });

  test("keeps the hunt ask above an unrelated fill when the scout is acting", async () => {
    const chatter = chatterRows(10);
    const fillSeq = 11;
    const huntSeq = 12;
    const rows = [
      ...chatter,
      agentRow(fillSeq, "wallet", "filled JEANPHIL buy 2 SOL at market"),
      userRow(huntSeq, "scout dump whatever is trending on sol launchpads this hour"),
      userRow(13, "scout what new names did you hear"),
    ];
    const decision = await router().history({
      rows,
      agentName: "scout",
      agentFocus: "finds new names",
    });
    assertOutranks(decision, huntSeq, [fillSeq, ...chatter.slice(0, 3).map((row) => Number(row.seq))]);
  });
});
