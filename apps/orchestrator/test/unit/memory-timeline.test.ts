import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoryTimeline, lineChangeStats, memoryDiffText } from "../../src/artifacts/memory-timeline.js";

const v0 = "- keep it short (operator)\n- notes live under research/\n- nothing yet";
const v1 = "- keep it short (operator)\n- notes live under research/\n- draft the digest";
const v2 =
  "- keep it short (operator)\n- never post twice (run r_1)\n- notes live under research/\n- digest sent";

function revision(
  id: string,
  content: string,
  at: string,
  by: { type: "user" | "agent" | "run"; id: string; name: string; detail: string },
) {
  return {
    id,
    content,
    display_path: `org/org_1/agents/a_1/history-archive/${id}.md`,
    replaced_at: at,
    replaced_by: by,
  };
}

test("timeline pairs each archived body with the actor that replaced it", () => {
  const entries = buildMemoryTimeline({
    live: { content: v2 },
    revisions: [
      revision("mrev_b", v1, "2026-09-20T10:00:00.000Z", {
        type: "run",
        id: "r_2",
        name: "r_2",
        detail: 'run r_2 (schedule wake-up: "digest")',
      }),
      revision("mrev_a", v0, "2026-09-19T10:00:00.000Z", {
        type: "user",
        id: "user_1",
        name: "manu",
        detail: "user manu (Files pane)",
      }),
    ],
  });
  assert.deepEqual(
    entries.map((entry) => entry.index),
    [2, 1, 0],
  );

  const live = entries[0]!;
  assert.equal(live.revision_id, null);
  assert.equal(live.archive_display_path, null);
  assert.equal(live.written_at, "2026-09-20T10:00:00.000Z");
  assert.equal(live.actor.type, "run");
  assert.equal(live.run_id, "r_2");
  assert.equal(live.content, v2);
  assert.equal(live.previous_content, v1);
  assert.deepEqual(live.stats, { added: 2, removed: 1 });

  const middle = entries[1]!;
  assert.equal(middle.revision_id, "mrev_b");
  assert.equal(middle.written_at, "2026-09-19T10:00:00.000Z");
  assert.equal(middle.actor.name, "manu");
  assert.equal(middle.run_id, null);
  assert.equal(middle.content, v1);
  assert.deepEqual(middle.stats, { added: 1, removed: 1 });

  const oldest = entries[2]!;
  assert.equal(oldest.revision_id, "mrev_a");
  assert.equal(oldest.actor.type, "unknown");
  assert.equal(oldest.written_at, null);
  assert.equal(oldest.previous_content, null);
  assert.deepEqual(oldest.stats, { added: 0, removed: 0 });
});

test("timeline with no revisions is the live version alone", () => {
  const entries = buildMemoryTimeline({ live: { content: v0 }, revisions: [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.index, 0);
  assert.equal(entries[0]?.actor.type, "unknown");
});

test("timeline orders postgres and Z stamps of the same instant by revision id", () => {
  const entries = buildMemoryTimeline({
    live: { content: v2 },
    revisions: [
      revision("mrev_b", v1, "2026-09-19T10:00:00.000Z", {
        type: "run",
        id: "r_2",
        name: "r_2",
        detail: "",
      }),
      revision("mrev_a", v0, "2026-09-19T10:00:00+00:00", {
        type: "user",
        id: "user_1",
        name: "manu",
        detail: "",
      }),
    ],
  });
  assert.equal(entries[0]?.actor.type, "run");
  assert.equal(entries[1]?.actor.name, "manu");
  assert.equal(entries[2]?.actor.type, "unknown");
});

test("timeline with the same replaced_at orders by revision id", () => {
  const entries = buildMemoryTimeline({
    live: { content: v2 },
    revisions: [
      revision("mrev_b", v1, "2026-09-19T10:00:00.000Z", {
        type: "agent",
        id: "a_1",
        name: "writer",
        detail: "",
      }),
      revision("mrev_a", v0, "2026-09-19T10:00:00.000Z", {
        type: "user",
        id: "user_1",
        name: "manu",
        detail: "",
      }),
    ],
  });
  assert.equal(entries[2]?.content, v0);
  assert.equal(entries[1]?.content, v1);
});

test("timeline orders revisions by time regardless of input order", () => {
  const revisions = [
    revision("mrev_a", v0, "2026-09-19T10:00:00.000Z", {
      type: "agent",
      id: "a_1",
      name: "writer",
      detail: "",
    }),
    revision("mrev_b", v1, "2026-09-20T10:00:00.000Z", {
      type: "agent",
      id: "a_1",
      name: "writer",
      detail: "",
    }),
  ];
  const forward = buildMemoryTimeline({ live: { content: v2 }, revisions });
  const backward = buildMemoryTimeline({ live: { content: v2 }, revisions: [...revisions].reverse() });
  assert.deepEqual(forward, backward);
  assert.equal(forward[2]?.content, v0);
});

test("line stats count multiset differences and ignore blank lines", () => {
  assert.deepEqual(lineChangeStats("a\nb\n\n", "b\na\nc\n"), { added: 1, removed: 0 });
  assert.deepEqual(lineChangeStats("a\na\n", "a\n"), { added: 0, removed: 1 });
  assert.deepEqual(lineChangeStats(v0, v0), { added: 0, removed: 0 });
  assert.deepEqual(lineChangeStats(v0, v1), { added: 1, removed: 1 });
});

test("memory diff text lists removed and added lines", () => {
  const text = memoryDiffText(v1, v2);
  assert.match(text, /^- - draft the digest$/m);
  assert.match(text, /^\+ - never post twice \(run r_1\)$/m);
  assert.match(text, /^\+ - digest sent$/m);
  assert.equal(memoryDiffText(v0, v0), "");
});
