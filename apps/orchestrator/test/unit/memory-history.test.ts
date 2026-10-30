import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachRunsToMemoryEntries,
  firstMemoryWriteByRun,
  historyRunPayload,
} from "../../src/memory/history.js";
import type { MemoryTimelineEntry } from "../../src/artifacts/memory.js";

function entry(overrides: Partial<MemoryTimelineEntry> = {}): MemoryTimelineEntry {
  return {
    index: 1,
    revision_id: null,
    archive_display_path: null,
    written_at: "2026-09-20T10:00:00.000Z",
    actor: { type: "run", id: "r_1", name: "r_1", detail: "" },
    run_id: "r_1",
    content: "live",
    content_hash: "hash",
    previous_content: null,
    stats: { added: 0, removed: 0 },
    ...overrides,
  };
}

test("firstMemoryWriteByRun keeps the first tool per run and skips rows without a run or tool", () => {
  const calls = firstMemoryWriteByRun([
    { run: null, tool: { call_id: "call_x", name: "memory_write" } },
    { run: { id: "r_1" }, tool: null },
    {
      run: { id: "r_1" },
      tool: { call_id: "call_1", name: "memory_write" },
    },
    {
      run: { id: "r_1" },
      tool: { call_id: "call_2", name: "memory_write" },
    },
    {
      run: { id: "r_2" },
      tool: { call_id: "call_3", name: "note_write" },
    },
  ]);
  assert.deepEqual([...calls.entries()], [
    ["r_1", { call_id: "call_1", name: "memory_write" }],
    ["r_2", { call_id: "call_3", name: "note_write" }],
  ]);
});

test("historyRunPayload is null without a run id and marks a missing run as gone", () => {
  assert.equal(historyRunPayload(null, new Map(), new Map()), null);
  const missing = historyRunPayload("r_gone", new Map(), new Map());
  assert.deepEqual(missing, {
    id: "r_gone",
    exists: false,
    kind: null,
    status: null,
    schedule_id: null,
    created_at: null,
    memory_write: null,
  });
});

test("historyRunPayload attaches a live run and its memory_write call", () => {
  const payload = historyRunPayload(
    "r_1",
    new Map([
      [
        "r_1",
        {
          kind: "schedule",
          status: "completed",
          schedule_id: "sch_1",
          created_at: "2026-09-20T10:00:00.000Z",
        },
      ],
    ]),
    new Map([["r_1", { call_id: "call_1", name: "memory_write" }]]),
  );
  assert.equal(payload?.exists, true);
  assert.equal(payload?.kind, "schedule");
  assert.equal(payload?.created_at, "2026-09-20T10:00:00.000Z");
  assert.deepEqual(payload?.memory_write, { call_id: "call_1", name: "memory_write" });
});

test("attachRunsToMemoryEntries leaves operator versions without a run", () => {
  const attached = attachRunsToMemoryEntries(
    [
      entry(),
      entry({
        index: 0,
        run_id: null,
        actor: { type: "user", id: "user_1", name: "manu", detail: "" },
      }),
    ],
    new Map([["r_1", { kind: "direct", created_at: "2026-09-20T10:00:00.000Z" }]]),
    new Map(),
  );
  assert.equal(attached[0]?.run?.id, "r_1");
  assert.equal(attached[1]?.run, null);
});
