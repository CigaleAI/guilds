import { jsonObj } from "../db/json.js";

export const CONTEXT_HISTORY_LIMIT = 10;
export const HISTORY_CANDIDATE_LIMIT = 40;

export function storedTags(row: Record<string, unknown>): string[] {
  const tagged = jsonObj(row.tagged_names);
  if (!Array.isArray(tagged)) {
    return [];
  }
  return tagged.filter((item): item is string => typeof item === "string");
}

function historyItem(row: Record<string, unknown>): {
  sentBy: string;
  content: unknown;
  tagged: string[];
} {
  const sentBy = String(row.author_name || (row.author_type === "user" ? "user" : "agent"));
  return {
    sentBy,
    content: row.content,
    tagged: storedTags(row),
  };
}

export function recentGroupRows(
  rows: Array<Record<string, unknown>>,
  limit = CONTEXT_HISTORY_LIMIT,
): Array<Record<string, unknown>> {
  if (limit < 1) {
    return [];
  }
  return rows.slice(-limit);
}

export function historyStateItem(row: Record<string, unknown>): {
  seq: number;
  sentBy: string;
  content: unknown;
  tagged: string[];
} {
  return {
    seq: Number(row.seq),
    ...historyItem(row),
  };
}

export function groupChatHistory(
  rows: Array<Record<string, unknown>>,
  options: { limit?: number | null } = {},
): Array<{ sentBy: string; content: unknown; tagged: string[] }> {
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
