import assert from "node:assert/strict";
import { test } from "node:test";
import type { StateItemRow } from "../../../api/types";
import type { Proposal } from "../pendingModel";
import {
  actorShare,
  filterStateRows,
  findStateRow,
  isAwaitingApproval,
  itemSize,
  itemsAwaitingApproval,
  linkLabel,
  readHow,
  stateFlagLabels,
} from "./stateModel";

function row(path: string, overrides: Partial<StateItemRow> = {}): StateItemRow {
  return {
    display_path: path,
    kind: "note",
    level: "guild",
    owner_id: "g",
    title: path.split("/").pop() ?? path,
    size: 10,
    version: 1,
    created_by: "operator",
    created_at: "2026-10-19T10:00:00Z",
    collection_id: null,
    changes: 0,
    reads: 0,
    top_writer: null,
    top_reader: null,
    writers: 0,
    last_change: null,
    flags: [],
    ...overrides,
  };
}

const proposal = (state: Proposal["state"], target: Record<string, unknown>): Proposal =>
  ({
    seq: 1,
    state,
    widget: { kind: "edit", edit: { kind: "note", target } },
  }) as unknown as Proposal;

test("flags read as words, with needs approval first when a request waits", () => {
  const flagged = row("a", {
    writers: 3,
    flags: ["writers", "no_agent_read", "deletes_others_rows", "untouched"],
  });
  assert.deepEqual(stateFlagLabels(flagged, true), [
    "needs approval",
    "3 writers",
    "no agent read it",
    "deletes another agent's rows",
    "untouched",
  ]);
  assert.deepEqual(stateFlagLabels(row("a"), false), []);
});

test("open requests mark notes by path and tables by id", () => {
  const waiting = itemsAwaitingApproval([
    proposal("open", { display_path: "org/o/guilds/g/a.md" }),
    proposal("open", { collection_id: "col_1" }),
    proposal("decided", { display_path: "org/o/guilds/g/b.md" }),
    { seq: 2, state: "open", widget: { kind: "draft" } } as unknown as Proposal,
  ]);
  assert.deepEqual([...waiting].sort(), ["col_1", "org/o/guilds/g/a.md"]);
  assert.ok(isAwaitingApproval(row("org/o/guilds/g/a.md"), waiting));
  assert.ok(isAwaitingApproval(row("t", { kind: "table", collection_id: "col_1" }), waiting));
  assert.equal(isAwaitingApproval(row("org/o/guilds/g/b.md"), waiting), false);
});

test("a selection names an item by path or a table by id", () => {
  const rows = [row("a"), row("t", { collection_id: "col_1" })];
  assert.equal(findStateRow(rows, "a")?.display_path, "a");
  assert.equal(findStateRow(rows, "col_1")?.display_path, "t");
  assert.equal(findStateRow(rows, undefined), null);
  assert.equal(findStateRow(rows, "gone"), null);
});

test("filters keep flagged or waiting items and search words, in the order asked", () => {
  const rows = [
    row("org/o/a.md", {
      title: "alpha",
      changes: 1,
      reads: 5,
      last_change: { at: "2026-10-19T09:00:00Z", actor: { kind: "person", id: "u", name: "u" } },
    }),
    row("org/o/b.md", { title: "beta", changes: 3, flags: ["untouched"] }),
    row("org/o/c.md", { title: "gamma", changes: 3 }),
  ];
  const none = { needsLook: false, query: "", waiting: new Set<string>() };
  const names = (sorted: StateItemRow[]) => sorted.map((item) => item.title);
  assert.deepEqual(names(filterStateRows(rows, none, { key: "changes", descending: true })), [
    "beta",
    "gamma",
    "alpha",
  ]);
  assert.deepEqual(names(filterStateRows(rows, none, { key: "name", descending: false })), [
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.deepEqual(names(filterStateRows(rows, none, { key: "reads", descending: true })), [
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.deepEqual(names(filterStateRows(rows, none, { key: "last", descending: true })), [
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.deepEqual(
    names(
      filterStateRows(
        rows,
        { ...none, needsLook: true, waiting: new Set(["org/o/c.md"]) },
        { key: "name", descending: false },
      ),
    ),
    ["beta", "gamma"],
  );
  assert.deepEqual(
    names(filterStateRows(rows, { ...none, query: " GAM" }, { key: "name", descending: false })),
    ["gamma"],
  );
});

test("sizes, shares, reads and links read as words", () => {
  assert.equal(itemSize({ kind: "table", size: 1 }), "1 record");
  assert.equal(itemSize({ kind: "table", size: 4 }), "4 records");
  assert.equal(itemSize({ kind: "note", size: 900 }), "900 B");
  assert.equal(itemSize({ kind: "note", size: 2048 }), "2.0 KB");
  assert.equal(itemSize({ kind: "note", size: 20480 }), "20 KB");
  assert.equal(actorShare(null), "—");
  assert.equal(
    actorShare({ actor: { kind: "agent", id: "a", name: "scout" }, share: 0.5 }),
    "scout · 50%",
  );
  assert.equal(readHow("embed"), "embedded in its Task");
  assert.equal(readHow("custom"), "custom");
  assert.equal(linkLabel(null, "s"), null);
  assert.equal(
    linkLabel({ kind: "run", run_id: "r", agent_id: "a", call_id: null }, "s"),
    "Open step",
  );
  assert.equal(linkLabel({ kind: "coach", session_id: "s", seq: 4 }, "s"), "Coach message #4");
  assert.equal(
    linkLabel({ kind: "coach", session_id: "t", seq: 4 }, "s"),
    "Coach message in another session",
  );
});
