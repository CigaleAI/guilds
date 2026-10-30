import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codeTaskStatus,
  formatCost,
  formatDuration,
  formatReturnedData,
  formatTokens,
  formatToolArgs,
  friendlyToolCall,
  parseToolArgs,
  previewText,
  stripRemainingToolCalls,
  summarizeCalls,
  toolOutcome,
  toolResultError,
} from "./toolFormat";

test("stripRemainingToolCalls removes only the trailing budget stamp", () => {
  const wrapUp = "Wrap up and finish with text.";
  assert.equal(stripRemainingToolCalls("ok\n\nremaining_tool_calls: 12"), "ok");
  assert.equal(
    stripRemainingToolCalls("remaining_tool_calls: 12 is text"),
    "remaining_tool_calls: 12 is text",
  );
  assert.equal(
    stripRemainingToolCalls(`ok\n\n${wrapUp}\n\nremaining_tool_calls: 5`),
    `ok\n\n${wrapUp}`,
  );
});

test("parseToolArgs reads a JSON string or an object, and is empty otherwise", () => {
  assert.deepEqual(parseToolArgs('{"path":"a.md"}'), { path: "a.md" });
  assert.deepEqual(parseToolArgs({ path: "a.md" }), { path: "a.md" });
  assert.deepEqual(parseToolArgs("not json"), {});
  assert.deepEqual(parseToolArgs("[1]"), {});
  assert.deepEqual(parseToolArgs(""), {});
  assert.deepEqual(parseToolArgs(undefined), {});
});

test("formatToolArgs shows arguments as JSON, and what it cannot read as text", () => {
  assert.deepEqual(formatToolArgs('{"a":1}'), {
    isEmpty: false,
    text: '{\n  "a": 1\n}',
    parsed: { a: 1 },
  });
  assert.deepEqual(formatToolArgs("{}"), {
    isEmpty: true,
    text: "No arguments provided.",
    parsed: {},
  });
  assert.deepEqual(formatToolArgs("plain"), { isEmpty: false, text: "plain", parsed: null });
  assert.equal(formatToolArgs(null).isEmpty, true);
  assert.equal(formatToolArgs({ run: "a", at: new Date(0) }).parsed, null);
});

test("toolResultError prefers metadata and falls back to the ERROR body", () => {
  assert.equal(toolResultError(null), null);
  assert.equal(toolResultError({ payload: { content: "fine" }, metadata: { error: null } }), null);
  assert.equal(
    toolResultError({ payload: { content: "fine" }, metadata: { error: "boom" } }),
    "boom",
  );
  assert.equal(
    toolResultError({
      payload: { content: "ERROR: unknown tool x\nmore\n\nremaining_tool_calls: 3" },
      metadata: {},
    }),
    "unknown tool x",
  );
});

test("formatReturnedData detects JSON bodies and keeps text raw", () => {
  const json = formatReturnedData('{"a":1}');
  assert.equal(json.isJson, true);
  assert.deepEqual(json.raw, { a: 1 });
  const text = formatReturnedData("plain\ttsv");
  assert.equal(text.isJson, false);
  assert.equal(text.text, "plain\ttsv");
  assert.equal(formatReturnedData("").isEmpty, true);
});

test("compact formatters", () => {
  assert.equal(formatDuration(9), "9ms");
  assert.equal(formatDuration(1234), "1.2s");
  assert.equal(formatDuration(12_345), "12s");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(-1), "");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(3100), "3.1k");
  assert.equal(formatTokens(41_000), "41k");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.0031), "$0.0031");
  assert.equal(formatCost(0.12), "$0.12");
  assert.equal(formatCost("x"), "");
  assert.equal(previewText("  a\n\nb   c  "), "a b c");
  assert.equal(previewText("abcdefghij", 5), "abcd…");
});

test("friendlyToolCall summarises known calls and falls back to a single short argument", () => {
  const friendly = (name: string, args: string) =>
    friendlyToolCall({ function: { name, arguments: args } });
  assert.equal(friendly("note_find", '{"query":"thesis"}'), "Find notes thesis");
  assert.equal(friendly("memory_write", "{}"), "Write memory");
  assert.equal(
    friendly("studio_edit_routine", '{"action":"create","agent_id":"scout"}'),
    "Propose routine for scout",
  );
  assert.equal(friendly("studio_edit_routine", '{"action":"create"}'), "Propose routine");
  assert.equal(
    friendly("studio_edit_routine", '{"action":"edit","schedule_id":"sch_1"}'),
    "Propose routine changes",
  );
  assert.equal(
    friendly("studio_edit_routine", '{"action":"delete","schedule_id":"sch_1"}'),
    "Propose deleting a routine",
  );
  assert.equal(
    friendly("studio_edit_collection", '{"action":"create","name":"leads"}'),
    "Propose table leads",
  );
  assert.equal(
    friendly("studio_edit_collection", '{"action":"edit","collection":"leads"}'),
    "Propose changes to leads",
  );
  assert.equal(
    friendly("studio_edit_collection", '{"action":"delete","collection":"leads"}'),
    "Propose deleting leads",
  );
  assert.equal(
    friendly("studio_edit_note", '{"action":"create","key":"playbook.md"}'),
    "Propose note playbook.md",
  );
  assert.equal(
    friendly("studio_edit_note", '{"action":"edit","display_path":"x"}'),
    "Propose note edit",
  );
  assert.equal(
    friendly("studio_edit_note", '{"action":"delete","display_path":"x"}'),
    "Propose deleting a note",
  );
  assert.equal(friendly("record_search", '{"query":"acme"}'), "Search records acme");
  assert.equal(
    friendly("record_search", '{"collection":"customers","query":"acme"}'),
    "Search customers acme",
  );
  assert.equal(friendly("record_list", '{"collection":"customers"}'), "List customers");
  assert.equal(friendly("record_add", '{"collection":"customers","body":{}}'), "Add to customers");
  assert.equal(
    friendly("record_update", '{"collection":"customers","id":42,"body":{}}'),
    "Update customers/42",
  );
  assert.equal(
    friendly("record_remove", '{"collection":"customers","id":42}'),
    "Remove customers/42",
  );
  assert.equal(friendly("record_remove", "{}"), "Remove record");
  assert.equal(friendly("custom", '{"name":"one"}'), "name: one");
  assert.equal(friendly("custom", '{"a":1,"b":2}'), "");
});

test("code tools read as the command, the file, or the background job they touch", () => {
  const call = (name: string, args: Record<string, unknown>) =>
    friendlyToolCall({ function: { name, arguments: JSON.stringify(args) } });
  assert.equal(
    call("shell", { command: "npm test -- --watch=false\necho done" }),
    "Run npm test -- --watch=false",
  );
  assert.equal(call("shell", { command: "npm run dev", background: true }), "Start npm run dev");
  assert.equal(call("shell_status", {}), "List background commands");
  assert.equal(call("shell_status", { id: "b2", stop: true }), "Stop b2");
  assert.equal(
    call("file_read", { path: "src/app.ts", offset: 120 }),
    "Read src/app.ts from line 120",
  );
  assert.equal(
    call("code_search", { pattern: "refund", mode: "content", path: "src" }),
    'Search lines "refund" in src',
  );
  assert.equal(call("code_search", { pattern: "refund" }), 'Search files "refund"');
});

test("browse reads as where the delegated web task starts", () => {
  const call = (args: Record<string, unknown>) =>
    friendlyToolCall({ function: { name: "browse", arguments: JSON.stringify(args) } });
  assert.equal(
    call({ task: "find the price", start: "https://example.com" }),
    "Browse from https://example.com",
  );
  assert.equal(call({ task: "find the price" }), "Browse");
});

test("summarizeCalls names what a batch did, merging calls that share a verb", () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    function: { name, arguments: JSON.stringify(args) },
  });
  assert.equal(summarizeCalls([call("file_read", { path: "a.md" })]), "Read a.md");
  assert.equal(
    summarizeCalls([
      call("file_read", { path: "a.md" }),
      call("file_read", { path: "b.md" }),
      call("shell", { command: "ls" }),
    ]),
    "Read a.md, b.md · Run ls",
  );
  assert.equal(
    summarizeCalls([
      call("note_write", {}),
      call("note_write", {}),
      call("file_read", { path: "a.md" }),
    ]),
    "Wrote note · Read a.md",
  );
  assert.equal(
    summarizeCalls([call("group_post", {}), call("browser_snapshot", {})]),
    "Post to group · Read page snapshot",
  );
  assert.equal(summarizeCalls([call("custom", { a: 1, b: 2 }), null]), "custom · tool");
  assert.equal(
    summarizeCalls([call("custom", { a: 1, b: 2 }), call("custom", { a: 3, b: 4 })]),
    "custom",
  );
  assert.equal(summarizeCalls([]), "");
});

test("toolOutcome names a failing exit and a repeated read", () => {
  assert.equal(toolOutcome({ tool_name: "shell", exit_code: 0 }), "");
  assert.equal(toolOutcome({ tool_name: "shell", exit_code: 2 }), "exit 2");
  assert.equal(toolOutcome({ tool_name: "shell", exit_code: 124, timed_out: true }), "timed out");
  assert.equal(toolOutcome({ tool_name: "file_read", repeat_of: 14 }), "unchanged since step 14");
  assert.equal(toolOutcome(null), "");
});

test("a browse call ends with its status when it did not complete, and its cost", () => {
  assert.equal(
    toolOutcome({ tool_name: "browse", status: "complete", browser_usage: { cost_usd: 0.0123 } }),
    "$0.01",
  );
  assert.equal(
    toolOutcome({ tool_name: "browse", status: "needs_login", browser_usage: { cost_usd: 0.004 } }),
    "needs login · $0.0040",
  );
  assert.equal(toolOutcome({ tool_name: "browse", status: "cancelled" }), "cancelled");
});

test("a code task reads by its repository and session, and ends with its status and diffstat", () => {
  const call = (args: Record<string, unknown>) => ({
    id: "c1",
    function: { name: "code_task", arguments: JSON.stringify(args) },
  });
  assert.equal(friendlyToolCall(call({ brief: "Fix greet", repo: "app" })), "Code task in app");
  assert.equal(
    friendlyToolCall(call({ brief: "Go on", repo: "app", session_id: "s1" })),
    "Resume code task in app",
  );
  assert.equal(friendlyToolCall(call({ brief: "Fix greet" })), "Code task");
  const done = {
    tool_name: "code_task",
    status: "completed",
    files_changed: 2,
    insertions: 14,
    deletions: 3,
  };
  assert.equal(toolOutcome(done), "2 files · +14 −3");
  assert.equal(
    toolOutcome({ ...done, status: "timed_out", files_changed: 0 }),
    "timed out · no changes",
  );
  assert.equal(toolOutcome({ tool_name: "code_task", status: "failed" }), "failed");
  assert.equal(codeTaskStatus("interrupted"), "interrupted");
  assert.equal(codeTaskStatus("other"), "");
});
