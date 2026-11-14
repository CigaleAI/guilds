import assert from "node:assert/strict";
import { test } from "node:test";
import type { StudioTool } from "../../../api/types/studio";
import { nativeToolSummary } from "./nativeToolSummary";

function tool(name: string, overrides: Partial<StudioTool> = {}): StudioTool {
  return {
    name,
    source: "native",
    group: name.split("_")[0] ?? name,
    description: "The catalog's description, written for the model.",
    server_id: null,
    offered_to: [],
    calls: 0,
    errors: 0,
    median_ms: null,
    last_at: null,
    agents: [],
    ...overrides,
  };
}

test("a native tool reads its own summary rather than the catalog's description", () => {
  assert.equal(nativeToolSummary(tool("note_get")), "Opens one note so the agent can read it.");
});

test("a native tool without a summary reads the catalog's description", () => {
  assert.equal(
    nativeToolSummary(tool("note_archive")),
    "The catalog's description, written for the model.",
  );
});

test("a script, connection, or no longer offered unknown tool has no summary", () => {
  assert.equal(nativeToolSummary(tool("weekly_digest", { source: "script" })), null);
  assert.equal(nativeToolSummary(tool("github_search", { source: "connector" })), null);
  assert.equal(nativeToolSummary(tool("gone", { source: null })), null);
});

test("every native tool's summary is one short sentence", () => {
  const names = [
    "note_find",
    "note_get",
    "note_write",
    "note_delete",
    "record_search",
    "record_list",
    "record_add",
    "record_update",
    "record_remove",
    "file_find",
    "file_fetch",
    "file_put",
    "file_delete",
    "memory_write",
    "group_post",
    "report_issue",
    "script_create",
    "script_list",
    "script_read",
    "script_run",
    "script_delete",
    "schedule_create_cron",
    "schedule_create_window",
    "schedule_list",
    "schedule_update",
    "schedule_pause",
    "schedule_resume",
    "schedule_delete",
    "browse",
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_fill",
    "browser_scroll",
    "browser_screenshot",
    "browser_eval",
    "shell",
    "shell_status",
    "file_read",
    "code_search",
    "code_task",
    "secret_store",
    "secret_request",
    "wake_after",
    "wake_cancel",
  ];
  for (const name of names) {
    const summary = nativeToolSummary(tool(name, { description: "" }));
    assert.ok(summary, `${name} has a summary`);
    assert.ok(summary.length <= 100, `${name}'s summary is at most 100 characters`);
    assert.match(summary, /^[A-Z][^.]*\.$/, `${name}'s summary is one sentence`);
  }
});
