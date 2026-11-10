import assert from "node:assert/strict";
import { test } from "node:test";
import { revisionDisplayPath } from "../../src/artifacts/paths.js";
import type { ArtifactOrTombstoneRow } from "../../src/db/artifacts.js";
import type { FileChangeView } from "../../src/db/file-changes.js";
import { StudioNotFoundError } from "../../src/studio/errors.js";
import { formatFileFocus, type FocusFile } from "../../src/studio/focus-file.js";
import { artifactRow } from "../helpers/artifacts.js";
import {
  curator,
  focusTables,
  isUnprocessable,
  memoryFocusTables,
  resolveFocus,
  type FileChangeRecord,
} from "../helpers/focus.js";

// A file pin: the file a display path names, with its recorded changes, quoted to the coach.

test("a file pin on an agent's Task quotes the Task", async () => {
  const resolved = await resolveFocus(focusTables(), {
    kind: "file",
    display_path: "org/org_1/agents/a_1/task.md",
  });
  assert.equal(resolved.focus.kind, "file");
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.display_path, "org/org_1/agents/a_1/task.md");
  assert.equal(resolved.focus.change_id, null);
  assert.equal(resolved.focus.label, "File · task.md");
  assert.match(resolved.content, /task org\/org_1\/agents\/a_1\/task\.md \(v3\)\./);
  assert.match(resolved.content, /No recorded change history for this path\./);
  assert.match(resolved.content, /Keep the digest\./);
});

function change(overrides: Partial<FileChangeRecord> = {}): FileChangeRecord {
  return {
    id: "fc_1",
    artifact_id: "art_1",
    task_agent_id: null,
    display_path: "org/org_1/agents/a_1/scripts/calc",
    operation: "update",
    version: 2,
    actor_type: "run",
    actor_id: "r_1",
    actor_name: "curator",
    run_id: "r_1",
    tool_call_id: "call_9",
    tool_name: "script_write",
    run_kind: "schedule",
    created_at: "2026-11-10T09:30:00.000Z",
    ...overrides,
  };
}

const SCRIPT_PATH = "org/org_1/agents/a_1/scripts/calc";

const script = (overrides: Partial<ArtifactOrTombstoneRow> = {}): ArtifactOrTombstoneRow => ({
  ...artifactRow({
    agent_id: "a_1",
    kind: "script",
    path: "scripts",
    key: "calc",
    content_text: "print(1)",
    version: 2,
  }),
  deleted_at: null,
  ...overrides,
});

test("a file pin on an agent's script quotes it with its latest change and the writing run", async () => {
  const resolved = await resolveFocus(
    focusTables({
      artifacts: [script()],
      changes: [change(), change({ id: "fc_0", version: 1, operation: "create" })],
    }),
    { kind: "file", display_path: SCRIPT_PATH },
  );
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.equal(resolved.focus.change_id, "fc_1");
  assert.equal(resolved.focus.run_id, "r_1");
  assert.equal(resolved.focus.call_id, "call_9");
  assert.equal(resolved.focus.tool_name, "script_write");
  assert.equal(resolved.focus.label, "File · calc");
  assert.match(resolved.content, /script org\/org_1\/agents\/a_1\/scripts\/calc \(v2\)\./);
  assert.match(
    resolved.content,
    /Latest change: update to v2 by run r_1 \(schedule wake-up\) via script_write at /,
  );
  assert.match(resolved.content, /2 recorded changes in total\./);
  assert.match(resolved.content, /print\(1\)/);
  assert.match(
    resolved.content,
    /The writing run: studio_get_run\(run_id="r_1"\); its tool call id is call_9\./,
  );
});

test("a file pin on one change names that change", async () => {
  const resolved = await resolveFocus(
    focusTables({
      artifacts: [script()],
      changes: [
        change(),
        change({
          id: "fc_0",
          version: 1,
          operation: "create",
          actor_type: "user",
          actor_name: "operator",
          run_id: null,
          tool_call_id: null,
        }),
      ],
    }),
    { kind: "file", display_path: SCRIPT_PATH, change_id: "fc_0" },
  );
  assert.equal(resolved.focus.change_id, "fc_0");
  assert.equal(resolved.focus.run_id, null);
  assert.match(resolved.content, /Focused change: create to v1 by user operator at /);
  assert.doesNotMatch(resolved.content, /The writing run/);
});

test("a file pin on a deleted object quotes its fields and says it is deleted", async () => {
  const deleted = script({
    kind: "object",
    collection_id: "col_1",
    collection_name: "leads",
    content_text: null,
    content_json: { total: 3 },
    deleted_at: "2026-11-10T10:00:00.000Z",
  } as never);
  const resolved = await resolveFocus(focusTables({ artifacts: [deleted] }), {
    kind: "file",
    display_path: SCRIPT_PATH,
  });
  assert.match(
    resolved.content,
    /object \(deleted\) org\/org_1\/agents\/a_1\/scripts\/calc \(v2\)\./,
  );
  assert.match(resolved.content, /"total": 3/);
});

test("a file pin on an archived Memory revision quotes the archived text", async () => {
  const displayPath = revisionDisplayPath("org_1", "a_1", "20261109T080000Z-operator.md");
  const resolved = await resolveFocus(memoryFocusTables(), {
    kind: "file",
    display_path: displayPath,
  });
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.match(resolved.content, new RegExp(`memory_revision ${displayPath}\\.`));
  assert.match(resolved.content, /Content:\nold line/);
});

test("a file pin on an organisation note in reach takes its agent from the pin", async () => {
  const note = {
    ...artifactRow({ key: "brief.md", content_text: "Cite the source." }),
    deleted_at: null,
  };
  const data = focusTables({ artifacts: [note], inGuildScope: true });
  const pinned = await resolveFocus(data, {
    kind: "file",
    display_path: "org/org_1/brief.md",
    agent_id: "a_1",
  });
  assert.equal(pinned.focus.agent_id, "a_1");
  assert.equal(pinned.focus.agent_name, "curator");
  assert.match(pinned.content, /note org\/org_1\/brief\.md \(v1\)\./);
  const unpinned = await resolveFocus(data, { kind: "file", display_path: "org/org_1/brief.md" });
  assert.equal(unpinned.focus.agent_id, null);
  assert.equal(unpinned.focus.agent_name, null);
  const foreign = await resolveFocus(data, {
    kind: "file",
    display_path: "org/org_1/brief.md",
    agent_id: "a_far",
  });
  assert.equal(foreign.focus.agent_id, null);
});

test("a file pin refuses a pin without a path, a collection, and a change the path does not have", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "file" }),
    isUnprocessable("focus file needs a display_path"),
  );
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "file", display_path: "org/org_1/collections/leads" }),
    isUnprocessable("focus on a collection is not supported; pick a record"),
  );
  await assert.rejects(
    resolveFocus(focusTables(), {
      kind: "file",
      display_path: "org/org_1/agents/a_1/task.md",
      change_id: "fc_gone",
    }),
    isUnprocessable("focus file change not found"),
  );
});

test("a file pin refuses a file of an agent outside the source guild", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "file", display_path: "org/org_1/agents/a_far/task.md" }),
    StudioNotFoundError,
  );
});

test("a file pin refuses an organisation file outside the source guild's reach", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "file", display_path: "org/org_1/brief.md" }),
    isUnprocessable("focus file is not in the source guild's reach"),
  );
});

test("a file pin refuses a path of another organisation", async () => {
  await assert.rejects(
    resolveFocus(focusTables(), { kind: "file", display_path: "org/org_2/brief.md" }),
    isUnprocessable("artifact is not in this organisation"),
  );
});

/** A recorded change as the file-change history shows it. */
function fileChange(overrides: Partial<FileChangeView> = {}): FileChangeView {
  return {
    id: "fc_1",
    artifact_id: "art_1",
    task_agent_id: null,
    display_path: "org/org_1/brief.md",
    operation: "update",
    version: 2,
    actor: { type: "run", id: "r_1", name: "curator" },
    run: null,
    tool: null,
    studio: null,
    created_at: "2026-11-10T09:30:00.000Z",
    ...overrides,
  };
}

const note: FocusFile = {
  owner: null,
  kind: "note",
  deleted: false,
  version: 2,
  content: "Cite the source.",
};

test("format_file_focus_on_no_agent_stores_no_agent", () => {
  const resolved = formatFileFocus({
    displayPath: "org/org_1/brief.md",
    file: note,
    agent: null,
    changes: [],
    pinnedChange: null,
  });
  assert.equal(resolved.focus.agent_id, null);
  assert.equal(resolved.focus.agent_name, null);
  assert.equal(resolved.focus.change_id, null);
  assert.equal(resolved.focus.run_id, null);
  assert.equal(resolved.focus.label, "File · brief.md");
  assert.match(
    resolved.content,
    /note org\/org_1\/brief\.md \(v2\)\.\nNo recorded change history for this path\.\n\nContent:/,
  );
  assert.match(
    resolved.content,
    /Full change history: studio_list_file_changes\(display_path="org\/org_1\/brief\.md"\)\.$/,
  );
  assert.doesNotMatch(resolved.content, /change_id=/);
});

test("format_file_focus_says_a_deleted_file_is_deleted_and_leaves_out_a_missing_version", () => {
  const resolved = formatFileFocus({
    displayPath: "org/org_1/brief.md",
    file: { ...note, deleted: true, version: null },
    agent: curator,
    changes: [],
    pinnedChange: null,
  });
  assert.equal(resolved.focus.agent_id, "a_1");
  assert.match(resolved.content, /note \(deleted\) org\/org_1\/brief\.md\./);
  assert.match(resolved.content, /kind="note \(deleted\)"/);
});

test("format_file_focus_names_a_run_change_without_a_tool_by_its_actor", () => {
  const resolved = formatFileFocus({
    displayPath: "org/org_1/brief.md",
    file: note,
    agent: null,
    changes: [fileChange()],
    pinnedChange: null,
  });
  assert.match(
    resolved.content,
    /Latest change: update to v2 by run r_1 at 2026-11-10T09:30:00\.000Z\./,
  );
  assert.doesNotMatch(resolved.content, /recorded changes in total/);
});

test("format_file_focus_points_at_the_writing_run_without_a_tool_call", () => {
  const run = {
    id: "r_2",
    agent_id: "a_1",
    guild_id: "guild_1",
    org_id: "org_1",
    kind: "group" as const,
    status: "completed",
    schedule_id: null,
    created_at: null,
  };
  const resolved = formatFileFocus({
    displayPath: "org/org_1/brief.md",
    file: note,
    agent: null,
    changes: [fileChange({ run })],
    pinnedChange: null,
  });
  assert.equal(resolved.focus.run_id, "r_2");
  assert.equal(resolved.focus.call_id, null);
  assert.match(resolved.content, /by run r_2 \(group delivery\) at /);
  assert.match(resolved.content, /The writing run: studio_get_run\(run_id="r_2"\)\.$/);
  assert.match(resolved.content, /change_run_kind="group"/);
});
