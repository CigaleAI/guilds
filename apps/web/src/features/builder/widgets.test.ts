import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioMessage } from "../../api/types";
import {
  accessCutMessage,
  answeredAll,
  answerMessage,
  pendingQuestions,
  widgetOf,
  type Question,
} from "./widgets";

const tool = (content: unknown): Pick<StudioMessage, "payload"> => ({
  payload: { role: "tool", content: JSON.stringify(content) },
});

test("a connect widget reads its server, scopes and connection state", () => {
  const widget = widgetOf(
    tool({
      widget: "connect",
      mode: "any",
      server: { id: "mcp_notion", slug: "notion", display_name: "Notion", auth: "oauth" },
      servers: [{ id: "mcp_x", slug: "x", auth: "token", connection_state: "connected" }],
      recommended_scope: "guild",
      allowed_scopes: ["org", "guild", "planet"],
      already_connected: false,
      reason: "Tables live there.",
      title: "Connect Notion",
      storage_hint: null,
    }),
  );
  assert.ok(widget?.kind === "connect");
  assert.equal(widget.server?.display_name, "Notion");
  assert.deepEqual(widget.allowedScopes, ["org", "guild"]);
  assert.equal(widget.servers[0]?.display_name, "x");
  assert.equal(widget.servers[0]?.connection_state, "connected");
});

test("a question widget accepts the one-question shorthand and nested results", () => {
  const nested = widgetOf(
    tool({ content: JSON.stringify({ widget: "question", question: "Which chain?" }) }),
  );
  assert.ok(nested?.kind === "question");
  assert.deepEqual(nested.questions[0], {
    id: "q-1",
    header: "Question",
    question: "Which chain?",
    options: [],
    allowOther: true,
    multiSelect: false,
  });
  assert.equal(widgetOf(tool({ error: "unknown or unpublished connector" })), null);
  assert.equal(widgetOf({ payload: { role: "assistant", content: "{}" } }), null);
});

test("answers become one line per question", () => {
  const questions: Question[] = [
    {
      id: "chain",
      header: "Chain",
      question: "Which chain?",
      options: [
        { id: "sol", label: "Solana", description: "" },
        { id: "eth", label: "Ethereum", description: "" },
      ],
      allowOther: true,
      multiSelect: true,
    },
    {
      id: "cap",
      header: "Cap",
      question: "Largest trade?",
      options: [],
      allowOther: true,
      multiSelect: false,
    },
  ];
  const answers = {
    chain: { picked: ["sol", "eth"], other: "" },
    cap: { picked: [], other: "$1k" },
  };
  assert.equal(answeredAll(questions, answers), true);
  assert.equal(answeredAll(questions, { chain: answers.chain }), false);
  assert.equal(
    answerMessage(questions, answers),
    "I answered:\n- Chain: Solana; Ethereum\n- Cap: $1k",
  );
});

test("the design's open questions become one widget, minus those answered", () => {
  const recipe = {
    body: {
      design: {
        systems: [
          { name: "Payments", resolution: "decision", reason: "Open question. Which processor?" },
          { name: "Search", resolution: "catalog", server: "exa", reason: "Web search" },
        ],
      },
    },
  };
  const widget = pendingQuestions(recipe, new Set());
  assert.equal(widget?.questions.length, 1);
  assert.equal(widget?.questions[0]?.question, "Which processor?");
  assert.equal(pendingQuestions(recipe, new Set(["Payments"])), null);
});

test("access cuts name removed tools and connectors only", () => {
  assert.equal(
    accessCutMessage([
      { action: "set_tool", server: "x", role: "scout", tool: "x_post", enabled: false },
      { action: "set_tool", server: "x", role: "scout", tool: "x_search", enabled: true },
      { action: "remove_connection", server: "notion" },
    ]),
    "I validated connector access. I removed:\n- tool x_post from x for scout\n- connector notion\nUpdate standing prompts if they rely on these, or ask me questions.",
  );
  assert.equal(
    accessCutMessage([
      { action: "set_tool", server: "x", role: "scout", tool: "a", enabled: true },
    ]),
    null,
  );
});
