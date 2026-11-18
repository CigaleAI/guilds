import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunMessage, ToolCall } from "../../../api/types/runs";
import {
  classifyToolCall,
  connectedToolServers,
  isMutation,
  isScriptRun,
  kindBreakdown,
  offeredToolNames,
} from "./toolKinds";

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function result(
  content: string,
  metadata: RunMessage["metadata"] = { tool_name: "note_get" },
): RunMessage {
  return {
    id: 1,
    seq: 1,
    payload: { role: "tool", tool_call_id: "c1", content },
    metadata,
    created_at: "2026-09-21T08:00:00Z",
    cost_usd: null,
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

test("note and file calls name no level, whatever their arguments or result say", () => {
  assert.deepEqual(classifyToolCall(call("note_write", { key: "plan.md" }), null), {
    name: "note_write",
    kind: "write",
    level: null,
    server: null,
    harness: null,
  });
  assert.equal(classifyToolCall(call("note_get", { path: "org/o1/plan.md" }), null).level, null);
  assert.equal(classifyToolCall(call("note_get"), null, result("org/o1/plan.md\n\n# Plan")).level, null);
  assert.equal(classifyToolCall(call("note_find", { query: "q" }), null).level, null);
  assert.equal(classifyToolCall(call("file_put", { home_path: "out/report.pdf" }), null).level, null);
  assert.equal(classifyToolCall(call("file_find", { query: "report" }), null).level, null);
});

test("record tools are organisation reads and writes whatever the arguments say", () => {
  assert.deepEqual(
    classifyToolCall(call("record_add", { collection: "deals", body: { name: "x" } }), null),
    {
      name: "record_add",
      kind: "write",
      level: "org",
      server: null,
      harness: null,
    },
  );
  assert.equal(
    classifyToolCall(call("record_update", { collection: "deals", id: 42, body: {} }), null).kind,
    "write",
  );
  assert.equal(
    classifyToolCall(call("record_remove", { collection: "deals", id: 42 }), null).kind,
    "write",
  );
  assert.equal(
    classifyToolCall(call("record_list", { collection: "deals", level: "guild" }), null).level,
    "org",
  );
  assert.equal(classifyToolCall(call("record_search", { query: "acme" }), null).kind, "read");
  assert.equal(classifyToolCall(call("record_search", { query: "acme" }), null).level, "org");
});

test("an agent's Memory is its own kind at the local level, and a note named memory.md is not", () => {
  assert.deepEqual(classifyToolCall(call("memory_write", { content: "x" }), null), {
    name: "memory_write",
    kind: "memory",
    level: "local",
    server: null,
    harness: null,
  });
  assert.equal(
    classifyToolCall(call("note_get", { path: "org/o1/agents/a1/memory.md" }), null).kind,
    "memory",
  );
  assert.equal(
    classifyToolCall(call("note_get", { path: "org/o1/agents/a1/memo.md" }), null).kind,
    "read",
  );
  assert.equal(classifyToolCall(call("note_get", { path: "org/o1/memory.md" }), null).kind, "read");
});

test("fixed-level tools ignore arguments", () => {
  assert.deepEqual(classifyToolCall(call("group_post", { content: "hi" }), null), {
    name: "group_post",
    kind: "post",
    level: "guild",
    server: null,
    harness: null,
  });
  assert.deepEqual(classifyToolCall(call("script_run", { name: "one" }), null), {
    name: "script_run",
    kind: "execute",
    level: "local",
    server: null,
    harness: null,
  });
  assert.equal(classifyToolCall(call("schedule_create_cron", { level: "org" }), null).level, "local");
  assert.equal(classifyToolCall(call("schedule_create_window", { level: "org" }), null).level, "local");
  assert.equal(classifyToolCall(call("browser_click", { ref: "e1" }), null).level, null);
  assert.equal(classifyToolCall(call("browser_click"), null).kind, "act");
  assert.equal(classifyToolCall(call("browse", { task: "find the price" }), null).kind, "act");
  assert.equal(classifyToolCall(call("browser_eval"), null).kind, "act");
  assert.equal(classifyToolCall(call("browser_scroll"), null).kind, "act");
  assert.equal(classifyToolCall(call("browser_snapshot"), null).kind, "read");
  assert.deepEqual(classifyToolCall(call("code_task", { brief: "Fix greet", repo: "app" }), null), {
    name: "code_task",
    kind: "unknown",
    level: null,
    server: null,
    harness: null,
  });
});

test("only changes to tracked state are mutations", () => {
  const mutates = (name: string, args: Record<string, unknown> = {}) =>
    isMutation(classifyToolCall(call(name, args), null, null, run));
  const tracked = [
    "note_write",
    "note_delete",
    "memory_write",
    "record_add",
    "studio_edit_collection",
    "script_create",
  ];
  for (const name of tracked) assert.equal(mutates(name), true, name);
  const untracked = ["code_task", "script_run", "group_post", "schedule_create_cron", "browser_click"];
  for (const name of untracked) assert.equal(mutates(name), false, name);
  assert.equal(mutates("note_get", { path: "org/o1/agents/a1/memory.md" }), false);
  assert.equal(mutates("studio_list_memory_revisions"), false);
  assert.equal(mutates("notion_search"), false);
  assert.equal(mutates("weekly_pnl"), false);
});

test("a script run is told apart from other commands", () => {
  assert.equal(isScriptRun(classifyToolCall(call("script_run", { name: "one" }), null)), true);
  assert.equal(isScriptRun(classifyToolCall(call("Bash", { command: "ls" }), null)), false);
});

test("connected tools resolve from the run snapshot with their server slug", () => {
  assert.deepEqual(classifyToolCall(call("notion_search", { query: "q" }), null, null, run), {
    name: "notion_search",
    kind: "connected",
    level: null,
    server: "notion",
    harness: null,
  });
  assert.deepEqual([...connectedToolServers(run)], [["notion_search", "notion"]]);
});

test("offered names outside the table and the mcp list are first-class scripts", () => {
  assert.deepEqual(classifyToolCall(call("weekly_pnl", { week: 3 }), null, null, run), {
    name: "weekly_pnl",
    kind: "execute",
    level: "local",
    server: null,
    harness: null,
  });
  assert.deepEqual([...offeredToolNames(run)], ["note_find", "weekly_pnl", "notion_search"]);
});

test("names nothing explains are unknown, including without a run", () => {
  assert.equal(classifyToolCall(call("weekly_pnl"), null).kind, "unknown");
  assert.equal(classifyToolCall(call("mystery"), null, null, run).kind, "unknown");
  assert.equal(
    classifyToolCall(
      { id: "c1", type: "function", function: { name: "", arguments: "" } }, null,
      result("ok", { tool_name: "memory_write" }),
    ).kind,
    "memory",
  );
  assert.equal(classifyToolCall(call("note_get", { path: 7 }), null).level, null);
});

test("kindBreakdown lists kinds in table order with counts", () => {
  const infos = ["note_find", "note_get", "memory_write", "group_post", "note_write"].map((name) =>
    classifyToolCall(call(name), null),
  );
  assert.equal(kindBreakdown(infos), "memory · read × 2 · write · post");
  assert.equal(kindBreakdown([]), "");
});

test("a call of Claude Code's own tool reads by its kind on the agent's home, or the web", () => {
  const harnessResult = result("ok", { tool_name: "Bash", from_harness: "claude-code" });
  assert.deepEqual(classifyToolCall(call("Bash", { command: "ls" }), "claude-code", harnessResult), {
    name: "Bash",
    kind: "execute",
    level: "local",
    server: null,
    harness: "claude-code",
  });
  assert.equal(classifyToolCall(call("Read", { file_path: "/home/a_1/a.md" }), "claude-code").kind, "read");
  assert.equal(classifyToolCall(call("Edit", { file_path: "/home/a_1/a.md" }), "claude-code").kind, "write");
  assert.deepEqual(classifyToolCall(call("WebFetch", { url: "https://example.com" }), "claude-code"), {
    name: "WebFetch",
    kind: "read",
    level: null,
    server: null,
    harness: "claude-code",
  });
  assert.equal(
    isMutation(classifyToolCall(call("Edit"), "claude-code")),
    false,
    "an edit in the home is no tracked state",
  );
});

test("a call of Codex's own tool reads by the kind of item its log reports", () => {
  assert.deepEqual(classifyToolCall(call("command_execution", { command: "ls" }), "codex"), {
    name: "command_execution",
    kind: "execute",
    level: "local",
    server: null,
    harness: "codex",
  });
  assert.equal(classifyToolCall(call("file_change", { changes: [{ path: "a.py" }] }), "codex").kind, "write");
  assert.deepEqual(classifyToolCall(call("web_search", { query: "guilds" }), "codex"), {
    name: "web_search",
    kind: "read",
    level: null,
    server: null,
    harness: "codex",
  });
});

test("a call of Cursor's own tool reads by the kind its event names", () => {
  assert.deepEqual(classifyToolCall(call("shell", { command: "ls" }), "cursor"), {
    name: "shell",
    kind: "execute",
    level: "local",
    server: null,
    harness: "cursor",
  });
  assert.equal(classifyToolCall(call("read", { path: "/home/a_1/a.md" }), "cursor").kind, "read");
  assert.equal(classifyToolCall(call("edit", { path: "/home/a_1/a.md" }), "cursor").kind, "write");
  assert.equal(classifyToolCall(call("await"), "cursor").kind, "execute");
  assert.equal(classifyToolCall(call("getMcpTools"), "cursor").level, null);
});

test("a call of Antigravity's own tool reads by its name, its MCP call by the server it names", () => {
  assert.deepEqual(classifyToolCall(call("run_command", { CommandLine: "ls" }), "antigravity"), {
    name: "run_command",
    kind: "execute",
    level: "local",
    server: null,
    harness: "antigravity",
  });
  assert.equal(classifyToolCall(call("write_to_file", { TargetFile: "a.py" }), "antigravity").kind, "write");
  assert.deepEqual(
    classifyToolCall(call("call_mcp_tool", { ServerName: "notion", ToolName: "search" }), "antigravity"),
    { name: "call_mcp_tool", kind: "connected", level: null, server: "notion", harness: "antigravity" },
  );
  assert.equal(classifyToolCall(call("call_mcp_tool"), "antigravity").server, null);
});

test("a harness's call of another MCP server's tool reads as connected, with the server its name carries", () => {
  assert.deepEqual(classifyToolCall(call("mcp__notion__search"), "claude-code"), {
    name: "mcp__notion__search",
    kind: "connected",
    level: null,
    server: "notion",
    harness: "claude-code",
  });
  assert.equal(classifyToolCall(call("mcp__notion__search"), "codex").server, "notion");
  assert.deepEqual(classifyToolCall(call("mcp_notion_search"), "antigravity"), {
    name: "mcp_notion_search",
    kind: "connected",
    level: null,
    server: null,
    harness: "antigravity",
  });
});

test("a harness's table applies only to its own rows", () => {
  assert.equal(classifyToolCall(call("Bash", { command: "ls" }), null).kind, "unknown", "no harness");
  assert.equal(classifyToolCall(call("shell"), "claude-code").kind, "unknown", "another harness's");
  assert.equal(classifyToolCall(call("run_command"), "cursor").kind, "unknown");
});

test("a harness's call never reads as the guild tool it shares a name with", () => {
  const info = classifyToolCall(call("note_write", { key: "plan.md" }), "cursor", null, run);
  assert.deepEqual(info, { name: "note_write", kind: "unknown", level: null, server: null, harness: "cursor" });
  assert.equal(isMutation(info), false);
  assert.equal(isScriptRun(classifyToolCall(call("script_run"), "cursor")), false);
  assert.equal(classifyToolCall(call("notion_search"), "cursor", null, run).kind, "unknown");
});
