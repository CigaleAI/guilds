import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codeTaskStatus,
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
import type {
  BrowserUsageMetadata,
  MessageMetadata,
  RunMessage,
  ToolCall,
} from "../../../api/types/runs";

/** A tool call as the model makes it, its arguments the JSON text given. */
function toolCall(name: string, args: string): ToolCall {
  return { id: "c1", type: "function", function: { name, arguments: args } };
}

/** A tool call whose arguments are the JSON of an object. */
function callWith(name: string, args: Record<string, unknown>): ToolCall {
  return toolCall(name, JSON.stringify(args));
}

/** A recorded tool result with its body and metadata. */
function toolResult(content: string, metadata: MessageMetadata): RunMessage {
  return {
    id: 1,
    seq: 1,
    payload: { role: "tool", tool_call_id: "c1", content },
    metadata,
    created_at: "2026-09-21T08:00:00Z",
    cost_usd: null,
  };
}

/** What a browse call spent, its total `cost_usd`. */
function browserUsage(cost_usd: number): BrowserUsageMetadata {
  return {
    model: "m",
    jev_input_tokens: 0,
    jev_output_tokens: 0,
    jev_cost_usd: 0,
    llm_input_tokens: 0,
    llm_output_tokens: 0,
    llm_cost_usd: 0,
    cost_usd,
  };
}

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

test("parseToolArgs reads the JSON object the text holds, and is empty otherwise", () => {
  assert.deepEqual(parseToolArgs('{"path":"a.md"}'), { path: "a.md" });
  assert.deepEqual(parseToolArgs("not json"), {});
  assert.deepEqual(parseToolArgs("[1]"), {});
  assert.deepEqual(parseToolArgs(""), {});
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
  assert.deepEqual(formatToolArgs("[1]"), { isEmpty: false, text: "[\n  1\n]", parsed: [1] });
  assert.equal(formatToolArgs('"text"').parsed, null);
  assert.equal(formatToolArgs("").isEmpty, true);
});

test("toolResultError prefers metadata and falls back to the ERROR body", () => {
  assert.equal(toolResultError(null), null);
  assert.equal(toolResultError(toolResult("fine", { error: null })), null);
  assert.equal(toolResultError(toolResult("fine", { error: "boom" })), "boom");
  assert.equal(
    toolResultError(toolResult("ERROR: unknown tool x\nmore\n\nremaining_tool_calls: 3", {})),
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
  assert.equal(previewText("  a\n\nb   c  "), "a b c");
  assert.equal(previewText("abcdefghij", 5), "abcd…");
});

test("friendlyToolCall summarises known calls and falls back to a single short argument", () => {
  const friendly = (name: string, args: string) => friendlyToolCall(toolCall(name, args));
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

test("a known tool's call whose arguments do not fit its schema reads as its name", () => {
  assert.equal(friendlyToolCall(callWith("file_read", { path: 7 })), "");
  assert.equal(friendlyToolCall(callWith("shell", { command: "ls", background: "yes" })), "");
  assert.equal(summarizeCalls([callWith("record_update", { id: "42" })]), "record_update");
});

test("code tools read as the command, the file, or the background job they touch", () => {
  const call = (name: string, args: Record<string, unknown>) =>
    friendlyToolCall(callWith(name, args));
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
  const call = (args: Record<string, unknown>) => friendlyToolCall(callWith("browse", args));
  assert.equal(
    call({ task: "find the price", start: "https://example.com" }),
    "Browse from https://example.com",
  );
  assert.equal(call({ task: "find the price" }), "Browse");
});

test("summarizeCalls names what a batch did, merging calls that share a verb", () => {
  const call = callWith;
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
  assert.equal(toolOutcome(undefined), "");
});

test("a browse call ends with its status when it did not complete, and its cost", () => {
  assert.equal(
    toolOutcome({ tool_name: "browse", status: "complete", browser_usage: browserUsage(0.0123) }),
    "$0.01",
  );
  assert.equal(
    toolOutcome({ tool_name: "browse", status: "needs_login", browser_usage: browserUsage(0.004) }),
    "needs login · $0.0040",
  );
  assert.equal(toolOutcome({ tool_name: "browse", status: "cancelled" }), "cancelled");
});

test("a code task reads by its repository and session, and ends with its status and diffstat", () => {
  const call = (args: Record<string, unknown>) => callWith("code_task", args);
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
