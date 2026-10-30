import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_HISTORY_LIMIT } from "../../src/groupchat/history.js";
import type { GroupMessageRow } from "../../src/db/group-chat.js";
import { groupMessageRow } from "../helpers/group-chat.js";
import { mockFetch } from "../helpers/http.js";
import {
  TYPESAFE_MAX_RETRIES,
  TypeSafeError,
  backoffMs,
  createTypeSafeClient,
  evaluateSystemOne,
  retryAfterMs,
  type TypeSafeQuestion,
} from "../../src/typesafe/client.js";
import {
  AGENT_TASK_PREVIEW_CHARS,
  HISTORY_CONTENT_MAX_CHARS,
  LATEST_CONTENT_MAX_CHARS,
  RECIPIENT_WINDOW,
  classifyGroupRecipients,
  createGroupRouter,
  selectGroupHistory,
  serializeHistoryDecision,
} from "../../src/typesafe/group.js";
import { formatRecipientReplay, replayRecipients } from "../../src/typesafe/replay.js";
import { serializeRecipientDecision } from "../../src/groupchat/router.js";
import { setInstanceKeys } from "../../src/instance/integrations.js";
import { storeKeys } from "../helpers/env.js";

function noulAnswers(values: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(values).map(([id, noul]) => [id, { type: "noul" as const, noul }]),
  );
}

function choiceResult(choice: string, confidence = 0.9, extra: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      recipient: {
        type: "choice" as const,
        choice,
        probabilities: { [choice]: confidence, none: 1 - confidence },
        confidence,
      },
    },
    ...extra,
  };
}

function chatRow(
  seq: number,
  content: string,
  options: { tagged?: string[]; author?: string } = {},
): GroupMessageRow {
  const author = options.author;
  return groupMessageRow(seq, {
    author_type: author ? "agent" : "user",
    author_name: author ?? "user",
    author_agent_id: author ? `a_${author}` : null,
    content,
    tagged_names: options.tagged ?? [],
  });
}

const noSleep = { sleep: async () => undefined };

test("evaluateSystemOne posts state and questions", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown>; init: RequestInit | undefined }> =
    [];
  const result = await evaluateSystemOne(
    {
      state: { message: "hello" },
      questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
    },
    {
      apiKey: "ts-secret-key",
      fetch: mockFetch((url, init) => {
        seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, init });
        return {
          status: 200,
          json: {
            model: "jev-1.13.0",
            answers: { urgent: { type: "noul", noul: 0.91 } },
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        };
      }),
    },
  );
  assert.equal(seen[0]?.url, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(seen[0]?.body.state, { message: "hello" });
  assert.equal(seen[0]?.body.model, "jev-latest");
  assert.ok(seen[0]?.init?.signal instanceof AbortSignal, "timeout signal is attached");
  assert.equal(result.model, "jev-1.13.0");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 0 });
  assert.equal(result.answers.urgent?.type, "noul");
  if (result.answers.urgent?.type === "noul") {
    assert.equal(result.answers.urgent.noul, 0.91);
  }
});

test("evaluateSystemOne treats HTTP errors as TypeSafeError and redacts the key", async () => {
  await assert.rejects(
    () =>
      evaluateSystemOne(
        {
          state: "x",
          questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
        },
        {
          apiKey: "ts-secret-key",
          fetch: mockFetch(() => ({ status: 422, json: { message: "bad ts-secret-key" } })),
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof TypeSafeError);
      assert.equal(error.status, 422);
      assert.equal(error.attempts, 1);
      assert.equal(error.message, "bad [REDACTED:API_KEY]");
      return true;
    },
  );
});

test("evaluateSystemOne retries 529 with backoff then succeeds", async () => {
  let calls = 0;
  const slept: number[] = [];
  const result = await evaluateSystemOne(
    {
      state: "x",
      questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
    },
    {
      apiKey: "ts-test-key-0123",
      retry: { sleep: async (ms) => void slept.push(ms) },
      fetch: mockFetch(() => {
        calls += 1;
        if (calls < 3) {
          return { status: 529, json: { message: "overloaded" } };
        }
        return {
          status: 200,
          json: { model: "jev-1.13.0", answers: noulAnswers({ urgent: 0.5 }) },
        };
      }),
    },
  );
  assert.equal(calls, 3);
  assert.equal(slept.length, 2);
  // 500ms and 1000ms base, ±25% jitter.
  assert.ok(slept[0]! >= 375 && slept[0]! <= 625, `first backoff ${slept[0]}`);
  assert.ok(slept[1]! >= 750 && slept[1]! <= 1250, `second backoff ${slept[1]}`);
  assert.equal(result.answers.urgent?.type, "noul");
});

test("evaluateSystemOne gives up after the retry budget and reports attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      evaluateSystemOne(
        {
          state: "x",
          questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
        },
        {
          apiKey: "ts-test-key-0123",
          retry: noSleep,
          fetch: mockFetch(() => {
            calls += 1;
            return { status: 429, json: { message: "slow down" } };
          }),
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof TypeSafeError);
      assert.equal(error.status, 429);
      assert.equal(error.attempts, TYPESAFE_MAX_RETRIES + 1);
      return true;
    },
  );
  assert.equal(calls, TYPESAFE_MAX_RETRIES + 1);
});

test("evaluateSystemOne honours Retry-After within the cap and does not retry 4xx", async () => {
  const slept: number[] = [];
  let calls = 0;
  await evaluateSystemOne(
    {
      state: "x",
      questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
    },
    {
      apiKey: "ts-test-key-0123",
      retry: { sleep: async (ms) => void slept.push(ms) },
      fetch: mockFetch(() => {
        calls += 1;
        if (calls === 1) {
          return { status: 429, json: {}, headers: { "retry-after": "1" } };
        }
        return { status: 200, json: { answers: noulAnswers({ urgent: 0.2 }) } };
      }),
    },
  );
  assert.deepEqual(slept, [1000]);

  calls = 0;
  await assert.rejects(
    () =>
      evaluateSystemOne(
        {
          state: "x",
          questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
        },
        {
          apiKey: "ts-test-key-0123",
          retry: noSleep,
          fetch: mockFetch(() => {
            calls += 1;
            return { status: 401, json: { message: "nope" } };
          }),
        },
      ),
    /nope/,
  );
  assert.equal(calls, 1);
});

test("evaluateSystemOne retries connection failures", async () => {
  let calls = 0;
  const result = await evaluateSystemOne(
    {
      state: "x",
      questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
    },
    {
      apiKey: "ts-test-key-0123",
      retry: noSleep,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("fetch failed");
        }
        return new Response(JSON.stringify({ answers: noulAnswers({ urgent: 1 }) }), {
          status: 200,
        });
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.model, "jev-latest");
});

test("retryAfterMs parses seconds, ms and dates, and drops hints above the cap", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "1" }), now), 1000);
  assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "250" }), now), 250);
  assert.equal(
    retryAfterMs(new Headers({ "retry-after": new Date(now + 2000).toUTCString() }), now),
    2000,
  );
  assert.equal(retryAfterMs(new Headers({ "retry-after": "30" }), now), null);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" }), now), null);
  assert.equal(retryAfterMs(new Headers(), now), null);
  assert.equal(
    backoffMs(0, () => 0.5),
    500,
  );
  assert.equal(
    backoffMs(10, () => 0.5),
    5000,
  );
});

test("evaluateSystemOne fails closed on missing, out-of-range or unknown answers", async () => {
  const run = (answers: unknown, questions?: Record<string, TypeSafeQuestion>) =>
    evaluateSystemOne(
      {
        state: "x",
        questions: questions ?? { urgent: { type: "noul", instructions: "Is this urgent?" } },
      },
      {
        apiKey: "ts-test-key-0123",
        retry: noSleep,
        fetch: mockFetch(() => ({ status: 200, json: { model: "jev-latest", answers } })),
      },
    );
  await assert.rejects(() => run({}), /missing TypeSafe answer urgent/);
  await assert.rejects(() => run(noulAnswers({ urgent: 1.5 })), /invalid TypeSafe noul answer/);
  await assert.rejects(
    () =>
      run(
        { pick: { type: "choice", choice: "c", probabilities: {}, confidence: 1 } },
        { pick: { type: "choice", instructions: "?", criteria: { a: null, b: null } } },
      ),
    /picked unknown option c/,
  );
  await assert.rejects(
    () =>
      run(
        { level: { type: "score", score: "high" } },
        {
          level: { type: "score", instructions: "?", criteria: ["low", "high"] },
        },
      ),
    /invalid TypeSafe score answer/,
  );
});

test("createTypeSafeClient is unconfigured without a key", async () => {
  const client = createTypeSafeClient({ sources: { env: {}, keys: {} } });
  assert.equal(client.configured, false);
  await assert.rejects(
    () => client.evaluate({ state: {}, questions: {} }),
    (error: unknown) =>
      error instanceof TypeSafeError && error.message === "the group routing key is not set",
  );
});

test("a client follows the group routing key the admin stores, without a restart", async () => {
  const seen: string[] = [];
  const client = createTypeSafeClient({
    fetch: mockFetch((_url, init) => {
      seen.push(String((init?.headers as Record<string, string>).authorization));
      return { status: 200, json: choiceResult("writer") };
    }),
    retry: { maxRetries: 0 },
  });
  const questions: Record<string, TypeSafeQuestion> = {
    recipient: { type: "choice", instructions: "?", criteria: { none: null, writer: null } },
  };
  assert.equal(client.configured, false);
  await assert.rejects(
    () => client.evaluate({ state: {}, questions }),
    /the group routing key is not set/,
  );
  assert.deepEqual(seen, []);
  setInstanceKeys(storeKeys({ "group-routing": { api_key: "k" } }));
  try {
    assert.equal(client.configured, true);
    const result = await client.evaluate({ state: {}, questions });
    assert.equal(result.model, "jev-1.13.0");
    assert.deepEqual(seen, ["Bearer k"]);
  } finally {
    setInstanceKeys({});
  }
  assert.equal(client.configured, false);
});

test("classifyGroupRecipients offers only pending agents, with focus and task preview", async () => {
  const longTask = "Draft short public updates. ".repeat(100);
  const classified = await classifyGroupRecipients(
    {
      rows: [chatRow(1, "Write the note.")],
      members: [
        { id: "a_1", name: "researcher", focus: "papers" },
        { id: "a_2", name: "writer", focus: "notes", task: longTask },
        { id: "a_4", name: "poster", focus: "posts" },
      ],
      pendingNames: ["researcher", "writer"],
    },
    createTypeSafeClient({
      evaluate: async ({ state, questions }) => {
        assert.deepEqual(Object.keys(state as object), ["latest", "context"]);
        assert.deepEqual((state as { context: unknown[] }).context, []);
        const question = questions.recipient;
        assert.equal(question?.type, "choice");
        if (question?.type !== "choice") {
          throw new Error("unreachable");
        }
        assert.deepEqual(Object.keys(question.criteria), ["none", "researcher", "writer"]);
        assert.deepEqual(question.criteria.researcher, { focus: "papers" });
        const writer = question.criteria.writer as { focus: string; task: string };
        assert.equal(writer.focus, "notes");
        assert.ok(writer.task.startsWith("Draft short public updates."));
        assert.equal(writer.task.length, AGENT_TASK_PREVIEW_CHARS + 1);
        assert.ok(writer.task.endsWith("…"));
        return choiceResult("writer", 0.84, { usage: { input_tokens: 40 } });
      },
    }),
  );
  assert.deepEqual([...classified.names], ["writer"]);
  assert.equal(classified.choice, "writer");
  assert.equal(classified.confidence, 0.84);
  assert.equal(classified.model, "jev-1.13.0");
  assert.deepEqual(classified.usage, { input_tokens: 40 });
});

test("classifyGroupRecipients skips the call when nobody is pending", async () => {
  const classified = await classifyGroupRecipients(
    {
      rows: [chatRow(1, "Done.", { author: "writer" })],
      members: [{ id: "a_1", name: "writer" }],
      pendingNames: [],
    },
    createTypeSafeClient({
      evaluate: async () => {
        throw new Error("should not be called");
      },
    }),
  );
  assert.deepEqual([...classified.names], []);
  assert.equal(classified.choice, "none");
});

test("classifyGroupRecipients clips the latest message body for the state", async () => {
  const body = "x".repeat(LATEST_CONTENT_MAX_CHARS + 500);
  await classifyGroupRecipients(
    {
      rows: [chatRow(1, body)],
      members: [{ id: "a_1", name: "writer" }],
      pendingNames: ["writer"],
    },
    createTypeSafeClient({
      evaluate: async ({ state }) => {
        const latest = (state as { latest: { content: string } }).latest;
        assert.equal(latest.content.length, LATEST_CONTENT_MAX_CHARS + 1);
        return choiceResult("none");
      },
    }),
  );
});

test("classifyGroupRecipients sends prior rows as context, not as latest", async () => {
  const rows = [
    chatRow(1, "older than the window"),
    chatRow(2, "y".repeat(HISTORY_CONTENT_MAX_CHARS + 10), { author: "writer" }),
    chatRow(3, "mid"),
    chatRow(4, "near"),
    chatRow(5, "what about that"),
  ];
  await classifyGroupRecipients(
    {
      rows,
      members: [{ id: "a_1", name: "writer" }],
      pendingNames: ["writer"],
    },
    createTypeSafeClient({
      evaluate: async ({ state }) => {
        const typed = state as {
          latest: { seq: number; content: string; sentBy: string };
          context: Array<{ seq: number; content: string; sentBy: string }>;
        };
        assert.equal(typed.latest.seq, 5);
        assert.equal(typed.latest.content, "what about that");
        assert.equal(typed.context.length, RECIPIENT_WINDOW - 1);
        assert.deepEqual(
          typed.context.map((row) => row.seq),
          [2, 3, 4],
        );
        assert.equal(typed.context[0]?.sentBy, "writer");
        assert.equal(typed.context[0]?.content.length, HISTORY_CONTENT_MAX_CHARS + 1);
        assert.ok(!typed.context.some((row) => row.seq === typed.latest.seq));
        return choiceResult("writer");
      },
    }),
  );
});

test("createGroupRouter falls back to the tag rules when confidence is low", async () => {
  const router = createGroupRouter({
    client: createTypeSafeClient({ evaluate: async () => choiceResult("writer", 0.31) }),
  });
  const members = [
    { id: "a_1", name: "researcher" },
    { id: "a_2", name: "writer" },
  ];
  const decision = await router.recipients({
    rows: [chatRow(1, "Hmm.")],
    members,
    pending: [{ name: "researcher" }, { name: "writer" }],
    taggedNames: new Set(),
    ruleNames: new Set(["researcher", "writer"]),
  });
  assert.equal(decision.source, "low_confidence");
  assert.deepEqual([...decision.names].sort(), ["researcher", "writer"]);
  assert.equal(decision.choice, "writer");
  const serialized = serializeRecipientDecision(decision);
  assert.equal(serialized.model, "jev-1.13.0");
  assert.match(String(serialized.reason), /confidence 0\.31 below 0\.5/);
  assert.deepEqual(serialized.probabilities, { writer: 0.31, none: 0.69 });
});

test("selectGroupHistory keeps ten from the last forty, including latest and tagged", async () => {
  const rows = Array.from({ length: 15 }, (_, index) =>
    chatRow(
      index + 1,
      index + 1 === 4 ? "y".repeat(HISTORY_CONTENT_MAX_CHARS + 10) : `m${index + 1}`,
      index + 1 === 3 ? { tagged: ["writer"] } : {},
    ),
  );
  const selected = await selectGroupHistory(
    {
      rows,
      agentName: "writer",
      agentFocus: "notes",
    },
    createTypeSafeClient({
      evaluate: async ({ state, questions }) => {
        const typed = state as {
          agent: { name: string; focus: string };
          messages: Array<{ seq: number; content: string }>;
        };
        assert.deepEqual(typed.agent, { name: "writer", focus: "notes" });
        assert.equal(typed.messages.length, 15);
        assert.equal(typed.messages[3]?.content.length, HISTORY_CONTENT_MAX_CHARS + 1);
        assert.ok(!("keep_3" in questions));
        assert.ok(!("keep_15" in questions));
        const sample = questions.keep_2;
        assert.equal(sample?.type, "noul");
        assert.deepEqual(Object.keys(sample?.instructions as object), ["seq", "question"]);
        assert.equal((sample?.instructions as { seq: number }).seq, 2);
        assert.match((sample?.instructions as { question: string }).question, /^Does `agent` need/);
        assert.doesNotMatch(JSON.stringify(sample), /notes|Code will keep/);
        return {
          model: "jev-1.13.0",
          usage: { input_tokens: 900 },
          answers: noulAnswers({
            ...Object.fromEntries(Object.keys(questions).map((id) => [id, 0.1])),
            keep_2: 0.95,
          }),
        };
      },
    }),
  );
  assert.deepEqual(
    selected.rows.map((row) => Number(row.seq)),
    [2, 3, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.equal(selected.model, "jev-1.13.0");
  const serialized = serializeHistoryDecision({ source: "typesafe", ...selected });
  assert.equal(serialized.model, "jev-1.13.0");
  assert.deepEqual(serialized.usage, { input_tokens: 900 });
});

test("createGroupRouter falls back to everyone and last N when evaluate throws", async () => {
  const router = createGroupRouter({
    client: createTypeSafeClient({
      evaluate: async () => {
        throw new TypeSafeError("TypeSafe HTTP 529", 529, 3);
      },
    }),
  });
  const members = [
    { id: "a_1", name: "researcher" },
    { id: "a_2", name: "writer" },
  ];
  const rows = Array.from({ length: 12 }, (_, index) => chatRow(index + 1, `m${index + 1}`));
  const recipients = await router.recipients({
    rows,
    members,
    pending: [
      { name: "researcher", group_chat_delivered_through: 0 },
      { name: "writer", group_chat_delivered_through: 0 },
    ],
    taggedNames: new Set(["writer"]),
  });
  assert.equal(recipients.source, "fallback");
  assert.deepEqual([...recipients.names].sort(), ["researcher", "writer"]);
  const history = await router.history({ rows, agentName: "writer" });
  assert.equal(history.source, "fallback");
  assert.equal(history.rows.length, CONTEXT_HISTORY_LIMIT);
  assert.equal(history.rows[0]?.seq, 3);
});

test("replayRecipients re-runs the Choice for one message and reports the verdict", async () => {
  const members = [
    {
      id: "a_manager",
      name: "manager",
      focus: "fund retrospectives",
      task: "Keep the retrospect.",
    },
    { id: "a_trader", name: "trader", focus: "entries and exits", task: "" },
  ];
  const rows = [
    chatRow(1, "Plan the week."),
    chatRow(2, "Exited $JEANPHIL.", { author: "trader" }),
    chatRow(3, "good job so far. manager make sure to include in retrospect"),
  ];
  const seen: string[][] = [];
  const client = createTypeSafeClient({
    evaluate: async ({ questions }) => {
      const question = questions.recipient;
      if (question?.type === "choice") {
        seen.push(Object.keys(question.criteria));
      }
      return choiceResult("none", 0.71);
    },
  });
  const report = await replayRecipients({ rows, members }, { client });
  assert.equal(report.seq, 3);
  assert.equal(report.author, "user");
  assert.deepEqual(seen, [["none", "manager", "trader"]]);
  assert.deepEqual(report.rule_names, ["manager", "trader"]);
  assert.deepEqual(report.would_wake, []);
  assert.equal(report.decision.source, "typesafe");
  assert.equal(report.decision.choice, "none");
  const text = formatRecipientReplay(report);
  assert.match(text, /decision: source=typesafe choice=none/);
  assert.match(text, /tag rules alone would wake: manager, trader/);
  assert.match(text, /with this decision, wakes: \(nobody\)/);

  // An agent's own post never offers the author; a lower gate flips the verdict.
  seen.length = 0;
  const agentPost = await replayRecipients(
    { rows, members },
    { client, confidenceMin: 0.9 },
    { seq: 2 },
  );
  assert.deepEqual(seen, [["none", "manager"]]);
  assert.equal(agentPost.decision.source, "low_confidence");
  assert.deepEqual(agentPost.rule_names, []);

  // A hypothetical message is evaluated as a new user post after seq.
  const hypothetical = await replayRecipients(
    { rows, members },
    { client },
    { message: "@manager hi" },
  );
  assert.equal(hypothetical.seq, 4);
  assert.equal(hypothetical.content, "@manager hi");
});

// The recipient wording must state the criterion (what the message asks) and
// nothing else: no genres, no phrasing borrowed from a message that once
// misrouted. Change it only with a general principle, then run the live
// routing and history cases in test/contract/typesafe.test.ts
// (RUN_TYPESAFE_CONTRACT=1) before changing this pin.
test("recipient question wording states the criterion, not genres or examples", async () => {
  let question: TypeSafeQuestion | undefined;
  await classifyGroupRecipients(
    {
      rows: [chatRow(1, "hello")],
      members: [{ id: "a_1", name: "writer", focus: "notes" }],
      pendingNames: ["writer"],
    },
    createTypeSafeClient({
      evaluate: async ({ questions }) => {
        question = questions.recipient;
        return choiceResult("none");
      },
    }),
  );
  assert.equal(question?.type, "choice");
  if (question?.type !== "choice") {
    throw new Error("unreachable");
  }
  assert.equal(
    question.criteria.none,
    "The message asks no agent to do, answer, or record anything.",
  );
  assert.equal(
    question.instructions,
    "Which agent should act on `latest`? `context` is the recent messages before `latest`; use it only to resolve what `latest` refers to. Each option describes an agent's duties. Pick the agent whose duties cover what `latest` asks for. Pick `none` when `latest` asks for nothing.",
  );
});
