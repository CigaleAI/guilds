import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunMessage, ToolCallRequest } from "./toolFormat";
import {
  classifyToolCall,
  connectedToolServers,
  isMutation,
  isScriptRun,
  kindBreakdown,
  levelFromDisplayPath,
  offeredToolNames,
} from "./toolKinds";

function call(name: string, args: Record<string, unknown> = {}): ToolCallRequest {
  return { id: "c1", function: { name, arguments: JSON.stringify(args) } };
}

function result(content: string): RunMessage {
  return {
    payload: { role: "tool", tool_call_id: "c1", content },
    metadata: { tool_name: "note_get" },
  };
}

const run = {
  config_snapshot: {
    tools: [
      { type: "function", function: { name: "note_find" } },
      { type: "function", function: { name: "weekly_pnl" } },
      { type: "function", function: { name: "notion_search" } },
    ],
    mcp: [
      {
        connection_id: "conn_1",
        server_id: "srv_1",
        slug: "notion",
        tools: [{ name: "notion_search", remote_name: "search" }],
      },
    ],
  },
};

test("levelFromDisplayPath reads the owner prefix", () => {
  assert.equal(levelFromDisplayPath("org/o1/agents/a1/memory.md"), "local");
  assert.equal(levelFromDisplayPath("org/o1/guilds/g1/plan.md"), "guild");
  assert.equal(levelFromDisplayPath("org/o1/shared.md"), "org");
  assert.equal(levelFromDisplayPath("org/o1/collections/deals/7"), "org");
  assert.equal(levelFromDisplayPath("plan.md"), null);
  assert.equal(levelFromDisplayPath(42), null);
});

test("writes take their level from the level argument", () => {
  assert.deepEqual(classifyToolCall(call("note_write", { level: "guild", key: "plan.md" })), {
    name: "note_write",
    kind: "write",
    level: "guild",
    server: null,
  });
  assert.equal(
    classifyToolCall(call("note_write", { level: "agent", key: "x.md" })).level,
    "local",
  );
});

test("record tools are organisation reads and writes whatever the arguments say", () => {
  assert.deepEqual(
    classifyToolCall(call("record_add", { collection: "deals", body: { name: "x" } })),
    {
      name: "record_add",
      kind: "write",
      level: "org",
      server: null,
    },
  );
  assert.equal(
    classifyToolCall(call("record_update", { collection: "deals", id: 42, body: {} })).kind,
    "write",
  );
  assert.equal(
    classifyToolCall(call("record_remove", { collection: "deals", id: 42 })).kind,
    "write",
  );
  assert.equal(
    classifyToolCall(call("record_list", { collection: "deals", level: "guild" })).level,
    "org",
  );
  assert.equal(classifyToolCall(call("record_search", { query: "acme" })).kind, "read");
  assert.equal(classifyToolCall(call("record_search", { query: "acme" })).level, "org");
});

test("reads take their level from a display path in arguments or result", () => {
  assert.equal(
    classifyToolCall(call("note_get", { path: "org/o1/guilds/g1/plan.md" })).level,
    "guild",
  );
  assert.equal(classifyToolCall(call("note_get", { path: "org/o1/shared.md" })).level, "org");
  const fromResult = classifyToolCall(
    call("note_get"),
    result("org/o1/guilds/g1/plan.md\n\n# Plan"),
  );
  assert.equal(fromResult.level, "guild");
  assert.equal(fromResult.kind, "read");
});

test("finds cover all readable levels unless narrowed", () => {
  assert.equal(classifyToolCall(call("note_find", { query: "q" })).level, "all");
  assert.equal(classifyToolCall(call("note_find", { level: "guild" })).level, "guild");
  assert.equal(
    classifyToolCall(call("note_find", { path_prefix: "org/o1/agents/a1/" })).level,
    "local",
  );
});

test("memory is its own kind at the local level", () => {
  assert.deepEqual(classifyToolCall(call("memory_write", { content: "x" })), {
    name: "memory_write",
    kind: "memory",
    level: "local",
    server: null,
  });
  assert.equal(
    classifyToolCall(call("note_get", { path: "org/o1/agents/a1/memory.md" })).kind,
    "memory",
  );
  assert.equal(
    classifyToolCall(call("note_get", { path: "org/o1/agents/a1/memo.md" })).kind,
    "read",
  );
});

test("fixed-level tools ignore arguments", () => {
  assert.deepEqual(classifyToolCall(call("group_post", { content: "hi" })), {
    name: "group_post",
    kind: "post",
    level: "guild",
    server: null,
  });
  assert.deepEqual(classifyToolCall(call("script_run", { name: "one" })), {
    name: "script_run",
    kind: "execute",
    level: "local",
    server: null,
  });
  assert.equal(classifyToolCall(call("schedule_create_cron", { level: "org" })).level, "local");
  assert.equal(classifyToolCall(call("schedule_create_window", { level: "org" })).level, "local");
  assert.equal(classifyToolCall(call("browser_click", { ref: "e1" })).level, null);
  assert.equal(classifyToolCall(call("browser_click")).kind, "act");
  assert.equal(classifyToolCall(call("browser_eval")).kind, "act");
  assert.equal(classifyToolCall(call("browser_scroll")).kind, "act");
  assert.equal(classifyToolCall(call("browser_snapshot")).kind, "read");
  assert.deepEqual(classifyToolCall(call("code_task", { brief: "Fix greet", repo: "app" })), {
    name: "code_task",
    kind: "execute",
    level: "local",
    server: null,
  });
});

test("only changes to tracked state are mutations", () => {
  const mutates = (name: string, args: Record<string, unknown> = {}) =>
    isMutation(classifyToolCall(call(name, args), null, run));
  const tracked = [
    "note_write",
    "note_delete",
    "memory_write",
    "record_add",
    "studio_edit_collection",
    "script_create",
    "code_task",
  ];
  for (const name of tracked) assert.equal(mutates(name), true, name);
  const untracked = ["shell", "script_run", "group_post", "schedule_create_cron", "browser_click"];
  for (const name of untracked) assert.equal(mutates(name), false, name);
  assert.equal(mutates("note_get", { path: "org/o1/agents/a1/memory.md" }), false);
  assert.equal(mutates("studio_list_memory_revisions"), false);
  assert.equal(mutates("notion_search"), false);
  assert.equal(mutates("weekly_pnl"), false);
});

test("a script run is told apart from other commands", () => {
  assert.equal(isScriptRun(classifyToolCall(call("script_run", { name: "one" }))), true);
  assert.equal(isScriptRun(classifyToolCall(call("shell", { command: "ls" }))), false);
});

test("connected tools resolve from the run snapshot with their server slug", () => {
  assert.deepEqual(classifyToolCall(call("notion_search", { query: "q" }), null, run), {
    name: "notion_search",
    kind: "connected",
    level: null,
    server: "notion",
  });
  assert.deepEqual([...connectedToolServers(run)], [["notion_search", "notion"]]);
});

test("offered names outside the table and the mcp list are first-class scripts", () => {
  assert.deepEqual(classifyToolCall(call("weekly_pnl", { week: 3 }), null, run), {
    name: "weekly_pnl",
    kind: "execute",
    level: "local",
    server: null,
  });
  assert.deepEqual([...offeredToolNames(run)], ["note_find", "weekly_pnl", "notion_search"]);
});

test("names nothing explains are unknown, including without a run", () => {
  assert.equal(classifyToolCall(call("weekly_pnl")).kind, "unknown");
  assert.equal(classifyToolCall(call("mystery"), null, run).kind, "unknown");
  assert.equal(classifyToolCall({}, { metadata: { tool_name: "memory_write" } }).kind, "memory");
  assert.equal(classifyToolCall(call("note_get", { path: 7 })).level, null);
});

test("kindBreakdown lists kinds in table order with counts", () => {
  const infos = ["note_find", "note_get", "memory_write", "group_post", "note_write"].map((name) =>
    classifyToolCall(call(name)),
  );
  assert.equal(kindBreakdown(infos), "memory · read × 2 · write · post");
  assert.equal(kindBreakdown([]), "");
});
