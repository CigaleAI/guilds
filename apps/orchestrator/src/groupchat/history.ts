import type { GroupMessageRow } from "../db/group-chat.js";

export const CONTEXT_HISTORY_LIMIT = 10;
export const HISTORY_CANDIDATE_LIMIT = 40;
export const REPLY_CONTEXT_RADIUS = 2;

/** A public message as a run's history reads it: its seq, who wrote it, its text, its tags, and what it replies to. */
export type HistoryMessage = Pick<
  GroupMessageRow,
  "seq" | "author_type" | "author_name" | "content" | "tagged_names"
> &
  Partial<Pick<GroupMessageRow, "reply_to_seq">>;

/** A public message in a run's history: its seq, who sent it, its text, its tags, and the seq it replies to when it is a reply. */
export type GroupHistoryItem = {
  seq: number;
  sentBy: string;
  content: string;
  tagged: string[];
  replyToSeq?: number;
};

/** A history item with the seq its message sits at. */
export type GroupHistoryStateItem = GroupHistoryItem;

/** A row with a sequence number and optional reply pointer. */
export type SequencedReplyRow = Pick<GroupMessageRow, "seq"> & Partial<Pick<GroupMessageRow, "reply_to_seq">>;

/** The names a public message tags, as it stores them. */
export function storedTags(row: Pick<GroupMessageRow, "tagged_names">): string[] {
  return row.tagged_names;
}

export function historyItem(row: HistoryMessage): GroupHistoryItem {
  const item: GroupHistoryItem = {
    seq: Number(row.seq),
    sentBy: row.author_name || row.author_type,
    content: row.content,
    tagged: row.tagged_names,
  };
  if (row.reply_to_seq !== null && row.reply_to_seq !== undefined) {
    item.replyToSeq = Number(row.reply_to_seq);
  }
  return item;
}

export function recentGroupRows<R>(rows: readonly R[], limit = CONTEXT_HISTORY_LIMIT): R[] {
  if (limit < 1) {
    return [];
  }
  return rows.slice(-limit);
}

/**
 * The sequence numbers of messages that unseen rows reply to, newest reply first; when
 * `deliveredThrough` is omitted, checks only the latest row.
 */
export function replyTargetSeqs(rows: readonly SequencedReplyRow[], deliveredThrough?: number): number[] {
  const active =
    deliveredThrough === undefined ? rows.slice(-1) : rows.filter((row) => Number(row.seq) > deliveredThrough);
  const seen = new Set<number>();
  const targets: number[] = [];
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const target = active[index]?.reply_to_seq;
    if (target !== null && target !== undefined && !seen.has(Number(target))) {
      const seq = Number(target);
      seen.add(seq);
      targets.push(seq);
    }
  }
  return targets;
}

/** The message at `targetSeq` together with up to `radius` messages before and after it. */
export function surroundingRows<R extends Pick<GroupMessageRow, "seq">>(
  rows: readonly R[],
  targetSeq: number,
  radius = REPLY_CONTEXT_RADIUS,
): R[] {
  const at = rows.findIndex((row) => Number(row.seq) === Number(targetSeq));
  if (at < 0) {
    return [];
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(rows.length, at + radius + 1);
  return rows.slice(start, end);
}

function replyContextSeqs(rows: readonly SequencedReplyRow[], deliveredThrough?: number): Set<number> {
  const kept = new Set<number>();
  for (const targetSeq of replyTargetSeqs(rows, deliveredThrough)) {
    for (const row of surroundingRows(rows, targetSeq)) {
      kept.add(Number(row.seq));
    }
  }
  return kept;
}

/**
 * The candidate rows for history selection: the `±2` window around each active reply target
 * merged in sequence order with the last `HISTORY_CANDIDATE_LIMIT` rows.
 */
export function historyCandidateRows<R extends SequencedReplyRow>(
  rows: readonly R[],
  deliveredThrough?: number,
): R[] {
  const kept = replyContextSeqs(rows, deliveredThrough);
  for (const row of recentGroupRows(rows, HISTORY_CANDIDATE_LIMIT)) {
    kept.add(Number(row.seq));
  }
  return rows.filter((row) => kept.has(Number(row.seq)));
}

/**
 * The history rows kept without Jev: the latest row, the `±2` window around active reply targets,
 * and the newest remaining rows up to `limit`, in sequence order.
 */
export function defaultHistoryRows<R extends SequencedReplyRow>(
  rows: readonly R[],
  deliveredThrough?: number,
  limit = CONTEXT_HISTORY_LIMIT,
): R[] {
  if (limit < 1 || !rows.length) {
    return [];
  }
  const reversed = [...rows].reverse().map((row) => Number(row.seq));
  const priority = [reversed[0], ...replyContextSeqs(rows, deliveredThrough), ...reversed];
  const kept = new Set<number>();
  for (const seq of priority) {
    if (seq !== undefined && kept.size < limit) {
      kept.add(seq);
    }
  }
  return rows.filter((row) => kept.has(Number(row.seq)));
}

export function historyStateItem(row: HistoryMessage): GroupHistoryStateItem {
  return historyItem(row);
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
