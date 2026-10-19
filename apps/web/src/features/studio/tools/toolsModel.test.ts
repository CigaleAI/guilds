import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioTool, StudioToolCall } from "../../../api/types";
import type { Proposal } from "../pendingModel";
import {
  errorGroups,
  filterTools,
  formatDuration,
  mostCalledBy,
  noToolFilters,
  offeredNeverCalled,
  toolFlagLabel,
  toolFlags,
  toolsAwaitingApproval,
} from "./toolsModel";

function tool(name: string, overrides: Partial<StudioTool> = {}): StudioTool {
  return {
    name,
    source: "native",
    group: name.split("_")[0] ?? name,
    description: "",
    server_id: null,
    offered_to: ["a_1"],
    calls: 0,
    errors: 0,
    median_ms: null,
    last_at: null,
    agents: [
      { agent_id: "a_1", offered: true, calls: 0, errors: 0, median_ms: null, last_at: null },
    ],
    ...overrides,
  };
}

const usage = (agent_id: string, offered: boolean, calls: number, errors = 0) => ({
  agent_id,
  offered,
  calls,
  errors,
  median_ms: null,
  last_at: null,
});

test("a tool offered and never called, unused by some, or failing often is flagged", () => {
  assert.deepEqual(toolFlags(tool("note_get"), false), [{ kind: "never_called" }]);
  assert.deepEqual(
    toolFlags(tool("note_get", { offered_to: [], calls: 0, agents: [] }), false),
    [],
  );
  const busy = tool("note_get", {
    offered_to: ["a_1", "a_2"],
    calls: 10,
    errors: 1,
    agents: [usage("a_1", true, 10, 1), usage("a_2", true, 0)],
  });
  assert.deepEqual(toolFlags(busy, true), [
    { kind: "idle_agents", count: 1 },
    { kind: "failing", percent: 10 },
    { kind: "needs_approval" },
  ]);
  assert.deepEqual(toolFlags({ ...busy, errors: 0, agents: [usage("a_1", true, 10)] }, false), []);
  assert.deepEqual(offeredNeverCalled(busy), ["a_2"]);
});

test("flags read as short labels", () => {
  assert.equal(toolFlagLabel({ kind: "never_called" }), "never called");
  assert.equal(toolFlagLabel({ kind: "idle_agents", count: 2 }), "2 never call it");
  assert.equal(toolFlagLabel({ kind: "failing", percent: 25 }), "25% fail");
  assert.equal(toolFlagLabel({ kind: "needs_approval" }), "needs approval");
});

test("the agent that calls a tool most is named with its share", () => {
  const called = tool("note_get", {
    calls: 4,
    agents: [usage("a_1", true, 1), usage("a_2", false, 3)],
  });
  assert.deepEqual(mostCalledBy(called), { agent_id: "a_2", share: 0.75 });
  assert.equal(mostCalledBy(tool("note_get")), null);
});

test("an open access change marks the tools it touches", () => {
  const tools = [
    tool("note_get"),
    tool("notion_search", { source: "connector", server_id: "srv_1" }),
    tool("notion_create", { source: "connector", server_id: "srv_1" }),
  ];
  const proposal = (state: Proposal["state"], changes: unknown[]): Proposal =>
    ({
      seq: 1,
      state,
      widget: { kind: "edit", edit: { kind: "access", changes } },
    }) as unknown as Proposal;
  const marked = toolsAwaitingApproval(
    [
      proposal("open", [
        { kind: "native_tool", id: "note_get", label: "note_get", setting: "off" },
        { kind: "mcp", id: "srv_1", label: "Notion", setting: "on" },
        { kind: "artifact_grant", id: "read_org", label: "read_org", setting: "on" },
      ]),
      proposal("decided", [
        { kind: "mcp_tool", id: "other_tool", label: "other_tool", setting: "off" },
      ]),
      { seq: 2, state: "open", widget: { kind: "draft" } } as unknown as Proposal,
    ],
    tools,
  );
  assert.deepEqual([...marked].sort(), ["note_get", "notion_create", "notion_search"]);
});

test("filters keep tools by source, agent, a reason to look, and search words, most called first", () => {
  const tools = [
    tool("note_get", { calls: 3, agents: [usage("a_1", true, 3)] }),
    tool("notion_search", {
      source: "connector",
      group: "Notion",
      calls: 9,
      agents: [usage("a_2", true, 9)],
    }),
    tool("note_find"),
  ];
  const flags = (item: StudioTool) => toolFlags(item, false);
  assert.deepEqual(
    filterTools(tools, noToolFilters, flags).map((item) => item.name),
    ["notion_search", "note_get", "note_find"],
  );
  assert.deepEqual(
    filterTools(tools, { ...noToolFilters, source: "connector" }, flags).map((item) => item.name),
    ["notion_search"],
  );
  assert.deepEqual(
    filterTools(tools, { ...noToolFilters, agent: "a_1" }, flags).map((item) => item.name),
    ["note_get", "note_find"],
  );
  assert.deepEqual(
    filterTools(tools, { ...noToolFilters, needsLook: true }, flags).map((item) => item.name),
    ["note_find"],
  );
  assert.deepEqual(
    filterTools(tools, { ...noToolFilters, query: " notion " }, flags).map((item) => item.name),
    ["notion_search"],
  );
});

test("failed calls group by their error, most frequent first", () => {
  const call = (at: string, status: "ok" | "error", error: string | null): StudioToolCall => ({
    at,
    agent_id: "a_1",
    run_id: "r_1",
    call_id: null,
    seq: null,
    arguments: "",
    status,
    error,
    duration_ms: null,
  });
  assert.deepEqual(
    errorGroups([
      call("2026-10-19T10:00:00Z", "error", "timeout"),
      call("2026-10-19T11:00:00Z", "error", "timeout"),
      call("2026-10-19T09:00:00Z", "error", null),
      call("2026-10-19T12:00:00Z", "ok", null),
    ]),
    [
      { message: "timeout", count: 2, last_at: "2026-10-19T11:00:00Z" },
      { message: "error", count: 1, last_at: "2026-10-19T09:00:00Z" },
    ],
  );
});

test("durations read in milliseconds under a second, else seconds", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(240.4), "240 ms");
  assert.equal(formatDuration(1530), "1.5 s");
});
