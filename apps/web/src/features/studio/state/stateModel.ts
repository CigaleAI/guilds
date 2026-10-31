import type { StateFlag, StateItemRow, StateLink, StateShare } from "../../../api/types/studio";
import type { Proposal } from "../pendingModel";

/** The windows State offers, in hours: a day, three days, a week. */
export const STATE_WINDOW_HOURS: readonly number[] = [24, 72, 168];
export const STATE_DEFAULT_HOURS = 24;

const flagLabels: Record<StateFlag, (row: StateItemRow) => string> = {
  no_agent_read: () => "no agent read it",
  writers: (row) => `${row.writers} writers`,
  deletes_others_rows: () => "deletes another agent's rows",
  untouched: () => "untouched",
};

/** What stands out about an item, in words: its flags, with "needs approval" first when it waits. */
export function stateFlagLabels(row: StateItemRow, pending: boolean): string[] {
  return [
    ...(pending ? ["needs approval"] : []),
    ...row.flags.map((flag) => flagLabels[flag](row)),
  ];
}

/** The items an open coach request changes: notes by path, tables by id. */
export function itemsAwaitingApproval(proposals: readonly Proposal[]): Set<string> {
  const keys = proposals.flatMap((proposal) => {
    const widget = proposal.widget;
    if (proposal.state !== "open" || widget.kind !== "edit") return [];
    const target = widget.edit.target ?? {};
    return [target.display_path, target.collection_id].filter((key): key is string => Boolean(key));
  });
  return new Set(keys);
}

export function isAwaitingApproval(row: StateItemRow, waiting: ReadonlySet<string>): boolean {
  return (
    waiting.has(row.display_path) || Boolean(row.collection_id && waiting.has(row.collection_id))
  );
}

/** The row a selection names: a path, or a table's id. */
export function findStateRow(
  rows: readonly StateItemRow[],
  item: string | undefined,
): StateItemRow | null {
  if (!item) return null;
  return rows.find((row) => row.display_path === item || row.collection_id === item) ?? null;
}

export type StateSortKey = "name" | "changes" | "reads" | "last";

export type StateListFilters = { needsLook: boolean; query: string };

/** The column a list is sorted by, and its direction. */
export type StateSort = { key: StateSortKey; descending: boolean };

const sorters: Record<StateSortKey, (a: StateItemRow, b: StateItemRow) => number> = {
  name: (a, b) => a.title.localeCompare(b.title),
  changes: (a, b) => a.changes - b.changes,
  reads: (a, b) => a.reads - b.reads,
  last: (a, b) => (a.last_change?.at ?? "").localeCompare(b.last_change?.at ?? ""),
};

/** The rows the filters keep, in the order asked. */
export function filterStateRows(
  rows: readonly StateItemRow[],
  filters: StateListFilters,
  waiting: ReadonlySet<string>,
  sort: StateSort,
): StateItemRow[] {
  const query = filters.query.trim().toLowerCase();
  const flagged = (row: StateItemRow) => row.flags.length > 0 || isAwaitingApproval(row, waiting);
  const kept = rows.filter(
    (row) =>
      (!filters.needsLook || flagged(row)) &&
      `${row.title} ${row.display_path}`.toLowerCase().includes(query),
  );
  const direction = sort.descending ? -1 : 1;
  return kept.sort((a, b) => direction * sorters[sort.key](a, b) || a.title.localeCompare(b.title));
}

/** An actor as a list names it, with its share when it has one. */
export function actorShare(share: Pick<StateShare, "actor" | "share"> | null): string {
  return share ? `${share.actor.name} · ${Math.round(share.share * 100)}%` : "—";
}

/** A size as people read it: records for a table, bytes or KB for text. */
export function itemSize(row: Pick<StateItemRow, "kind" | "size">): string {
  if (row.kind === "table") return `${row.size} record${row.size === 1 ? "" : "s"}`;
  if (row.size < 1024) return `${row.size} B`;
  return `${(row.size / 1024).toFixed(row.size < 10 * 1024 ? 1 : 0)} KB`;
}

const readWords: Record<string, string> = {
  embed: "embedded in its Task",
  memory: "its Memory",
  note_get: "note_get",
  file_fetch: "file_fetch",
  record_list: "record_list",
  record_search: "record_search",
  script: "ran it",
};

/** How an agent read an item, in words. */
export function readHow(how: string): string {
  return readWords[how] ?? how;
}

/** Where a history entry opens: its run step, or the coach message it came from. */
export function linkLabel(link: StateLink | null, sessionId: string): string | null {
  if (!link) return null;
  if (link.kind === "run") return "Open step";
  return link.session_id === sessionId
    ? `Coach message #${link.seq}`
    : "Coach message in another session";
}
