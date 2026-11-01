import type { GroupMessageRow } from "../db/group-chat.js";

export const CONTEXT_HISTORY_LIMIT = 10;
export const HISTORY_CANDIDATE_LIMIT = 40;

/** A public message as a run's history reads it: who wrote it, its text, and the names it tags. */
export type HistoryMessage = Pick<GroupMessageRow, "author_type" | "author_name" | "content" | "tagged_names">;

/** A public message in a run's history: who sent it, its text, and the names it tags. */
export type GroupHistoryItem = { sentBy: string; content: string; tagged: string[] };

/** A history item with the seq its message sits at. */
export type GroupHistoryStateItem = GroupHistoryItem & { seq: number };

/** The names a public message tags, as it stores them. */
export function storedTags(row: Pick<GroupMessageRow, "tagged_names">): string[] {
  return row.tagged_names;
}

function historyItem(row: HistoryMessage): GroupHistoryItem {
  return {
    sentBy: row.author_name || row.author_type,
    content: row.content,
    tagged: row.tagged_names,
  };
}

export function recentGroupRows<R>(rows: R[], limit = CONTEXT_HISTORY_LIMIT): R[] {
  if (limit < 1) {
    return [];
  }
  return rows.slice(-limit);
}

export function historyStateItem(row: HistoryMessage & Pick<GroupMessageRow, "seq">): GroupHistoryStateItem {
  return {
    seq: row.seq,
    ...historyItem(row),
  };
}

export function groupChatHistory(
  rows: HistoryMessage[],
  options: { limit?: number | null } = {},
): GroupHistoryItem[] {
  const items = rows.map(historyItem);
  const limit = options.limit;
  if (limit === undefined || limit === null) {
    return items;
  }
  if (limit < 1) {
    return [];
  }
  return items.slice(-limit);
}
