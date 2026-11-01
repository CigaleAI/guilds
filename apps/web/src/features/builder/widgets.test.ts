import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AnyConnectWidget,
  ConnectServer,
  OrgConnectWidget,
  Question,
  QuestionWidget,
} from "../../api/types/builder";
import type { StudioMessage } from "../../api/types/studio";
import { isConnectScope } from "../../api/wire";
import type { RecipeDraft } from "../recipes/plan/recipeDraft";
import {
  accessCutMessage,
  answeredAll,
  answerMessage,
  initialServerId,
  pendingQuestions,
  pickedServer,
  serverName,
  widgetOf,
} from "./widgets";

const tool = (content: unknown): Pick<StudioMessage, "payload"> => ({
  payload: { role: "tool", tool_call_id: "c1", content: JSON.stringify(content) },
});

const notion: ConnectServer = {
  id: "mcp_notion",
  slug: "notion",
  display_name: "Notion",
  auth: "oauth",
  oauth_setup_state: "dynamic",
  setup_hint: null,
  connection_state: "registered_not_connected",
};

const x: ConnectServer = {
  id: "mcp_x",
  slug: "x",
  display_name: "",
  auth: "token",
  oauth_setup_state: "not_applicable",
  setup_hint: "Paste an API key.",
  auth_fields: [{ name: "api_key", label: "API key", secret: true }],
  connection_state: "connected",
};

const anyWidget: AnyConnectWidget = {
  widget: "connect",
  mode: "any",
  server: notion,
  servers: [notion, x],
  recommended_scope: "guild",
  allowed_scopes: ["org", "guild"],
  already_connected: false,
  await_operator: true,
  reason: "Tables live there.",
  title: "Connect Notion",
  storage_hint: null,
};

const orgWidget: OrgConnectWidget = {
  widget: "connect",
  mode: "org",
  server: x,
  recommended_scope: "org",
  allowed_scopes: ["org"],
  already_connected: true,
  await_operator: false,
  reason: "Posts go out there.",
  title: "x is already connected to this organisation",
  storage_hint: "Keep queues in local tables.",
};

const questionWidget: QuestionWidget = {
  widget: "question",
  await_operator: true,
  title: "Question",
  questions: [
    {
      id: "q-1",
      header: "Chain",
      question: "Which chain?",
      options: [{ id: "opt-1", label: "Solana", description: "" }],
      allow_other: true,
      multi_select: false,
    },
  ],
};

test("a connect widget is read as the server wrote it, beside the result's sequence number", () => {
  const widget = widgetOf(tool({ tool_message_seq: 7, connect_now: false, ...anyWidget }));
  assert.ok(widget?.widget === "connect" && widget.mode === "any");
  assert.deepEqual(widget.server, notion);
  assert.deepEqual(widget.allowed_scopes, ["org", "guild"]);
  assert.deepEqual(widget.servers[1]?.auth_fields, x.auth_fields);
  assert.equal(widget.servers[1]?.connection_state, "connected");
  const org = widgetOf(tool(orgWidget));
  assert.ok(org?.widget === "connect");
  assert.equal(org.await_operator, false);
  assert.equal(org.storage_hint, "Keep queues in local tables.");
});

test("a connect card starts on the named server and signs in to the one picked", () => {
  assert.equal(initialServerId(anyWidget), "mcp_notion");
  assert.equal(initialServerId({ ...anyWidget, server: null }), "mcp_notion");
  assert.equal(initialServerId({ ...anyWidget, server: null, servers: [x] }), "mcp_x");
  assert.equal(initialServerId({ ...anyWidget, server: null, servers: [] }), "");
  assert.equal(initialServerId(orgWidget), "mcp_x");
  assert.equal(pickedServer(anyWidget, "mcp_x")?.id, "mcp_x");
  assert.equal(pickedServer(anyWidget, "mcp_gone")?.id, "mcp_notion");
  assert.equal(pickedServer({ ...anyWidget, server: null }, "mcp_gone"), null);
  assert.equal(pickedServer(orgWidget, "mcp_notion")?.id, "mcp_x");
  assert.equal(serverName(notion), "Notion");
  assert.equal(serverName(x), "x");
  assert.equal(serverName(null), "the service");
});

test("a connect scope is one of org, guild and agent", () => {
  assert.equal(isConnectScope("guild"), true);
  assert.equal(isConnectScope("planet"), false);
  assert.equal(isConnectScope(undefined), false);
});

test("a connect widget whose scopes or servers are not the server's carries none", () => {
  assert.equal(widgetOf(tool({ ...anyWidget, recommended_scope: "planet" })), null);
  assert.equal(widgetOf(tool({ ...anyWidget, allowed_scopes: ["org", "planet"] })), null);
  assert.equal(widgetOf(tool({ ...anyWidget, mode: "org", server: null })), null);
  assert.equal(widgetOf(tool({ ...anyWidget, servers: undefined })), null);
  assert.equal(
    widgetOf(tool({ ...anyWidget, server: { id: "mcp_notion", slug: "notion" } })),
    null,
  );
  assert.equal(
    widgetOf(tool({ ...orgWidget, server: { ...x, auth_fields: [{ label: "No name" }] } })),
    null,
  );
  assert.equal(
    widgetOf(
      tool({
        ...orgWidget,
        server: { ...x, auth_fields: [{ ...x.auth_fields?.[0], optional: "yes" }] },
      }),
    ),
    null,
  );
});

test("a tool result whose content is not an object carries no widget", () => {
  assert.equal(widgetOf(tool(["widget", "connect"])), null);
  assert.equal(widgetOf(tool("connect")), null);
  assert.equal(
    widgetOf({ payload: { role: "tool", tool_call_id: "c1", content: "not json" } }),
    null,
  );
});

test("a question widget is read as the server wrote it, and nothing else is one", () => {
  assert.deepEqual(widgetOf(tool(questionWidget)), questionWidget);
  assert.equal(widgetOf(tool({ widget: "question", question: "Which chain?" })), null);
  assert.equal(widgetOf(tool({ content: JSON.stringify(questionWidget) })), null);
  assert.equal(
    widgetOf(tool({ ...questionWidget, questions: [{ question: "Which chain?" }] })),
    null,
  );
  assert.equal(widgetOf(tool({ error: "unknown or unpublished connector" })), null);
  assert.equal(
    widgetOf({ payload: { role: "assistant", content: JSON.stringify(questionWidget) } }),
    null,
  );
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
      allow_other: true,
      multi_select: true,
    },
    {
      id: "cap",
      header: "Cap",
      question: "Largest trade?",
      options: [],
      allow_other: true,
      multi_select: false,
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
  const recipe: RecipeDraft = {
    design: {
      systems: [
        { name: "Payments", resolution: "decision", reason: "Open question. Which processor?" },
        { name: "Search", resolution: "catalog", server: "exa", reason: "Web search" },
      ],
    },
  };
  const widget = pendingQuestions(recipe, new Set());
  assert.equal(widget?.await_operator, true);
  assert.equal(widget.questions.length, 1);
  assert.equal(widget.questions[0]?.question, "Which processor?");
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
