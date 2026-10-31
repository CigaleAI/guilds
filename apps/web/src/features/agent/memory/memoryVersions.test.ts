import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryVersion } from "../../../api/types/notes";
import { memoryAuthorLabel, memoryChangeLabel, memoryVersionId, memoryVersionName } from "./memoryVersions";

function version(overrides: Partial<MemoryVersion> = {}): MemoryVersion {
  return {
    index: 3,
    revision_id: "mrev_1",
    archive_display_path: "org/o/agents/a/history-archive/old.md",
    written_at: "2026-09-20T10:00:00.000Z",
    actor: { type: "user", id: "user_1", name: "manu", detail: "" },
    run_id: null,
    content: "live",
    content_hash: "hash",
    previous_content: "old",
    stats: { added: 1, removed: 2 },
    run: null,
    ...overrides,
  };
}

test("memoryVersionId is live when there is no revision", () => {
  assert.equal(memoryVersionId(version({ revision_id: null })), "live");
  assert.equal(memoryVersionId(version()), "mrev_1");
});

test("memoryVersionName marks the live version", () => {
  assert.equal(memoryVersionName(version({ revision_id: null })), "v3 · live");
  assert.equal(memoryVersionName(version()), "v3");
});

test("memoryAuthorLabel names a run by kind, or a run when the kind is gone", () => {
  assert.equal(
    memoryAuthorLabel(
      version({
        actor: { type: "run", id: "r_1", name: "r_1", detail: "" },
        run: { id: "r_1", exists: true, kind: "schedule" },
      }),
    ),
    "routine wake-up",
  );
  assert.equal(
    memoryAuthorLabel(
      version({
        actor: { type: "run", id: "r_1", name: "r_1", detail: "" },
        run: { id: "r_1", exists: false },
      }),
    ),
    "a run",
  );
});

test("memoryAuthorLabel uses a person or agent name and falls back to the type", () => {
  assert.equal(memoryAuthorLabel(version()), "manu");
  assert.equal(
    memoryAuthorLabel(version({ actor: { type: "agent", id: "a_1", name: null, detail: null } })),
    "agent",
  );
  assert.equal(
    memoryAuthorLabel(version({ actor: { type: "unknown", id: null, name: null, detail: null } })),
    "unknown author",
  );
});

test("memoryChangeLabel describes the oldest version, an unchanged one, and a delta", () => {
  assert.equal(memoryChangeLabel(version({ previous_content: null })), "oldest on record");
  assert.equal(memoryChangeLabel(version({ stats: { added: 0, removed: 0 } })), "unchanged");
  assert.equal(memoryChangeLabel(version()), "+1 −2");
});
