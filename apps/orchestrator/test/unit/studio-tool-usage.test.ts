import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentToolEntries,
  buildToolRows,
  nativeGroup,
  parseToolCursor,
  TOOL_ARGUMENT_CHARS,
  viewToolCall,
  type ToolEntry,
} from "../../src/studio/tool-usage.js";
import { AGENT_CONFIG } from "../helpers/generation.js";

const access = {
  native_tools: ["note_get", "memory_write", "script_run"],
  scripts: [
    { name: "tally", description: "Counts rows", parameters: { type: "object" } },
    { name: "notes_only", description: "No parameters", parameters: null },
  ],
  secrets: [],
  connections: [
    {
      id: "conn_1",
      server: { id: "srv_1", slug: "notion", display_name: "Notion" },
      owner_scope: "guild",
      owner_id: "guild_1",
      account_hint: "",
      status: "connected",
      server_enabled: true,
      offered_tools: ["notion_search"],
      tools: [
        { name: "notion_search", remote_name: "search", description: "Search pages", read_only: true },
        { name: "notion_create", remote_name: "create", description: "Create a page", read_only: false },
      ],
    },
  ],
};

test("a native tool's group is the family its name starts with", () => {
  assert.equal(nativeGroup("note_get"), "note");
  assert.equal(nativeGroup("shell"), "shell");
  assert.equal(nativeGroup("_odd"), "_odd");
});

test("an agent's entries follow its switches: scripts as tools, Memory, and withheld connection tools", () => {
  const entries = agentToolEntries({ id: "a_1", config: { ...AGENT_CONFIG, scripting: true, memory: true } }, access);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("note_get")?.source, "native");
  assert.equal(byName.get("memory_write")?.offered, true);
  assert.equal(byName.get("tally")?.source, "script");
  assert.equal(byName.get("tally")?.offered, true);
  assert.equal(byName.has("notes_only"), false);
  assert.equal(byName.get("notion_search")?.group, "Notion");
  assert.equal(byName.get("notion_search")?.serverId, "srv_1");
  assert.equal(byName.get("notion_create")?.offered, false);
  assert.ok(byName.has("report_issue"));

  const quiet = agentToolEntries({ id: "a_2", config: { ...AGENT_CONFIG, scripting: false, memory: false } }, access);
  const names = quiet.filter((entry) => entry.offered).map((entry) => entry.name);
  assert.equal(names.includes("script_run"), false);
  assert.equal(names.includes("memory_write"), false);
  assert.equal(names.includes("tally"), false);
});

test("tool rows join what each agent is offered with its calls, keeping tools no longer offered", () => {
  const entry = (name: string, agentId: string, offered: boolean, source: ToolEntry["source"] = "native"): ToolEntry => ({
    name,
    source,
    group: nativeGroup(name),
    description: `${name} does things`,
    serverId: source === "connector" ? "srv_1" : null,
    agentId,
    offered,
  });
  const rows = buildToolRows(
    [entry("note_get", "a_1", true), entry("note_get", "a_2", true), entry("notion_create", "a_1", false, "connector")],
    [
      { tool_name: "note_get", agent_id: null, calls: "3", errors: "1", median_ms: "200", last_at: new Date("2026-10-19T10:00:00Z") },
      { tool_name: "note_get", agent_id: "a_1", calls: "3", errors: "1", median_ms: "200", last_at: new Date("2026-10-19T10:00:00Z") },
      { tool_name: "report_issue", agent_id: null, calls: "1", errors: "0", median_ms: null, last_at: null },
      { tool_name: "report_issue", agent_id: "a_3", calls: "1", errors: "0", median_ms: null, last_at: null },
      { tool_name: "gone_tool", agent_id: null, calls: "2", errors: "2", median_ms: "5", last_at: null },
      { tool_name: "gone_tool", agent_id: "a_1", calls: "2", errors: "2", median_ms: "5", last_at: null },
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ["gone_tool", "note_get", "report_issue"],
  );
  const noteGet = rows[1];
  assert.deepEqual(noteGet?.offered_to, ["a_1", "a_2"]);
  assert.equal(noteGet?.calls, 3);
  assert.equal(noteGet?.median_ms, 200);
  assert.equal(noteGet?.last_at, "2026-10-19T10:00:00.000Z");
  assert.deepEqual(
    noteGet?.agents.map((usage) => [usage.agent_id, usage.offered, usage.calls]),
    [
      ["a_1", true, 3],
      ["a_2", true, 0],
    ],
  );
  assert.equal(rows[0]?.source, null);
  assert.deepEqual(rows[0]?.offered_to, []);
  assert.equal(rows[2]?.source, "native");
  assert.ok(rows[2]?.description);
  assert.deepEqual(rows[2]?.agents, [{ agent_id: "a_3", offered: false, calls: 1, errors: 0, median_ms: null, last_at: null }]);
});

test("a page cursor is the last call's time and id, and anything else is refused", () => {
  assert.equal(parseToolCursor(null), null);
  assert.deepEqual(parseToolCursor("2026-10-19T10:00:00.000Z~42"), { at: new Date("2026-10-19T10:00:00.000Z"), id: 42 });
  assert.throws(() => parseToolCursor("yesterday~42"), /cursor/);
  assert.throws(() => parseToolCursor("2026-10-19T10:00:00.000Z~x"), /cursor/);
});

test("a call shows its status and a short preview of its arguments", () => {
  const long = "x".repeat(TOOL_ARGUMENT_CHARS + 10);
  const failed = viewToolCall({
    id: 1,
    created_at: "2026-10-19T10:00:00.000Z",
    agent_id: "a_1",
    run_id: "r_1",
    call_id: "c_1",
    seq: 4,
    arguments: long,
    error: "boom",
    duration_ms: "12",
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "boom");
  assert.equal(failed.seq, 4);
  assert.equal(failed.duration_ms, 12);
  assert.equal(failed.arguments.length, TOOL_ARGUMENT_CHARS + 1);
  const fine = viewToolCall({
    id: 2,
    created_at: "2026-10-19T10:00:00.000Z",
    agent_id: "a_1",
    run_id: "r_1",
    call_id: null,
    seq: 5,
    arguments: null,
    error: "",
    duration_ms: null,
  });
  assert.equal(fine.status, "ok");
  assert.equal(fine.arguments, "");
  assert.equal(fine.call_id, null);
  assert.equal(fine.duration_ms, null);
});
